"""
LLM 调用客户端抽象层。

Map-Reduce 归约链路需要反复调用 LLM（每个分块一次 Map 调用，每一层归约多次
Reduce 调用），生产环境必须处理：
    - 瞬时性失败（限流 429、网络超时）的指数退避重试；
    - 与具体 LLM 供应商解耦（今天用 Claude，明天可能换 GPT-4o 或自建模型）。

因此这里定义一个最小化的 `LLMClient` 接口，业务代码（map_reduce.py）只依赖
这个接口，不关心底层是 langchain 的哪个 ChatModel。生产环境通过
`LangChainChatModelClient` 包装任意 `langchain_core.language_models.BaseChatModel`
实例接入（ChatAnthropic / ChatOpenAI / 自建兼容模型均可）。

本项目默认接入方式：读取 .env 中的 OpenAI 兼容网关配置
（OPIE_LLM_BASE_URL / OPIE_LLM_API_KEY / OPIE_LLM_MODEL），通过 `ChatOpenAI`
指向该网关（与 server.py 的接入方式一致），适用于 deepseek / qwen 等自建或
第三方 OpenAI 兼容服务。调用 `build_opie_llm_client()` 即可获得可直接用于
Map-Reduce / Refine 归约链路的、带重试的 LLMClient 实例。
"""

from __future__ import annotations

import abc
import asyncio
import os
import random
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

from summarization.config import settings
from summarization.exceptions import ConfigurationError, SummarizationError
from logger import get_logger

logger = get_logger(__name__)

# 与 server.py 保持一致：从与本文件同目录的 .env 加载 OPIE_LLM_* 等配置。
# load_dotenv 默认不会覆盖已存在的环境变量，因此进程中已显式导出的值优先级更高。
load_dotenv(Path(__file__).parent / ".env")


class LLMClient(abc.ABC):
    """业务代码依赖的最小 LLM 调用接口。"""

    @abc.abstractmethod
    async def complete(self, prompt: str) -> str:
        """给定完整 prompt（含 system/user 指令），返回模型生成的文本。"""
        raise NotImplementedError


class RetryingLLMClient(LLMClient):
    """在任意 LLMClient 实现之上叠加统一的指数退避重试逻辑（装饰器模式）。"""

    def __init__(
        self,
        inner: LLMClient,
        max_retries: Optional[int] = None,
        base_delay_seconds: Optional[float] = None,
    ):
        self.inner = inner
        self.max_retries = max_retries if max_retries is not None else settings.llm_max_retries
        self.base_delay_seconds = (
            base_delay_seconds if base_delay_seconds is not None else settings.llm_retry_base_delay_seconds
        )

    async def complete(self, prompt: str) -> str:
        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                return await self.inner.complete(prompt)
            except Exception as exc:  # noqa: BLE001 底层可能抛出供应商特定异常类型
                last_exc = exc
                if attempt >= self.max_retries:
                    break
                # 指数退避 + 抖动，避免大批量并发请求同时重试造成"重试风暴"
                delay = self.base_delay_seconds * (2 ** attempt) + random.uniform(0, 0.5)
                logger.warning(
                    "LLM 调用失败（第 %d/%d 次尝试），%.1fs 后重试: %s",
                    attempt + 1,
                    self.max_retries + 1,
                    delay,
                    exc,
                )
                await asyncio.sleep(delay)

        raise SummarizationError(f"LLM 调用在重试 {self.max_retries} 次后仍失败") from last_exc


class LangChainChatModelClient(LLMClient):
    """将任意 langchain BaseChatModel 适配为 LLMClient。

    使用方式:
        from langchain_anthropic import ChatAnthropic
        model = ChatAnthropic(model="claude-sonnet-5")
        client = LangChainChatModelClient(model)
    """

    def __init__(self, chat_model):
        self.chat_model = chat_model

    async def complete(self, prompt: str) -> str:
        response = await self.chat_model.ainvoke(prompt)
        # langchain 的 BaseChatModel.ainvoke 返回 AIMessage，content 一般是 str，
        # 但部分供应商（如工具调用场景）可能返回内容块列表，这里统一兜底处理。
        content = getattr(response, "content", response)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                block.get("text", "") if isinstance(block, dict) else str(block) for block in content
            )
        return str(content)


