"""
Map-Reduce 归约链路。

Map 阶段：对每个分块并发调用 LLM 独立生成摘要（有界并发 + 指数退避重试）。
Reduce 阶段：将 Map 输出的摘要按 token 预算打包分批，每批合并成一条新摘要；
若合并后仍多于 1 条，重复该过程（层级归约 / hierarchical merging），
直到收敛为单一最终摘要。这与全量长上下文摘要相比，在多数场景下质量相当
甚至更优，而成本显著更低（每次 LLM 调用只处理一小段文本，而不是整份文档）。

关键工程细节：
    1. 每一层归约都记录为 ReduceNode 树，并向上传播 child_source_indices，
       使最终摘要中的任意内容都可以追溯回具体的原始分块 —— 这是后续接入
       "分解-验证"式幻觉检测管道的必要前提（没有可追溯的血缘关系，
       就无法判断某条摘要陈述到底源自文档的哪一部分）。
    2. 批次打包不是简单的"每两个摘要合并一次"，而是按 token 预算贪心装箱，
       尽量减少归约层数（层数越多，误差累积/幻觉放大的风险越高）。
    3. 当某一批次只包含单个节点时，直接透传而不发起 LLM 调用 —— 避免无意义的
       "自己复述自己"步骤，既省成本又避免引入不必要的改写幻觉风险。
    4. 设置 max_reduce_levels 防御性上限，防止极端输入（如单个摘要 token 数
       本身就超过每一层的批次预算）导致归约无法收敛而无限循环。
"""

from __future__ import annotations

import asyncio

from typing import List, Optional

from .config import TaskType, settings
from .exceptions import MapReduceError
from .schemas import Chunk, MapReduceResult, MapResult, ReduceNode
from llm_client import LLMClient, RetryingLLMClient
from .prompts import build_map_prompt, build_reduce_prompt
from .tokenization import StreamingTokenEstimator
from logger import get_logger

logger = get_logger(__name__)


def _ensure_retrying(client: LLMClient) -> LLMClient:
    """确保客户端具备重试能力，避免调用方忘记包装 RetryingLLMClient。"""
    return client if isinstance(client, RetryingLLMClient) else RetryingLLMClient(client)


