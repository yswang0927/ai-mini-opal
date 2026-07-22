"""
端到端摘要服务，串联既有阶段：

    第一/二步（app.pipeline.SummarizationPreprocessor）：流式估算 token、按需分块
    第三步（app.summarization.map_reduce.MapReduceSummarizer 或
           app.summarization.refine.RefineSummarizer）：归约为最终摘要

这是 FastAPI 路由层应直接依赖的最终入口，屏蔽掉下层分块策略/归约策略/LLM 客户端
的实现细节。Map-Reduce 与 Refine 二选一，由传入的 summarizer 实例类型决定，
调用方无需关心 SummarizationResult 内部字段该填哪一个。
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Union

from .config import ChunkingStrategy, SummarizationStrategy, TaskType
from .exceptions import ConfigurationError
from .pipeline import SummarizationPreprocessor
from .schemas import MapReduceResult, RefineResult, SummarizationResult
from .map_reduce import MapReduceSummarizer
from .refine import RefineSummarizer

_Summarizer = Union[MapReduceSummarizer, RefineSummarizer]


class SummarizationService:
    def __init__(
        self,
        preprocessor: SummarizationPreprocessor,
        summarizer: _Summarizer,
    ):
        self.preprocessor = preprocessor
        self.summarizer = summarizer

    async def summarize(
        self,
        file_path: str | Path,
        strategy: Optional[ChunkingStrategy] = None,
        task_type: Optional[TaskType] = None,
    ) -> SummarizationResult:
        task_type = task_type or self.preprocessor.default_task_type

        chunking_result = self.preprocessor.process(file_path, strategy=strategy, task_type=task_type)
        reduce_result = await self.summarizer.run(chunking_result.chunks, task_type=task_type)

        if isinstance(reduce_result, MapReduceResult):
            return SummarizationResult(
                chunking=chunking_result,
                strategy=SummarizationStrategy.MAP_REDUCE,
                map_reduce=reduce_result,
            )
        if isinstance(reduce_result, RefineResult):
            return SummarizationResult(
                chunking=chunking_result,
                strategy=SummarizationStrategy.REFINE,
                refine=reduce_result,
            )
        raise ConfigurationError(f"未知的归约结果类型: {type(reduce_result)}")  # 防御性分支，理论不可达
