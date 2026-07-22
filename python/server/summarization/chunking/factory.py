"""
分块策略工厂。

三种"分块策略"与"重叠机制"之间的关系说明（这里做一个明确的架构澄清，
避免把 Task-Dependent Sizing 误解为与语义/逻辑分块并列的第三种独立切分算法）：

    - 语义分块 / 逻辑单元分块 —— 回答"块的边界切在哪里"；
    - 任务目标尺寸调整 (Task-Dependent Sizing) —— 回答"块应该多大、重叠多少"，
      它作为参数注入前两种"边界策略"，而不是第三种边界算法；
    - 块重叠机制 —— 是在最终产出的块序列之上统一叠加的后处理步骤，
      对任意边界策略都生效。

因此 ChunkingStrategy 枚举中的三个取值实际编排为：
    - SEMANTIC          -> 语义分块 + 任务驱动尺寸 + 重叠
    - LOGICAL           -> 逻辑单元分块 + 任务驱动尺寸 + 重叠
    - TASK_DEPENDENT    -> 逻辑单元分块 + 任务驱动尺寸（作为默认/显式选择时的别名）+ 重叠
      （如需"语义分块 + 任务驱动尺寸"的组合，直接选择 SEMANTIC 即可，
      因为任务驱动尺寸对两者都是必经步骤。）
"""

from __future__ import annotations

from typing import List, Optional

from langchain_core.embeddings import Embeddings

from summarization.config import ChunkingStrategy, DocumentFormat, TaskType
from summarization.readers.base import BaseStreamingReader
from summarization.schemas import Chunk
from summarization.tokenization import StreamingTokenEstimator
from .base import BaseChunker
from .logical_chunker import LogicalUnitChunker
from .overlap import OverlapManager
from .semantic_chunker import SemanticUnitChunker
from .task_sizer import TaskDependentSizer

from logger import get_logger

logger = get_logger(__name__)


class ChunkerFactory:
    @staticmethod
    def build_chunker(
        strategy: ChunkingStrategy,
        task_type: TaskType,
        max_context_tokens: int,
        token_estimator: StreamingTokenEstimator,
        embeddings: Optional[Embeddings] = None,
    ) -> tuple[BaseChunker, OverlapManager]:
        sizing = TaskDependentSizer.compute(task_type=task_type, max_context_tokens=max_context_tokens)

        if strategy == ChunkingStrategy.SEMANTIC:
            chunker: BaseChunker = SemanticUnitChunker(
                token_estimator=token_estimator,
                max_chunk_tokens=sizing.chunk_size_tokens,
                embeddings=embeddings,
            )
        elif strategy in (ChunkingStrategy.LOGICAL, ChunkingStrategy.TASK_DEPENDENT):
            chunker = LogicalUnitChunker(
                token_estimator=token_estimator,
                max_chunk_tokens=sizing.chunk_size_tokens,
            )
        else:
            raise ValueError(f"未知分块策略: {strategy}")

        overlap_manager = OverlapManager(
            token_estimator=token_estimator,
            overlap_tokens=sizing.overlap_tokens,
        )
        logger.info(
            "构建分块器: strategy=%s task=%s chunk_size_tokens=%d overlap_tokens=%d",
            strategy,
            task_type,
            sizing.chunk_size_tokens,
            sizing.overlap_tokens,
        )
        return chunker, overlap_manager

    @staticmethod
    def run(
        reader: BaseStreamingReader,
        source_format: DocumentFormat,
        strategy: ChunkingStrategy,
        task_type: TaskType,
        max_context_tokens: int,
        token_estimator: StreamingTokenEstimator,
        embeddings: Optional[Embeddings] = None,
    ) -> List[Chunk]:
        chunker, overlap_manager = ChunkerFactory.build_chunker(
            strategy=strategy,
            task_type=task_type,
            max_context_tokens=max_context_tokens,
            token_estimator=token_estimator,
            embeddings=embeddings,
        )
        raw_chunks = chunker.chunk(reader)
        return overlap_manager.apply(raw_chunks, strategy=strategy, source_format=source_format)
