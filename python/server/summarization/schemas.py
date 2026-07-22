"""对外/对内数据契约（Pydantic v2)。"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field, computed_field

from .config import ChunkingStrategy, DocumentFormat, SummarizationStrategy, TaskType


class TokenEstimateResult(BaseModel):
    total_tokens: int = Field(..., description="流式估算得到的文档总 token 数（近似值，见下方说明）")
    context_window: int
    usable_context_tokens: int = Field(..., description="扣除输出/系统提示预留后的可用 token 数")
    exceeds_limit: bool = Field(..., description="是否超过可用上下文窗口，需要分块")
    is_estimate_truncated: bool = Field(
        default=False,
        description="当文档极大且早期已确认超限时，为节省资源提前终止扫描，"
        "此时 total_tokens 为下界估计（实际值 >= 该值）",
    )


class ChunkMetadata(BaseModel):
    chunk_index: int
    source_format: DocumentFormat
    strategy_used: ChunkingStrategy
    token_count: int
    char_count: int
    logical_unit_type: Optional[str] = Field(
        default=None, description="如 heading/paragraph/slide/page/section 等"
    )
    has_overlap_prefix: bool = Field(default=False, description="本块开头是否携带了上一块的重叠内容")
    overlap_token_count: int = Field(default=0)


class Chunk(BaseModel):
    content: str
    metadata: ChunkMetadata


class ChunkingResult(BaseModel):
    chunks: List[Chunk]
    total_chunks: int
    strategy: ChunkingStrategy
    task_type: Optional[TaskType] = None
    token_estimate: TokenEstimateResult


class MapResult(BaseModel):
    """Map 阶段：单个原始分块经 LLM 生成的摘要。"""

    source_chunk_index: int
    summary: str
    input_token_count: int
    output_token_count: int
    succeeded: bool = True
    error_message: Optional[str] = None


class ReduceNode(BaseModel):
    """Reduce 阶段的归约树节点。level=0 对应 Map 阶段产出的叶子摘要，
    level>=1 为逐层合并产出的中间/最终摘要，child_source_indices 记录该节点
    最终追溯到的原始分块索引集合，用于事后审计（定位某句摘要来自哪些原文分块）。
    """

    node_id: str
    level: int
    content: str
    token_count: int
    child_source_indices: List[int] = Field(default_factory=list)


class MapReduceResult(BaseModel):
    final_summary: str
    map_results: List[MapResult]
    reduce_levels: List[List[ReduceNode]] = Field(
        default_factory=list, description="每一轮归约产出的节点列表，按层级顺序排列"
    )
    total_levels: int = 0
    failed_chunk_indices: List[int] = Field(default_factory=list)
    map_model_name: str
    reduce_model_name: str


class RefineStepResult(BaseModel):
    """Refine 链路中的单个步骤（严格按原文顺序串行执行）。"""

    step_index: int
    source_chunk_indices: List[int] = Field(
        default_factory=list, description="本步骤实际消费的原始分块索引（一个分块过大时可能被内部二次切分为多步）"
    )
    running_summary: str = Field(..., description="本步骤结束后的运行中摘要（滚动更新）")
    input_token_count: int
    output_token_count: int
    is_compression_step: bool = Field(
        default=False, description="是否为运行中摘要超出预算触发的独立压缩步骤（不消费新分块）"
    )
    succeeded: bool = True
    error_message: Optional[str] = None


class RefineResult(BaseModel):
    final_summary: str
    steps: List[RefineStepResult]
    total_steps: int
    total_compression_steps: int = 0
    failed_chunk_indices: List[int] = Field(default_factory=list)
    model_name: str

    model_config = {"protected_namespaces": ()}


class SummarizationResult(BaseModel):
    """端到端结果：分块阶段 + 第三步归约阶段（Map-Reduce 或 Refine 二选一）的完整视图。"""

    chunking: ChunkingResult
    strategy: SummarizationStrategy
    map_reduce: Optional[MapReduceResult] = None
    refine: Optional[RefineResult] = None

    @computed_field  # type: ignore[misc]
    @property
    def final_summary(self) -> str:
        if self.map_reduce is not None:
            return self.map_reduce.final_summary
        if self.refine is not None:
            return self.refine.final_summary
        return ""
