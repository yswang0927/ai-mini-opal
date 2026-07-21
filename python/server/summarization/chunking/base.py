"""分块策略的抽象接口。所有具体策略只负责产出「原始分块」（不含重叠），
重叠由 OverlapManager 在 ChunkerFactory 中统一叠加，保证重叠机制与策略解耦、
可独立配置、可对任意策略生效。
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import List, Optional

from summarization.readers.base import BaseStreamingReader
from summarization.tokenization import StreamingTokenEstimator


@dataclass
class RawChunk:
    """分块策略的中间产出：尚未叠加重叠、但已确定边界的一个块。"""

    text: str
    token_count: int
    logical_unit_type: Optional[str] = None
    extra: dict = field(default_factory=dict)


class BaseChunker(abc.ABC):
    def __init__(self, token_estimator: StreamingTokenEstimator, max_chunk_tokens: int):
        self.token_estimator = token_estimator
        self.max_chunk_tokens = max_chunk_tokens

    @abc.abstractmethod
    def chunk(self, reader: BaseStreamingReader) -> List[RawChunk]:
        """执行分块，返回按原文顺序排列的 RawChunk 列表。"""
        raise NotImplementedError

    def _count(self, text: str) -> int:
        return self.token_estimator.count_tokens(text)
