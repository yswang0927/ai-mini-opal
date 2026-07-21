"""
DOCX / PPTX 流式读取实现。

两者本质都是 OOXML（zip 容器 + XML 内容）。为避免 python-docx / python-pptx
一次性将整个 XML DOM 加载进内存（对几百 MB 的文档会造成显著内存压力），
这里直接使用 zipfile + lxml.etree.iterparse 做增量式 SAX 风格解析：

- 只在遇到 </w:p>（docx 段落结束）或 </a:t>（pptx 文本运行结束）等结束事件时取出文本；
- 每次处理完一个元素后立即 elem.clear() 并清理其前驱兄弟节点引用，
  释放已解析部分的内存，保证峰值内存与"单个段落/单张幻灯片"的大小成正比，
  而不是与整篇文档大小成正比。
"""

from __future__ import annotations

import re
import zipfile
from typing import Iterator

from lxml import etree

from summarization.exceptions import DocumentReadError
from summarization.readers.base import BaseStreamingReader, TextUnit

from logger import get_logger

logger = get_logger(__name__)

_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"

_HEADING_STYLE_RE = re.compile(r"^Heading(\d*)$", re.IGNORECASE)


def _iterparse_clear(elem: etree._Element) -> None:
    """清空元素内容并移除已处理的前驱兄弟节点，控制内存峰值。"""
    elem.clear()
    while elem.getprevious() is not None:
        del elem.getparent()[0]


class DocxStreamReader(BaseStreamingReader):
    """基于 iterparse 的 .docx 段落级流式读取，识别标题样式作为逻辑单元。"""

    def iter_units(self) -> Iterator[TextUnit]:
        try:
            with zipfile.ZipFile(self.file_path) as zf:
                with zf.open("word/document.xml") as xml_fh:
                    yield from self._iter_paragraphs(xml_fh)
        except (zipfile.BadZipFile, KeyError, etree.XMLSyntaxError) as exc:
            raise DocumentReadError(f"解析 DOCX 失败: {self.file_path}") from exc

    @staticmethod
    def _iter_paragraphs(xml_fh) -> Iterator[TextUnit]:
        context = etree.iterparse(xml_fh, events=("end",), tag=f"{_W_NS}p")
        for _, elem in context:
            style_name = None
            p_pr = elem.find(f"{_W_NS}pPr")
            if p_pr is not None:
                p_style = p_pr.find(f"{_W_NS}pStyle")
                if p_style is not None:
                    style_name = p_style.get(f"{_W_NS}val")

            texts = [t.text or "" for t in elem.findall(f".//{_W_NS}t")]
            paragraph_text = "".join(texts).strip()
            _iterparse_clear(elem)

            if not paragraph_text:
                continue

            level = 0
            unit_type = "paragraph"
            if style_name:
                m = _HEADING_STYLE_RE.match(style_name)
                if m:
                    unit_type = "heading"
                    level = int(m.group(1)) if m.group(1) else 1

            yield TextUnit(text=paragraph_text, unit_type=unit_type, level=level)


class PptxStreamReader(BaseStreamingReader):
    """基于 iterparse 的 .pptx 幻灯片级流式读取：每张幻灯片作为一个逻辑单元。"""

    def iter_units(self) -> Iterator[TextUnit]:
        try:
            with zipfile.ZipFile(self.file_path) as zf:
                slide_names = sorted(
                    (n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                    key=lambda n: int(re.search(r"slide(\d+)\.xml$", n).group(1)),
                )
                for slide_index, slide_name in enumerate(slide_names, start=1):
                    with zf.open(slide_name) as xml_fh:
                        text = self._extract_slide_text(xml_fh)
                    if text:
                        yield TextUnit(text=text, unit_type="slide", level=slide_index)
        except (zipfile.BadZipFile, etree.XMLSyntaxError) as exc:
            raise DocumentReadError(f"解析 PPTX 失败: {self.file_path}") from exc

    @staticmethod
    def _extract_slide_text(xml_fh) -> str:
        pieces: list[str] = []
        context = etree.iterparse(xml_fh, events=("end",), tag=f"{_A_NS}t")
        for _, elem in context:
            if elem.text:
                pieces.append(elem.text)
            _iterparse_clear(elem)
        return "\n".join(pieces).strip()
