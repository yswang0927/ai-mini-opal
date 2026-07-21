"""
按逻辑单元分块 (Logical Unit Chunking)。

核心思想：分块边界应尽量与文档本身的结构边界对齐（标题、段落、幻灯片、页面），
而不是任意的字符/token 位置切割，这样可以最大程度保留语义完整性。

实现方式：
1. 复用 Reader.iter_units() 已经识别出的逻辑单元类型
   （docx: paragraph/heading, pptx: slide, pdf: page, txt/markdown: block/paragraph）。
2. 贪心地将连续的逻辑单元打包进一个块，直到达到 max_chunk_tokens 上限
   （该上限由 TaskDependentSizer 依据任务类型算出，实现"任务目标驱动"的效果）。
3. 遇到标题（heading）或新的幻灯片/页面时，倾向于在此处开启新块，
   保证"一个块尽量对应一个完整章节/页/slide"而不是被从中间切断。
4. 对于单个逻辑单元本身就超过 max_chunk_tokens 的极端情况
   （例如一段没有任何空行的超长正文），退化为使用
   langchain 的 RecursiveCharacterTextSplitter 按句子/子句粒度做二次切分，
   避免产出一个超出上下文窗口的不可用块。
"""

from __future__ import annotations

import re
from typing import List

from langchain_text_splitters import RecursiveCharacterTextSplitter

from ..chunking.base import BaseChunker, RawChunk
from ..readers.base import BaseStreamingReader, TextUnit

from logger import get_logger

logger = get_logger(__name__)


_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+\S")

# 用于二次切分超大单元的分隔符优先级：先按段落，再按中英文句子，最后按空格兜底。
_SECONDARY_SEPARATORS = ["\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", " ", ""]

_SECTION_STARTING_TYPES = {"heading", "slide", "page"}


class LogicalUnitChunker(BaseChunker):
    def chunk(self, reader: BaseStreamingReader) -> List[RawChunk]:
        raw_chunks: List[RawChunk] = []
        buffer_units: List[TextUnit] = []
        buffer_tokens = 0

        def flush() -> None:
            nonlocal buffer_units, buffer_tokens
            if not buffer_units:
                return
            text = "\n\n".join(u.text for u in buffer_units)
            dominant_type = buffer_units[0].unit_type
            raw_chunks.append(
                RawChunk(text=text, token_count=buffer_tokens, logical_unit_type=dominant_type)
            )
            buffer_units = []
            buffer_tokens = 0

        for unit in reader.iter_units():
            unit = self._normalize_markdown_heading(unit)
            unit_tokens = self._count(unit.text)

            # 单个逻辑单元本身就超限：先把已有缓冲区落盘，再对该单元做二次切分
            if unit_tokens > self.max_chunk_tokens:
                flush()
                raw_chunks.extend(self._split_oversized_unit(unit))
                continue

            # 遇到章节/页/幻灯片边界，且当前缓冲区已有内容，则优先在此处断开
            starts_new_section = unit.unit_type in _SECTION_STARTING_TYPES and buffer_units
            exceeds_after_add = buffer_tokens + unit_tokens > self.max_chunk_tokens

            if starts_new_section or exceeds_after_add:
                flush()

            buffer_units.append(unit)
            buffer_tokens += unit_tokens

        flush()
        return raw_chunks

    @staticmethod
    def _normalize_markdown_heading(unit: TextUnit) -> TextUnit:
        """markdown 的 reader 只产出通用 'block'，这里识别其中的 ATX 标题。"""
        if unit.unit_type == "block":
            first_line = unit.text.splitlines()[0] if unit.text else ""
            m = _MD_HEADING_RE.match(first_line)
            if m:
                return TextUnit(text=unit.text, unit_type="heading", level=len(m.group(1)))
        return unit

    def _split_oversized_unit(self, unit: TextUnit) -> List[RawChunk]:
        logger.warning(
            "单个逻辑单元 (%s) 的 token 数超过块上限 (%d)，执行二次切分。",
            unit.unit_type,
            self.max_chunk_tokens,
        )
        splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.max_chunk_tokens,
            chunk_overlap=0,  # 全局重叠由 OverlapManager 统一叠加，此处不重复处理
            length_function=self._count,
            separators=_SECONDARY_SEPARATORS,
        )
        pieces = splitter.split_text(unit.text)
        return [
            RawChunk(text=piece, token_count=self._count(piece), logical_unit_type=unit.unit_type)
            for piece in pieces
            if piece.strip()
        ]
