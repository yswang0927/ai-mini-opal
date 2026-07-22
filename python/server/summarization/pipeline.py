"""
摘要预处理主流水线。

对外暴露单一入口 `SummarizationPreprocessor.process()`，内部编排：
    第一步：流式估算文档 token 长度，判断是否超过 LLM 上下文窗口；
    第二步：若超限，按选定策略（语义/逻辑/任务驱动）分块，并叠加重叠。

"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from langchain_core.embeddings import Embeddings

from summarization.chunking.factory import ChunkerFactory
from .config import ChunkingStrategy, TaskType, settings
from .exceptions import PreprocessorError
from summarization.readers.factory import ReaderFactory
from .schemas import Chunk, ChunkingResult, ChunkMetadata, TokenEstimateResult
from .tokenization import StreamingTokenEstimator

from logger import get_logger

logger = get_logger(__name__)


class SummarizationPreprocessor:
    def __init__(
        self,
        model_name: Optional[str] = None,
        default_strategy: ChunkingStrategy = ChunkingStrategy.LOGICAL,
        default_task_type: TaskType = TaskType.SUMMARIZATION,
        embeddings: Optional[Embeddings] = None,
    ):
        self.model_name = model_name or settings.default_model_name
        self.default_strategy = default_strategy
        self.default_task_type = default_task_type
        self.embeddings = embeddings
        self.token_estimator = StreamingTokenEstimator(model_name=self.model_name)

    def process(
        self,
        file_path: str | Path,
        strategy: Optional[ChunkingStrategy] = None,
        task_type: Optional[TaskType] = None,
    ) -> ChunkingResult:
        strategy = strategy or self.default_strategy
        task_type = task_type or self.default_task_type

        try:
            reader = ReaderFactory.get_reader(file_path)
            source_format = ReaderFactory.detect_format(file_path)
        except Exception as exc:
            logger.exception("初始化文档读取器失败: %s", file_path)
            raise PreprocessorError(f"无法读取文档: {file_path}") from exc

        # ---------- 第一步：流式估算 token 长度 ----------
        token_estimate = self._estimate_tokens(reader)

        if not token_estimate.exceeds_limit:
            logger.info(
                "文档 token 数 (%d) 未超过可用上下文窗口 (%d)，无需分块。",
                token_estimate.total_tokens,
                token_estimate.usable_context_tokens,
            )
            full_text = "\n\n".join(reader.iter_text())
            single_chunk = Chunk(
                content=full_text,
                metadata=ChunkMetadata(
                    chunk_index=0,
                    source_format=source_format,
                    strategy_used=strategy,
                    token_count=token_estimate.total_tokens,
                    char_count=len(full_text),
                    logical_unit_type="full_document",
                    has_overlap_prefix=False,
                    overlap_token_count=0,
                ),
            )
            return ChunkingResult(
                chunks=[single_chunk],
                total_chunks=1,
                strategy=strategy,
                task_type=task_type,
                token_estimate=token_estimate,
            )

        # ---------- 第二步：分块 ----------
        logger.info(
            "文档 token 数 (%d) 超过可用上下文窗口 (%d)，执行 %s 分块策略 (task=%s)。",
            token_estimate.total_tokens,
            token_estimate.usable_context_tokens,
            strategy,
            task_type,
        )
        chunks = ChunkerFactory.run(
            reader=reader,
            source_format=source_format,
            strategy=strategy,
            task_type=task_type,
            model_name=self.model_name,
            token_estimator=self.token_estimator,
            embeddings=self.embeddings,
        )
        return ChunkingResult(
            chunks=chunks,
            total_chunks=len(chunks),
            strategy=strategy,
            task_type=task_type,
            token_estimate=token_estimate,
        )

    def _estimate_tokens(self, reader) -> TokenEstimateResult:
        return self.token_estimator.estimate_from_stream(reader.iter_text())