class MapReduceSummarizer:
    def __init__(
        self,
        map_client: LLMClient,
        reduce_client: Optional[LLMClient] = None,
        token_estimator: Optional[StreamingTokenEstimator] = None,
        map_model_name: str = "gpt-4o",
        reduce_model_name: Optional[str] = None,
        max_context_tokens: Optional[int] = None,
        max_concurrency: Optional[int] = None,
        fail_fast: Optional[bool] = None,
        use_topic_understanding_phase: bool = True,
    ):
        self.map_client = _ensure_retrying(map_client)
        # 允许 Reduce 阶段使用与 Map 阶段不同（通常更强）的模型；未指定时复用 Map 客户端
        self.reduce_client = _ensure_retrying(reduce_client) if reduce_client else self.map_client
        self.map_model_name = map_model_name
        self.reduce_model_name = reduce_model_name or map_model_name
        # 最大上下文窗口由调用方显式传入（现场定制），未指定时回退到配置默认值。
        self.max_context_tokens = max_context_tokens or settings.default_max_context_tokens
        self.token_estimator = token_estimator or StreamingTokenEstimator(
            model_name=self.map_model_name,
            max_context_tokens=self.max_context_tokens,
        )
        self.max_concurrency = max_concurrency or settings.map_max_concurrency
        self.fail_fast = fail_fast if fail_fast is not None else settings.fail_fast
        self.use_topic_understanding_phase = use_topic_understanding_phase

    async def run(self, chunks: List[Chunk], task_type: TaskType = TaskType.SUMMARIZATION) -> MapReduceResult:
        if not chunks:
            raise MapReduceError("分块列表为空，无法执行 Map-Reduce")

        # 只有一个块时，Map 阶段的输出本身就是最终摘要，无需 Reduce
        map_results = await self._map_phase(chunks, task_type)

        succeeded = [r for r in map_results if r.succeeded]
        failed_indices = [r.source_chunk_index for r in map_results if not r.succeeded]

        if failed_indices and self.fail_fast:
            raise MapReduceError(
                f"Map 阶段有 {len(failed_indices)} 个分块处理失败，已终止（fail_fast=True）",
                failed_indices=failed_indices,
            )
        if not succeeded:
            raise MapReduceError("Map 阶段全部分块处理失败", failed_indices=failed_indices)
        if failed_indices:
            logger.warning(
                "Map 阶段有 %d 个分块处理失败，已跳过并继续归约: %s", len(failed_indices), failed_indices
            )

        leaf_nodes = [
            ReduceNode(
                node_id=f"map-{r.source_chunk_index}",
                level=0,
                content=r.summary,
                token_count=r.output_token_count,
                child_source_indices=[r.source_chunk_index],
            )
            for r in succeeded
        ]

        reduce_levels: List[List[ReduceNode]] = [leaf_nodes]
        current_nodes = leaf_nodes
        level = 0

        while len(current_nodes) > 1:
            if level >= settings.max_reduce_levels:
                raise MapReduceError(
                    f"归约层数超过安全上限 ({settings.max_reduce_levels})，可能存在无法收敛的输入，"
                    f"请检查单条摘要是否异常巨大或调大 reduce_batch_context_ratio。"
                )
            batches = self._batch_nodes(current_nodes)
            is_final_level = len(batches) == 1
            current_nodes = await self._reduce_level(batches, task_type, level, is_final_level)
            reduce_levels.append(current_nodes)
            level += 1

        final_summary = current_nodes[0].content if current_nodes else ""

        return MapReduceResult(
            final_summary=final_summary,
            map_results=map_results,
            reduce_levels=reduce_levels[1:],  # 第 0 层（叶子/Map输出）已包含在 map_results 中，避免冗余
            total_levels=len(reduce_levels) - 1,
            failed_chunk_indices=failed_indices,
            map_model_name=self.map_model_name,
            reduce_model_name=self.reduce_model_name,
        )

    # ------------------------------------------------------------------ #
    # Map 阶段
    # ------------------------------------------------------------------ #

    async def _map_phase(self, chunks: List[Chunk], task_type: TaskType) -> List[MapResult]:
        semaphore = asyncio.Semaphore(self.max_concurrency)
        total = len(chunks)

        async def _map_one(chunk: Chunk) -> MapResult:
            async with semaphore:
                prompt = build_map_prompt(
                    chunk_text=chunk.content,
                    task_type=task_type,
                    chunk_index=chunk.metadata.chunk_index,
                    total_chunks=total,
                    use_topic_understanding_phase=self.use_topic_understanding_phase,
                )
                input_tokens = self.token_estimator.count_tokens(prompt)
                try:
                    summary = await self.map_client.complete(prompt)
                    return MapResult(
                        source_chunk_index=chunk.metadata.chunk_index,
                        summary=summary.strip(),
                        input_token_count=input_tokens,
                        output_token_count=self.token_estimator.count_tokens(summary),
                        succeeded=True,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.error("Map 阶段分块 %d 处理失败: %s", chunk.metadata.chunk_index, exc)
                    return MapResult(
                        source_chunk_index=chunk.metadata.chunk_index,
                        summary="",
                        input_token_count=input_tokens,
                        output_token_count=0,
                        succeeded=False,
                        error_message=str(exc),
                    )

        results = await asyncio.gather(*(_map_one(c) for c in chunks))
        return sorted(results, key=lambda r: r.source_chunk_index)

    # ------------------------------------------------------------------ #
    # Reduce 阶段
    # ------------------------------------------------------------------ #

    def _batch_nodes(self, nodes: List[ReduceNode]) -> List[List[ReduceNode]]:
        """按 token 预算贪心装箱，将待归约节点分组为批次。"""
        usable = settings.usable_context_tokens(self.max_context_tokens)
        budget = max(int(usable * settings.reduce_batch_context_ratio), 256)

        batches: List[List[ReduceNode]] = []
        current: List[ReduceNode] = []
        current_tokens = 0

        for node in nodes:
            if current and current_tokens + node.token_count > budget:
                batches.append(current)
                current = []
                current_tokens = 0
            current.append(node)
            current_tokens += node.token_count

        if current:
            batches.append(current)

        # 收尾处理：若最后一批只有单个节点，且前面还有其他批次，
        # 尝试并入上一批次（只要不严重超预算），避免产生大量"单节点批次"
        # 导致归约层数无谓增多。
        if len(batches) >= 2 and len(batches[-1]) == 1:
            last = batches[-1]
            prev_tokens = sum(n.token_count for n in batches[-2])
            if prev_tokens + last[0].token_count <= budget * 1.1:
                batches[-2].extend(last)
                batches.pop()

        # 防御性兜底：如果批次数量与节点数量相同（意味着完全没有发生合并，
        # 通常是单个节点 token 数就已超过批次预算），强制两两配对以保证归约
        # 能够继续收敛，而不是陷入无限循环。这种情况会记录告警，
        # 因为它意味着某个摘要节点异常庞大，值得关注。
        if len(batches) == len(nodes) and len(nodes) > 1:
            logger.warning(
                "归约批次装箱未能合并任何节点（可能存在单个摘要 token 数过大），"
                "强制两两配对以保证收敛。"
            )
            batches = [nodes[i : i + 2] for i in range(0, len(nodes), 2)]

        return batches

    async def _reduce_level(
        self,
        batches: List[List[ReduceNode]],
        task_type: TaskType,
        level: int,
        is_final_level: bool,
    ) -> List[ReduceNode]:
        semaphore = asyncio.Semaphore(self.max_concurrency)

        async def _reduce_one(batch_index: int, batch: List[ReduceNode]) -> ReduceNode:
            child_indices = sorted({idx for n in batch for idx in n.child_source_indices})

            # 单节点批次：直接透传，不发起 LLM 调用
            if len(batch) == 1:
                node = batch[0]
                return ReduceNode(
                    node_id=f"reduce-L{level + 1}-{batch_index}",
                    level=level + 1,
                    content=node.content,
                    token_count=node.token_count,
                    child_source_indices=child_indices,
                )

            async with semaphore:
                prompt = build_reduce_prompt(
                    summaries=[n.content for n in batch],
                    task_type=task_type,
                    level=level,
                    is_final_level=is_final_level,
                )
                try:
                    merged = await self.reduce_client.complete(prompt)
                except Exception as exc:  # noqa: BLE001
                    raise MapReduceError(
                        f"Reduce 阶段第 {level + 1} 层第 {batch_index} 批次失败",
                        failed_indices=child_indices,
                    ) from exc

                merged = merged.strip()
                return ReduceNode(
                    node_id=f"reduce-L{level + 1}-{batch_index}",
                    level=level + 1,
                    content=merged,
                    token_count=self.token_estimator.count_tokens(merged),
                    child_source_indices=child_indices,
                )

        results = await asyncio.gather(*(_reduce_one(i, b) for i, b in enumerate(batches)))
        return list(results)
