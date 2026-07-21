"""
块重叠机制 (Chunk Overlap)。

设计为「策略无关」的后处理步骤：无论上游使用语义分块、逻辑单元分块，
最终都会经过 OverlapManager 统一叠加重叠内容，具体实现为：

    对第 i 个块（i > 0），从第 i-1 个块的【token 序列末尾】截取
    overlap_tokens 个 token，解码回文本后拼接到第 i 个块的开头。

使用 token 级别（而非字符/单词级别）的重叠截取，是因为：
- token 数量与 LLM 实际消耗的上下文成本直接对应，按 token 数截取重叠
  可以精确控制重叠部分带来的额外开销；
- 避免了按字符截取可能切断多字节字符、按单词截取在中文等无空格分隔
  语言中难以泛化的问题（tiktoken 的 encode/decode 对任意语言一致有效）。
"""

from __future__ import annotations

from typing import List

from ..config import ChunkingStrategy, DocumentFormat, TaskType
from ..chunking.base import RawChunk
from ..schemas import Chunk, ChunkMetadata
from ..tokenization import StreamingTokenEstimator

from logger import get_logger

logger = get_logger(__name__)


class OverlapManager:
    def __init__(self, token_estimator: StreamingTokenEstimator, overlap_tokens: int):
        self.token_estimator = token_estimator
        self.overlap_tokens = max(overlap_tokens, 0)

    def apply(
        self,
        raw_chunks: List[RawChunk],
        strategy: ChunkingStrategy,
        source_format: DocumentFormat,
    ) -> List[Chunk]:
        if not raw_chunks:
            return []

        result: List[Chunk] = []
        for idx, raw in enumerate(raw_chunks):
            content = raw.text
            has_overlap = False
            actual_overlap_tokens = 0

            if idx > 0 and self.overlap_tokens > 0:
                prev_tokens = self.token_estimator.encode(raw_chunks[idx - 1].text)
                take = min(self.overlap_tokens, len(prev_tokens))
                if take > 0:
                    overlap_text = self.token_estimator.decode(prev_tokens[-take:])
                    content = f"{overlap_text}\n{content}"
                    has_overlap = True
                    actual_overlap_tokens = take

            token_count = self.token_estimator.count_tokens(content)
            result.append(
                Chunk(
                    content=content,
                    metadata=ChunkMetadata(
                        chunk_index=idx,
                        source_format=source_format,
                        strategy_used=strategy,
                        token_count=token_count,
                        char_count=len(content),
                        logical_unit_type=raw.logical_unit_type,
                        has_overlap_prefix=has_overlap,
                        overlap_token_count=actual_overlap_tokens,
                    ),
                )
            )
        return result