class FakeLLMClient(LLMClient):
    """用于单元测试/离线演示的确定性伪 LLM：不依赖网络与真实模型。

    默认行为：截断输入并加上前缀，模拟"摘要变短"的效果，保证 map-reduce
    的编排逻辑（并发、重试、分层归约、异常处理）可以在没有真实 API Key 的
    情况下被完整测试。
    """

    def __init__(self, summary_ratio: float = 0.3, prefix: str = "[摘要] "):
        self.summary_ratio = summary_ratio
        self.prefix = prefix
        self.call_count = 0

    async def complete(self, prompt: str) -> str:
        self.call_count += 1
        await asyncio.sleep(0)  # 保持协程语义，便于测试并发调度
        # 简单启发式：从 prompt 中截取正文部分并按比例缩短，模拟真实摘要行为
        body = prompt.strip()
        target_len = max(int(len(body) * self.summary_ratio), 20)
        return f"{self.prefix}{body[:target_len]}"


def build_opie_llm_client(
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    temperature: float = 0.3,
    max_retries: Optional[int] = None,
    **chat_model_kwargs,
) -> LLMClient:
    """按本项目 .env 中的 OpenAI 兼容网关配置构建带重试的 LLMClient。

    读取顺序（base_url / api_key 可被显式入参覆盖，模型名固定取 OPIE_LLM_MODEL）：
        base_url  <- OPIE_LLM_BASE_URL
        api_key   <- OPIE_LLM_API_KEY
        model     <- OPIE_LLM_MODEL

    这与 server.py._build_llm() 的接入方式一致，适用于 deepseek / qwen 等
    自建或第三方 OpenAI 兼容服务。摘要归约任务偏向"忠实、低发散"，因此默认
    temperature 取较低值 0.3（可通过入参调整）。

    Returns:
        已包装 RetryingLLMClient 的实例，可直接传给 MapReduceSummarizer /
        RefineSummarizer。
    """
    resolved_base_url = base_url or os.environ.get("OPIE_LLM_BASE_URL", "")
    resolved_api_key = api_key or os.environ.get("OPIE_LLM_API_KEY", "")
    resolved_model = os.environ.get("OPIE_LLM_MODEL", "")

    missing = [
        name
        for name, value in (
            ("OPIE_LLM_BASE_URL", resolved_base_url),
            ("OPIE_LLM_API_KEY", resolved_api_key),
            ("OPIE_LLM_MODEL", resolved_model),
        )
        if not value
    ]
    if missing:
        raise ConfigurationError(
            f"缺少 LLM 连接配置: {', '.join(missing)}。"
            f"请在 {Path(__file__).parent / '.env'} 中设置，或作为参数显式传入。"
        )

    try:
        from langchain_openai import ChatOpenAI
    except ImportError as exc:
        raise ConfigurationError(
            "缺少 langchain_openai 依赖，无法构建 OpenAI 兼容客户端，请先安装 langchain-openai。"
        ) from exc

    chat_model = ChatOpenAI(
        base_url=resolved_base_url,
        api_key=resolved_api_key,
        model=resolved_model,
        temperature=temperature,
        use_responses_api=False,
        **chat_model_kwargs,
    )
    logger.info("已构建 OPIE LLM 客户端: base_url=%s model=%s", resolved_base_url, resolved_model)
    return RetryingLLMClient(LangChainChatModelClient(chat_model), max_retries=max_retries)


def build_default_llm_client(model_name: str) -> LLMClient:
    """按模型名快速构建生产环境可用的 LLMClient（自动包装重试逻辑）。

    约定：模型名以 "claude" 开头走 Anthropic，以 "gpt"/"o1"/"o3" 开头走 OpenAI，
    两者均需要在环境变量中配置对应的 API Key（ANTHROPIC_API_KEY / OPENAI_API_KEY），
    这由各自的 langchain 集成包自行读取，本函数不经手密钥。
    如需接入其它供应商或自建模型，直接构造 `LangChainChatModelClient(your_chat_model)`
    并传给 MapReduceSummarizer 即可，无需修改本函数。
    """
    lowered = model_name.lower()
    try:
        if lowered.startswith("claude"):
            from langchain_anthropic import ChatAnthropic

            chat_model = ChatAnthropic(model=model_name)
        elif lowered.startswith(("gpt", "o1", "o3", "o4")):
            from langchain_openai import ChatOpenAI

            chat_model = ChatOpenAI(model=model_name)
        else:
            raise ConfigurationError(
                f"无法根据模型名 '{model_name}' 自动推断供应商，"
                f"请显式构造 LangChainChatModelClient 并传入对应的 chat_model。"
            )
    except ImportError as exc:
        raise ConfigurationError(
            f"缺少模型 '{model_name}' 所需的 langchain 集成包，请安装后重试"
        ) from exc

    return RetryingLLMClient(LangChainChatModelClient(chat_model))
