"""
基于任务目标调整块大小 (Task-Dependent Chunk Sizing)。

不同下游任务对"块大小"与"重叠比例"的最优取值并不相同：
- 摘要（Summarization）：需要尽量宽的上下文以保留论述连贯性，块可以更大，
  重叠可以较小（因为摘要对"跨块边界丢一两句话"相对不敏感）。
- 问答（QA）/信息抽取（Extraction）：需要精确定位到包含答案的片段，
  块应更小以提高检索精度，重叠应更大以降低"关键信息恰好被切在边界"的概率。
- 翻译（Translation）：块应尽量在句子/段落边界对齐，重叠适中。

本模块产出的 (chunk_size_tokens, overlap_tokens) 供 LogicalUnitChunker /
SemanticUnitChunker 作为"块的最大 token 上限"与"重叠机制"的输入参数，
真正实现"任务目标"对分块策略的调节，而不是一个独立的第三种切分算法。
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import TASK_SIZING_PROFILE, TaskType, settings
from ..exceptions import ConfigurationError


@dataclass(frozen=True)
class SizingResult:
    chunk_size_tokens: int
    overlap_tokens: int
    task_type: TaskType


class TaskDependentSizer:
    @staticmethod
    def compute(task_type: TaskType, max_context_tokens: int) -> SizingResult:
        profile = TASK_SIZING_PROFILE.get(task_type)
        if profile is None:
            raise ConfigurationError(f"未知任务类型: {task_type}")

        usable_tokens = settings.usable_context_tokens(max_context_tokens)
        chunk_size = max(int(usable_tokens * profile["ratio"]), 256)
        overlap = max(int(chunk_size * profile["overlap_ratio"]), 0)

        # 重叠不应超过块大小的一半，否则会导致有效新增内容过少、分块数量爆炸
        overlap = min(overlap, chunk_size // 2)

        return SizingResult(chunk_size_tokens=chunk_size, overlap_tokens=overlap, task_type=task_type)
