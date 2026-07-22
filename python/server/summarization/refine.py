"""
Refine 归约链路。

与 Map-Reduce 的本质区别：
    Map-Reduce 是"先并行独立总结各分块，再合并"——各分块的摘要生成互不依赖，
    合并阶段才第一次让不同分块的信息相遇。
    Refine 是"滚动式"的——从第一个分块生成初始摘要开始，每处理一个新分块，
    都要把它与【当前为止的运行中摘要】一起交给 LLM，产出更新后的摘要，
    如此严格按原文顺序串行推进，直到最后一个分块处理完毕。

工程含义：
    1. 【无法并发】：第 i 步的输入依赖第 i-1 步的输出，只能顺序执行，
       延迟与分块数量成正比（N 个分块 = N 次串行 LLM 调用，而不是 Map-Reduce
       那样的 1 轮并行 Map + O(log N) 轮 Reduce）。
    2. 【摘要会随链条增长】：如果不加控制，运行中摘要可能随着不断并入新内容
       越滚越长，最终自己就超过了下一步 prompt 的可用预算。因此这里引入
       "运行中摘要 token 预算"，一旦超出，先触发一次独立的压缩调用把它
       压回预算之内，再继续处理下一个分块。
    3. 【单步 prompt 必须同时容纳"运行中摘要"与"新分块"】：因此分配给
       单个分块的 token 预算（refine_chunk_budget_ratio）天然小于 Map-Reduce
       中单个 Map 调用可用的预算——如果上游分块本身超过这个预算
       （例如复用了为 Map-Reduce 调优的分块结果），会在这里被二次切分，
       不要求调用方为 Refine 单独重新分块。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import TaskType, settings
from .exceptions import MapReduceError
from .schemas import Chunk, RefineResult, RefineStepResult
from llm_client import LLMClient, RetryingLLMClient
from .prompts import (
    build_refine_compression_prompt,
    build_refine_initial_prompt,
    build_refine_step_prompt,
)
from .tokenization import StreamingTokenEstimator

from logger import get_logger

logger = get_logger(__name__)


def _ensure_retrying(client: LLMClient) -> LLMClient:
    return client if isinstance(client, RetryingLLMClient) else RetryingLLMClient(client)


@dataclass
class _RefineUnit:
    """Refine 链路实际消费的最小单位。通常一一对应一个 Chunk，
    但当某个 Chunk 超过 refine_chunk_budget_ratio 允许的大小时，
    会在此被二次切分为多个 _RefineUnit，仍保留原 chunk_index 以便溯源。
    """

    text: str
    source_chunk_index: int
    is_last_unit_overall: bool = False


class RefineSummarizer:
    def __init__(
        self,
        refine_client: LLMClient,
        token_estimator: Optional[StreamingTokenEstimator] = None,
        model_name: str = "gpt-4o",
        max_context_tokens: Optional[int] = None,
        fail_fast: Optional[bool] = None,
        use_topic_understanding_phase: bool = True,
    ):
        self.refine_client = _ensure_retrying(refine_client)
        self.model_name = model_name
        # 最大上下文窗口由调用方显式传入（现场定制），未指定时回退到配置默认值。
        self.max_context_tokens = max_context_tokens or settings.default_max_context_tokens
        self.token_estimator = token_estimator or StreamingTokenEstimator(
            max_context_tokens=self.max_context_tokens
        )
        self.fail_fast = fail_fast if fail_fast is not None else settings.refine_fail_fast
        self.use_topic_understanding_phase = use_topic_understanding_phase

    async def run(self, chunks: List[Chunk], task_type: TaskType = TaskType.SUMMARIZATION) -> RefineResult:
        if not chunks:
            raise MapReduceError("分块列表为空，无法执行 Refine")

        units = self._prepare_units(chunks)
        usable = settings.usable_context_tokens(self.max_context_tokens)
        summary_budget = max(int(usable * settings.refine_summary_budget_ratio), 128)
        compression_trigger = int(summary_budget * settings.refine_compression_trigger_ratio)

        steps: List[RefineStepResult] = []
        failed_chunk_indices: List[int] = []
        running_summary = ""
        step_index = 0

        for i, unit in enumerate(units):
            is_final = i == len(units) - 1
            prompt = (
                build_refine_initial_prompt(
                    chunk_text=unit.text,
                    task_type=task_type,
                    is_final=is_final,
                    use_topic_understanding_phase=self.use_topic_understanding_phase,
                )
                if i == 0
                else build_refine_step_prompt(
                    running_summary=running_summary,
                    chunk_text=unit.text,
                    task_type=task_type,
                    is_final=is_final,
                )
            )
            input_tokens = self.token_estimator.count_tokens(prompt)

            try:
                new_summary = (await self.refine_client.complete(prompt)).strip()
            except Exception as exc:  # noqa: BLE001
                logger.error("Refine 步骤 %d（分块 %d）失败: %s", step_index, unit.source_chunk_index, exc)
                if self.fail_fast:
                    raise MapReduceError(
                        f"Refine 链路在处理分块 {unit.source_chunk_index} 时失败，"
                        f"由于严格串行依赖，后续所有步骤均无法继续",
                        failed_indices=[unit.source_chunk_index],
                    ) from exc
                steps.append(
                    RefineStepResult(
                        step_index=step_index,
                        source_chunk_indices=[unit.source_chunk_index],
                        running_summary=running_summary,  # 保持不变
                        input_token_count=input_tokens,
                        output_token_count=0,
                        succeeded=False,
                        error_message=str(exc),
                    )
                )
                failed_chunk_indices.append(unit.source_chunk_index)
                step_index += 1
                continue  # running_summary 不变，跳过该分块继续链条

            running_summary = new_summary
            output_tokens = self.token_estimator.count_tokens(running_summary)
            steps.append(
                RefineStepResult(
                    step_index=step_index,
                    source_chunk_indices=[unit.source_chunk_index],
                    running_summary=running_summary,
                    input_token_count=input_tokens,
                    output_token_count=output_tokens,
                    succeeded=True,
                )
            )
            step_index += 1

            # 运行中摘要超过预算：触发独立压缩步骤，压回预算之内再继续下一个分块
            if output_tokens > compression_trigger and not is_final:
                compressed_summary, compression_step = await self._compress(
                    running_summary, task_type, step_index
                )
                running_summary = compressed_summary
                steps.append(compression_step)
                step_index += 1

        total_compression_steps = sum(1 for s in steps if s.is_compression_step)

        return RefineResult(
            final_summary=running_summary,
            steps=steps,
            total_steps=len(steps),
            total_compression_steps=total_compression_steps,
            failed_chunk_indices=failed_chunk_indices,
            model_name=self.model_name,
        )

    # ------------------------------------------------------------------ #
    # 内部实现
    # ------------------------------------------------------------------ #

    async def _compress(
        self, running_summary: str, task_type: TaskType, step_index: int
    ) -> tuple[str, RefineStepResult]:
        logger.info("运行中摘要超过预算，触发压缩步骤 (step_index=%d)", step_index)
        prompt = build_refine_compression_prompt(running_summary, task_type)
        input_tokens = self.token_estimator.count_tokens(prompt)
        try:
            compressed = (await self.refine_client.complete(prompt)).strip()
            output_tokens = self.token_estimator.count_tokens(compressed)
            step = RefineStepResult(
                step_index=step_index,
                source_chunk_indices=[],  # 压缩步骤不消费新的原始分块
                running_summary=compressed,
                input_token_count=input_tokens,
                output_token_count=output_tokens,
                is_compression_step=True,
                succeeded=True,
            )
            return compressed, step
        except Exception as exc:  # noqa: BLE001
            # 压缩失败不阻断主链条：退回未压缩的摘要继续，仅记录告警。
            # 摘要偏长顶多增加后续 prompt 的 token 开销，不是致命错误；
            # 但若持续增长最终超出可用上下文，会在下一步 LLM 调用时报错，
            # 这种"显式失败"优于压缩失败时静默截断摘要造成的信息丢失。
            logger.warning("压缩步骤失败，运行中摘要将保持未压缩状态继续: %s", exc)
            step = RefineStepResult(
                step_index=step_index,
                source_chunk_indices=[],
                running_summary=running_summary,
                input_token_count=input_tokens,
                output_token_count=self.token_estimator.count_tokens(running_summary),
                is_compression_step=True,
                succeeded=False,
                error_message=str(exc),
            )
            return running_summary, step

    def _prepare_units(self, chunks: List[Chunk]) -> List[_RefineUnit]:
        """将上游 Chunk 列表转换为 Refine 实际消费的单位列表，
        对超过 refine_chunk_budget_ratio 预算的 Chunk 做二次切分。
        """
        usable = settings.usable_context_tokens(self.max_context_tokens)
        chunk_budget = max(int(usable * settings.refine_chunk_budget_ratio), 256)

        units: List[_RefineUnit] = []
        for chunk in chunks:
            token_count = self.token_estimator.count_tokens(chunk.content)
            if token_count <= chunk_budget:
                units.append(
                    _RefineUnit(text=chunk.content, source_chunk_index=chunk.metadata.chunk_index)
                )
                continue

            logger.warning(
                "分块 %d 的 token 数 (%d) 超过 Refine 单步预算 (%d)，执行二次切分。",
                chunk.metadata.chunk_index,
                token_count,
                chunk_budget,
            )
            splitter = RecursiveCharacterTextSplitter(
                chunk_size=chunk_budget,
                chunk_overlap=0,
                length_function=self.token_estimator.count_tokens,
            )
            for piece in splitter.split_text(chunk.content):
                if piece.strip():
                    units.append(
                        _RefineUnit(text=piece, source_chunk_index=chunk.metadata.chunk_index)
                    )

        return units
