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

import os
from pathlib import Path
from typing import Optional, Union

from langchain_core.embeddings import Embeddings

from .config import ChunkingStrategy, SummarizationStrategy, TaskType, settings
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


def _resolve_max_context_tokens(explicit: Optional[int]) -> int:
    """确定最大上下文窗口（token）。优先级：显式入参 > 环境变量
    OPIE_LLM_MAX_CONTEXT_TOKENS（见 .env）> settings 默认值。
    """
    if explicit is not None:
        return explicit
    env_value = os.environ.get("OPIE_LLM_MAX_CONTEXT_TOKENS", "").strip()
    if env_value:
        try:
            return int(env_value)
        except ValueError as exc:
            raise ConfigurationError(
                f"环境变量 OPIE_LLM_MAX_CONTEXT_TOKENS 不是合法整数: {env_value!r}"
            ) from exc
    return settings.default_max_context_tokens


async def summarize_document(
    file_path: str | Path,
    strategy: ChunkingStrategy = ChunkingStrategy.LOGICAL,
    task_type: TaskType = TaskType.SUMMARIZATION,
    summarization_strategy: SummarizationStrategy = SummarizationStrategy.MAP_REDUCE,
    max_context_tokens: Optional[int] = None,
    embeddings: Optional[Embeddings] = None,
) -> SummarizationResult:
    """端到端接口：上传文档 ->（估算 + 分块）-> 归约（Map-Reduce 或 Refine）-> 最终摘要。

    Args:
        file_path: 文档路径（支持 txt / markdown / docx / pptx / pdf）。
        strategy: 分块策略。
            - LOGICAL: 按逻辑单元（段落/标题/幻灯片/页面）分块，默认。
            - SEMANTIC: 语义分块，需额外提供 embeddings。
            - TASK_DEPENDENT: 逻辑分块 + 任务驱动尺寸（LOGICAL 的别名）。
        task_type: 任务类型，影响分块尺寸与重叠比例（见 TASK_SIZING_PROFILE）。
        summarization_strategy: 第三步归约方式。
            - MAP_REDUCE: 并行 Map 各分块 + 分层 Reduce，延迟低，适合分块数较多的场景。
            - REFINE: 严格按原文顺序串行滚动精炼，延迟与分块数成正比，但每一步都能
              看到"迄今为止的全部摘要"，更适合强调叙事连贯性、时间线一致性的文档。
        max_context_tokens: 该模型/部署的最大上下文窗口（token），用于判断是否需要分块
            及计算各阶段的 token 预算。默认取环境变量 OPIE_LLM_MAX_CONTEXT_TOKENS（见 .env），
            均未提供时回退到 settings.default_max_context_tokens。
        embeddings: SEMANTIC 分块所需的向量模型；其他策略可忽略。

    Returns:
        SummarizationResult: 含分块视图与归约视图，.final_summary 为最终摘要文本。

    Raises:
        ConfigurationError: OPIE_LLM_* 配置缺失，或 SEMANTIC 策略未提供 embeddings。
    """
    # 延迟导入：llm_client 会 load_dotenv 并依赖 langchain_openai，避免模块导入期的硬依赖
    from llm_client import build_opie_llm_client

    if strategy == ChunkingStrategy.SEMANTIC and embeddings is None:
        raise ConfigurationError("SEMANTIC 分块策略需要提供 embeddings 向量模型。")

    resolved_max_context = _resolve_max_context_tokens(max_context_tokens)

    # 模型名统一由 build_opie_llm_client 从 OPIE_LLM_MODEL 读取（缺失时其内部会报错）
    client = build_opie_llm_client()

    preprocessor = SummarizationPreprocessor(
        max_context_tokens=resolved_max_context,
        default_strategy=strategy,
        default_task_type=task_type,
        embeddings=embeddings,
    )

    summarizer: _Summarizer
    if summarization_strategy == SummarizationStrategy.MAP_REDUCE:
        summarizer = MapReduceSummarizer(
            map_client=client,
            max_context_tokens=resolved_max_context,
        )
    elif summarization_strategy == SummarizationStrategy.REFINE:
        summarizer = RefineSummarizer(
            refine_client=client,
            max_context_tokens=resolved_max_context,
        )
    else:
        raise ConfigurationError(f"未知的归约策略: {summarization_strategy}")

    service = SummarizationService(preprocessor=preprocessor, summarizer=summarizer)
    return await service.summarize(file_path, strategy=strategy, task_type=task_type)
