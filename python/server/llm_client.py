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
"""

from __future__ import annotations

import abc
import asyncio
import random
from typing import Optional

from summarization.config import settings
from summarization.exceptions import ConfigurationError, SummarizationError

from logger import get_logger

logger = get_logger(__name__)


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
