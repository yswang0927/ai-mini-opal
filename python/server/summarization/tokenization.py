"""
流式 Token 长度估算 —— 处理长文本摘要的"第一步"。

核心诉求：
1. 不能把整篇文档拼接成一个大字符串再编码（几百 MB 文本会导致内存峰值爆炸，
   且 tiktoken 编码大字符串本身也有较高的 CPU/内存开销）。
2. 因此采用"滚动结转窗口"（carry window）逐块编码：
   - 每次将【上一块末尾保留的少量字符】与【新读入的文本块】拼接后编码；
   - 减去"仅结转部分单独编码"的 token 数，得到本块新增的 token 数；
   - 这样可以避免因为分块边界恰好切在单词/子词中间，导致 token 数被错误地
     多算或少算（tiktoken 的 BPE 分词对边界字符敏感）。
   - 该方法是"近似"而非逐字节精确等价于整篇编码，但误差通常在很小范围内
     （每个边界最多引入 1-2 个 token 的误差），对于"是否超过上下文窗口"
     这类阈值判断而言完全足够；如需绝对精确，需要以内存换精度，一次性编码。
3. 支持"提前终止"：当运行总数已经明显超过可用上下文窗口时，无需继续扫描
   整份文档（对判断"要不要分块"这件事而言已经有了确定性结论），
   直接返回 exceeds_limit=True 且标记 is_estimate_truncated=True，
   为超大文档节省大量 CPU 时间。
"""

from __future__ import annotations

import os
from typing import Iterable, Optional

# tiktoken 首次加载某个 encoding 时会从 openaipublic 下载 .tiktoken 词表并缓存。
# Electron 打包后在局域网/离线环境无法访问外网,因此把 cl100k_base 词表随包内置到
# 本目录下的 tiktoken_cache/,并在导入 tiktoken 之前把 TIKTOKEN_CACHE_DIR 指向它。
# tiktoken 用「下载 URL 的 SHA1」作为缓存文件名,vendored 文件名必须与之一致
# (见 tiktoken_cache/README)。仅在用户未显式设置该变量时才覆盖,保留外部定制能力。
_VENDORED_TIKTOKEN_CACHE = os.path.join(os.path.dirname(__file__), "tiktoken_cache")
if not os.environ.get("TIKTOKEN_CACHE_DIR") and os.path.isdir(_VENDORED_TIKTOKEN_CACHE):
    os.environ["TIKTOKEN_CACHE_DIR"] = _VENDORED_TIKTOKEN_CACHE

import tiktoken

from .config import settings
from .exceptions import TokenEstimationError
from .schemas import TokenEstimateResult
from logger import get_logger

logger = get_logger(__name__)

# token 估算统一使用 cl100k_base 编码。它对绝大多数现代 LLM 的 token 数量级估算
# 已足够接近，而"是否超过上下文窗口"这类阈值判断本就只需要量级正确即可，
# 因此无需按模型名切换编码器（也就不必再向本模块传递 model_name）。
_DEFAULT_ENCODING = "cl100k_base"


class StreamingTokenEstimator:
    def __init__(
        self,
        max_context_tokens: Optional[int] = None,
    ):
        # 最大上下文窗口由调用方显式传入（现场定制），未指定时回退到配置默认值。
        self.max_context_tokens = max_context_tokens or settings.default_max_context_tokens
        self._encoding = self._load_encoding_with_fallback(_DEFAULT_ENCODING)

    @staticmethod
    def _load_encoding_with_fallback(encoding_name: str):
        """加载 tiktoken 编码器。首次使用某个 encoding 时 tiktoken 需要从远端下载
        词表文件并本地缓存；生产环境应预先在构建镜像阶段 `python -c "import tiktoken;
        tiktoken.get_encoding(...)"` 把缓存打进镜像，避免运行时依赖外网。这里额外做了
        一层兜底：若目标 encoding 加载失败（网络受限等），自动降级到更通用的
        cl100k_base，保证服务在离线/内网环境下依然可用（token 数量级估算基本不受影响）。
        """
        try:
            return tiktoken.get_encoding(encoding_name)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "加载 tiktoken 编码器 '%s' 失败 (%s)，尝试降级到 '%s'。",
                encoding_name,
                exc,
                _DEFAULT_ENCODING,
            )
            if encoding_name == _DEFAULT_ENCODING:
                raise TokenEstimationError(
                    f"加载 tiktoken 编码器失败 (encoding={encoding_name})，"
                    f"且无更低级别的兜底编码可用，请检查网络或本地缓存。"
                ) from exc
            try:
                return tiktoken.get_encoding(_DEFAULT_ENCODING)
            except Exception as fallback_exc:  # noqa: BLE001
                raise TokenEstimationError(
                    f"加载 tiktoken 编码器失败，主编码 '{encoding_name}' 与"
                    f"兜底编码 '{_DEFAULT_ENCODING}' 均不可用，请检查网络或本地缓存。"
                ) from fallback_exc

    def count_tokens(self, text: str) -> int:
        """对单个（较短的）文本片段做精确计数，供 Chunk 级别使用。"""
        return len(self._encoding.encode(text, disallowed_special=()))

    def encode(self, text: str) -> list[int]:
        return self._encoding.encode(text, disallowed_special=())

    def decode(self, tokens: list[int]) -> str:
        return self._encoding.decode(tokens)


    def estimate_from_stream(
        self,
        text_iterator: Iterable[str],
        early_exit_multiplier: float = 1.5,
    ) -> TokenEstimateResult:
        """
        流式估算文档总 token 数。

        Args:
            text_iterator: 逐块产出文本的可迭代对象（通常来自 Reader.iter_text()）。
            early_exit_multiplier: 当累计 token 数超过「可用上下文窗口 * 该倍数」时提前终止，
                避免对已确定需要分块的超大文档做无意义的全量扫描。
        """
        usable_tokens = settings.usable_context_tokens(self.max_context_tokens)
        context_window = self.max_context_tokens
        early_exit_threshold = int(usable_tokens * early_exit_multiplier)

        total_tokens = 0
        carry = ""
        carry_chars = settings.token_estimation_carry_chars
        truncated = False

        for block in text_iterator:
            if not block:
                continue
            combined = carry + block
            combined_tokens = len(self._encoding.encode(combined, disallowed_special=()))
            carry_tokens = len(self._encoding.encode(carry, disallowed_special=())) if carry else 0
            new_tokens = max(combined_tokens - carry_tokens, 0)
            total_tokens += new_tokens

            # 结转窗口：保留本块末尾若干字符，供下一块拼接时消除边界误差
            carry = combined[-carry_chars:] if len(combined) > carry_chars else combined

            if total_tokens >= early_exit_threshold:
                truncated = True
                logger.info(
                    "文档 token 数早已超过安全阈值 (%d >= %d)，提前终止扫描以节省资源。",
                    total_tokens,
                    early_exit_threshold,
                )
                break

        exceeds_limit = total_tokens > usable_tokens
        return TokenEstimateResult(
            total_tokens=total_tokens,
            context_window=context_window,
            usable_context_tokens=usable_tokens,
            exceeds_limit=exceeds_limit or truncated,
            is_estimate_truncated=truncated,
        )
