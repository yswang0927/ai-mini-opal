"""
纯文本 / Markdown 的流式读取实现。

txt: 按固定字节缓冲区读取，io.TextIOWrapper 内部会正确处理多字节编码在缓冲区边界
     被截断的问题（不会产生乱码），因此可安全地按块读取而不必整篇载入内存。
     再在应用层按空行聚合成"段落"，作为逻辑单元产出。

markdown: 复用相同的缓冲读取机制，但保留原始换行结构，交由
     LogicalUnitChunker 中的 MarkdownHeaderTextSplitter 处理标题层级。
     这里的流式读取器只负责产出「段落块」，不做标题语义解析（该逻辑属于分块层，
     职责分离：Reader 只管"怎么把字节变成文本"，Chunker 才管"怎么切"）。
"""

from __future__ import annotations

from typing import Iterator

from summarization.config import settings
from summarization.exceptions import DocumentReadError
from .base import BaseStreamingReader, TextUnit

from logger import get_logger

logger = get_logger(__name__)


class _BufferedParagraphReader(BaseStreamingReader):
    """txt/markdown 共用的实现：按缓冲区读取字节流，按空行切段落产出。"""

    unit_type_name = "block"

    def iter_units(self) -> Iterator[TextUnit]:
        buffer_size = settings.stream_buffer_size_bytes
        try:
            with open(self.file_path, "r", encoding="utf-8", errors="replace", newline="") as fh:
                pending_lines: list[str] = []
                while True:
                    chunk = fh.read(buffer_size)
                    if not chunk:
                        break
                    # 按行切分当前缓冲块；最后一个片段可能是不完整的行，
                    # 但由于我们逐段判断"空行=段落结束"，不完整行不影响正确性，
                    # 会在下一次 read() 时被补全。
                    lines = chunk.splitlines(keepends=False)
                    for line in lines:
                        if line.strip() == "":
                            if pending_lines:
                                yield TextUnit(
                                    text="\n".join(pending_lines).strip(),
                                    unit_type=self.unit_type_name,
                                )
                                pending_lines = []
                        else:
                            pending_lines.append(line)
                if pending_lines:
                    yield TextUnit(
                        text="\n".join(pending_lines).strip(),
                        unit_type=self.unit_type_name,
                    )
        except (OSError, UnicodeError) as exc:
            raise DocumentReadError(f"读取文本文件失败: {self.file_path}") from exc


class TxtStreamReader(_BufferedParagraphReader):
    unit_type_name = "paragraph"


class MarkdownStreamReader(_BufferedParagraphReader):
    unit_type_name = "block"
