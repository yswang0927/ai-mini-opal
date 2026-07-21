"""
语义分块 (Semantic Chunking)。

原理：不再依赖固定的字符/token 数或文档结构标记，而是计算相邻句子的
embedding 相似度，在语义发生明显转折的位置切分，使每个块内部话题连贯。

内存/流式约束的处理方式：
    真正的语义分块算法（无论是 langchain_experimental.SemanticChunker 还是
    我们的 fallback 实现）都需要"一次性看到一段连续文本"才能计算句间相似度，
    因此不可能做到逐字节流式处理。但为了避免把几百 MB 的整篇文档一次性
    传入 embedding 模型，本实现采用【有界批次】策略：
        - 从 Reader 中持续拉取逻辑单元，累积到一个"批次 token 预算"
          （默认为 max_chunk_tokens 的 20 倍，且不超过 settings 中的上限）；
        - 达到预算后，对当前批次文本执行一次语义切分，产出若干 RawChunk；
        - 清空累积区，处理下一批次；
    这样峰值内存与"批次大小"成正比，而与文档总长度无关，
    在"语义连贯性"与"内存可控性"之间取得可控的折中。

Embedding 后端优先级（通过依赖注入 embeddings 参数，方便测试与替换）：
    1. 调用方显式传入的 langchain Embeddings 实例（如 OpenAIEmbeddings、
       HuggingFaceEmbeddings，接入生产环境的向量化服务）；
    2. 若未传入，尝试懒加载本地 sentence-transformers 模型；
    3. 若上述依赖均不可用，回退到一个不依赖第三方向量模型的轻量级
       "词袋余弦相似度"启发式实现，仅保证功能可用，精度低于真实语义模型，
       生产环境强烈建议显式注入向量化 Embeddings。
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import List, Optional, Sequence

from langchain_core.embeddings import Embeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

from ..chunking.base import BaseChunker, RawChunk
from ..readers.base import BaseStreamingReader

from logger import get_logger

logger = get_logger(__name__)

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[。！？.!?])\s*")


class _BagOfWordsFallbackEmbeddings:
    """无第三方依赖的兜底"伪嵌入"：以词频向量的余弦相似度近似语义相似度。
    仅在 langchain_experimental / sentence-transformers 均不可用时启用。
    """

    def embed_documents(self, texts: Sequence[str]) -> List[List[float]]:
        return [self._vectorize(t) for t in texts]

    def embed_query(self, text: str) -> List[float]:
        return self._vectorize(text)

    @staticmethod
    def _vectorize(text: str) -> List[float]:
        tokens = re.findall(r"\w+", text.lower())
        counts = Counter(tokens)
        # 简单起见使用固定哈希桶而非完整词表，避免维度随语料增长
        vec = [0.0] * 256
        for word, cnt in counts.items():
            idx = hash(word) % 256
            vec[idx] += cnt
        return vec


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 1.0  # 视为相似，避免除零导致误切
    return dot / (norm_a * norm_b)


class SemanticUnitChunker(BaseChunker):
    def __init__(
        self,
        token_estimator,
        max_chunk_tokens: int,
        embeddings: Optional[Embeddings] = None,
        breakpoint_percentile: float = 90.0,
        batch_token_budget: Optional[int] = None,
    ):
        super().__init__(token_estimator, max_chunk_tokens)
        self.embeddings = embeddings or self._load_default_embeddings()
        self.breakpoint_percentile = breakpoint_percentile
        self.batch_token_budget = batch_token_budget or max(max_chunk_tokens * 20, 20_000)
        self._langchain_semantic_chunker = self._try_build_langchain_chunker()

    def chunk(self, reader: BaseStreamingReader) -> List[RawChunk]:
        raw_chunks: List[RawChunk] = []
        batch_texts: List[str] = []
        batch_tokens = 0

        def flush_batch() -> None:
            nonlocal batch_texts, batch_tokens
            if not batch_texts:
                return
            batch_text = "\n\n".join(batch_texts)
            raw_chunks.extend(self._semantic_split(batch_text))
            batch_texts = []
            batch_tokens = 0

        for unit in reader.iter_units():
            unit_tokens = self._count(unit.text)
            if batch_tokens + unit_tokens > self.batch_token_budget and batch_texts:
                flush_batch()
            batch_texts.append(unit.text)
            batch_tokens += unit_tokens

        flush_batch()
        return raw_chunks

    # ------------------------------------------------------------------ #
    # 内部实现
    # ------------------------------------------------------------------ #

    def _semantic_split(self, text: str) -> List[RawChunk]:
        if self._langchain_semantic_chunker is not None:
            try:
                pieces = self._langchain_semantic_chunker.split_text(text)
            except Exception as exc:  # noqa: BLE001
                logger.warning("langchain SemanticChunker 执行失败，回退到内置实现: %s", exc)
                pieces = self._fallback_semantic_split(text)
        else:
            pieces = self._fallback_semantic_split(text)

        result: List[RawChunk] = []
        for piece in pieces:
            piece = piece.strip()
            if not piece:
                continue
            tokens = self._count(piece)
            if tokens <= self.max_chunk_tokens:
                result.append(RawChunk(text=piece, token_count=tokens, logical_unit_type="semantic_segment"))
            else:
                # 语义切分出的单段仍超限（如超长专业论述无明显语义断点），做兜底二次切分
                sub_splitter = RecursiveCharacterTextSplitter(
                    chunk_size=self.max_chunk_tokens,
                    chunk_overlap=0,
                    length_function=self._count,
                )
                for sub in sub_splitter.split_text(piece):
                    if sub.strip():
                        result.append(
                            RawChunk(
                                text=sub,
                                token_count=self._count(sub),
                                logical_unit_type="semantic_segment",
                            )
                        )
        return result

    def _try_build_langchain_chunker(self):
        try:
            from langchain_experimental.text_splitter import SemanticChunker

            return SemanticChunker(
                embeddings=self.embeddings,
                breakpoint_threshold_type="percentile",
                breakpoint_threshold_amount=self.breakpoint_percentile,
            )
        except ImportError:
            logger.info("未安装 langchain_experimental，语义分块将使用内置兜底实现。")
            return None

    @staticmethod
    def _load_default_embeddings() -> Embeddings:
        model_name = "sentence-transformers/all-MiniLM-L6-v2"
        # 优先使用未废弃的 langchain-huggingface 包，其次回退到 langchain_community 的旧实现
        for module_path, cls_name in (
            ("langchain_huggingface", "HuggingFaceEmbeddings"),
            ("langchain_community.embeddings", "HuggingFaceEmbeddings"),
        ):
            try:
                module = __import__(module_path, fromlist=[cls_name])
                embedding_cls = getattr(module, cls_name)
                return embedding_cls(model_name=model_name)
            except Exception:  # noqa: BLE001
                continue

        logger.warning(
            "未能加载本地 sentence-transformers 模型 (%s)，"
            "语义分块将使用低精度的词袋余弦相似度兜底方案，"
            "生产环境请显式注入 embeddings 参数（如 OpenAIEmbeddings）。",
            model_name,
        )
        return _BagOfWordsFallbackEmbeddings()  # type: ignore[return-value]

    def _fallback_semantic_split(self, text: str) -> List[str]:
        """当 langchain_experimental 不可用时的内置语义分块实现：
        按句子切分 -> 计算相邻句子 embedding 余弦相似度 -> 在相似度显著下降处断开。
        """
        sentences = [s for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]
        if len(sentences) <= 1:
            return [text]

        embeddings = self.embeddings.embed_documents(sentences)
        similarities = [
            _cosine(embeddings[i], embeddings[i + 1]) for i in range(len(embeddings) - 1)
        ]
        if not similarities:
            return [text]

        # 用百分位阈值确定"显著下降"的断点：相似度低于 (100 - percentile) 分位点即断开
        sorted_sims = sorted(similarities)
        cutoff_idx = int(len(sorted_sims) * (1 - self.breakpoint_percentile / 100.0))
        cutoff_idx = min(max(cutoff_idx, 0), len(sorted_sims) - 1)
        threshold = sorted_sims[cutoff_idx]

        segments: List[str] = []
        current = [sentences[0]]
        for i, sim in enumerate(similarities):
            if sim <= threshold:
                segments.append(" ".join(current))
                current = [sentences[i + 1]]
            else:
                current.append(sentences[i + 1])
        if current:
            segments.append(" ".join(current))
        return segments
