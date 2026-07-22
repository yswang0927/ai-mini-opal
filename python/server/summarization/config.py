"""
全局配置模块。

集中管理：
- 支持的文档格式
- 分块策略 / 任务类型枚举
- 各 LLM 的上下文窗口大小（可通过环境变量覆盖，便于随模型升级而调整）
- 流式读取的缓冲区大小等运行期参数

生产环境建议：将 MODEL_CONTEXT_WINDOWS 这类会随供应商更新而变化的数据
外置为配置中心（Consul/Nacos/数据库）而非硬编码，这里给出可被覆盖的默认实现。
"""

from __future__ import annotations

from enum import Enum
from typing import Dict

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class DocumentFormat(str, Enum):
    TXT = "txt"
    MARKDOWN = "markdown"
    DOCX = "docx"
    PPTX = "pptx"
    PDF = "pdf"

    @classmethod
    def from_suffix(cls, suffix: str) -> "DocumentFormat":
        suffix = suffix.lower().lstrip(".")
        mapping = {
            "txt": cls.TXT,
            "md": cls.MARKDOWN,
            "markdown": cls.MARKDOWN,
            "docx": cls.DOCX,
            "pptx": cls.PPTX,
            "pdf": cls.PDF,
        }
        if suffix not in mapping:
            raise ValueError(f"不支持的文档格式后缀: .{suffix}")
        return mapping[suffix]


class ChunkingStrategy(str, Enum):
    SEMANTIC = "semantic"          # 语义分块
    LOGICAL = "logical"            # 按逻辑单元分块（段落/标题/幻灯片/页面）
    TASK_DEPENDENT = "task_dependent"  # 基于任务目标调整块大小（叠加在前两者之上）


class TaskType(str, Enum):
    SUMMARIZATION = "summarization"
    QA = "qa"
    EXTRACTION = "extraction"
    TRANSLATION = "translation"


class SummarizationStrategy(str, Enum):
    """第三步"摘要归约"的执行方式，与第二步的 ChunkingStrategy 是正交的两个维度：
    ChunkingStrategy 决定"怎么切"，SummarizationStrategy 决定"切完之后怎么总结"。
    """

    MAP_REDUCE = "map_reduce"  # 并行 Map 每个分块 -> 分层 Reduce 归约
    REFINE = "refine"          # 串行滚动：首块生成初始摘要 -> 逐块并入前序摘要迭代精炼


# 各任务类型对"分块大小/重叠比例"的偏好系数。
# ratio: 单块目标占用「可用上下文」的比例（越依赖全局语境的任务，块越大）
# overlap_ratio: 重叠 token 占块大小的比例（越依赖精确边界召回的任务，重叠越大）
TASK_SIZING_PROFILE: Dict[TaskType, Dict[str, float]] = {
    TaskType.SUMMARIZATION: {"ratio": 0.70, "overlap_ratio": 0.08},
    TaskType.QA: {"ratio": 0.35, "overlap_ratio": 0.20},
    TaskType.EXTRACTION: {"ratio": 0.30, "overlap_ratio": 0.20},
    TaskType.TRANSLATION: {"ratio": 0.45, "overlap_ratio": 0.12},
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SUMM_", env_file=".env", extra="ignore")

    # 最大上下文窗口（token）。现场环境的窗口大小由部署方定制，因此不再按模型名
    # 硬编码映射表，而是作为参数显式传入各组件；此处仅提供一个兜底默认值，
    # 生产环境通过 .env 的 OPIE_LLM_MAX_CONTEXT_TOKENS 配置并经 summarize_document 注入。
    default_max_context_tokens: int = 128_000

    # 预留给「输出」与「系统/指令 Prompt」的 token 数，防止总量超限
    reserved_output_tokens: int = 2_000
    reserved_system_prompt_tokens: int = 1_000

    # 判断是否需要分块时的安全余量（越保守，越提前触发分块）
    context_safety_margin: float = 0.90

    # 流式读取缓冲区（字节）：txt/markdown 按此块大小读取
    stream_buffer_size_bytes: int = 64 * 1024  # 64KB

    # token 估算时，为避免分片边界切断单词/token 造成的误差，使用的字符级"结转窗口"
    token_estimation_carry_chars: int = 64

    # 语义分块相似度断点类型：percentile / standard_deviation / interquartile
    semantic_breakpoint_threshold_type: str = "percentile"
    semantic_breakpoint_threshold_amount: float = 90.0

    # ---------------- Map-Reduce 归约链路配置 ----------------
    # Map 阶段并发调用 LLM 的最大并发数（避免打满下游 LLM 服务的速率限制）
    map_max_concurrency: int = 5
    # LLM 调用失败时的最大重试次数（指数退避）
    llm_max_retries: int = 3
    llm_retry_base_delay_seconds: float = 1.0
    # Reduce 阶段：每一轮归约时，多个"待合并摘要"打包进一次 LLM 调用的 token 预算
    # 占该轮可用上下文的比例（留出空间给 reduce 提示词本身与输出）
    reduce_batch_context_ratio: float = 0.6
    # 单次 reduce 调用即便只有 1 个输入摘要，也允许直接透传（避免无意义的空转合并）
    reduce_min_fan_in: int = 2
    # Map/Reduce 阶段任一步失败时，是否整体快速失败（True）还是跳过失败分块继续（False）
    fail_fast: bool = True
    # 归约层数安全上限：防御性配置，防止异常数据导致归约无法收敛而无限循环
    max_reduce_levels: int = 20

    # ---------------- Refine 链路配置 ----------------
    # Refine 每一步的 prompt = 运行中摘要 + 当前分块 + 模板开销，三者必须共同落在
    # usable_context_tokens 之内。这里将可用上下文按比例三方切分：
    #   refine_chunk_budget_ratio   —— 单个分块允许占用的比例
    #   refine_summary_budget_ratio —— "运行中摘要"允许占用的比例（超出则触发压缩）
    #   剩余部分留给 Prompt 模板文字本身的开销
    # 注意：这两个比例是 Refine 专属的，独立于 chunking/task_sizer.py 中面向
    # Map-Reduce 的 TASK_SIZING_PROFILE —— 因为 Refine 的单步 prompt 需要同时容纳
    # "分块"与"运行中摘要"两部分内容，可分配给分块本身的空间天然更小。
    refine_chunk_budget_ratio: float = 0.55
    refine_summary_budget_ratio: float = 0.30
    # 运行中摘要超过预算时触发一次独立的"压缩"调用（合并同类信息、去冗余，
    # 而非删减事实），将其压回预算之内再继续下一步，防止摘要随链条无限增长
    refine_compression_trigger_ratio: float = 1.0  # 超过 summary 预算的多少倍才触发压缩
    # Refine 是严格串行链路，某一步失败即会阻断后续依赖它的所有步骤：
    # fail_fast=True 时任一步失败直接终止；False 时跳过该分块、运行中摘要保持不变继续链条
    refine_fail_fast: bool = True

    def usable_context_tokens(self, max_context_tokens: int) -> int:
        """扣除输出预留与系统提示预留、并乘以安全余量后，真正可用于文档内容的 token 数。

        max_context_tokens 为该模型/部署的最大上下文窗口（token），由调用方显式传入
        （现场环境通过 OPIE_LLM_MAX_CONTEXT_TOKENS 配置），不再按模型名查表。
        """
        raw_usable = max_context_tokens - self.reserved_output_tokens - self.reserved_system_prompt_tokens
        return max(int(raw_usable * self.context_safety_margin), 256)


settings = Settings()
