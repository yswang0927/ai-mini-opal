"""对外/对内数据契约（Pydantic v2）。FastAPI 路由可直接复用这些模型作为 response_model。"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field

from .config import ChunkingStrategy, DocumentFormat, TaskType


class TokenEstimateResult(BaseModel):
    total_tokens: int = Field(..., description="流式估算得到的文档总 token 数（近似值，见下方说明）")
    model_name: str
    context_window: int
    usable_context_tokens: int = Field(..., description="扣除输出/系统提示预留后的可用 token 数")
    exceeds_limit: bool = Field(..., description="是否超过可用上下文窗口，需要分块")
    is_estimate_truncated: bool = Field(
        default=False,
        description="当文档极大且早期已确认超限时，为节省资源提前终止扫描，"
        "此时 total_tokens 为下界估计（实际值 >= 该值）",
    )

    model_config = {"protected_namespaces": ()}


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
