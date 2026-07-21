"""根据文件后缀名选择对应的流式读取器实现。"""

from __future__ import annotations

from pathlib import Path

from summarization.config import DocumentFormat
from .base import BaseStreamingReader
from .office_readers import DocxStreamReader, PptxStreamReader
from .pdf_reader import PdfStreamReader
from .text_readers import MarkdownStreamReader, TxtStreamReader

_READER_REGISTRY: dict[DocumentFormat, type[BaseStreamingReader]] = {
    DocumentFormat.TXT: TxtStreamReader,
    DocumentFormat.MARKDOWN: MarkdownStreamReader,
    DocumentFormat.DOCX: DocxStreamReader,
    DocumentFormat.PPTX: PptxStreamReader,
    DocumentFormat.PDF: PdfStreamReader,
}


class ReaderFactory:
    @staticmethod
    def get_reader(file_path: str | Path) -> BaseStreamingReader:
        path = Path(file_path)
        doc_format = DocumentFormat.from_suffix(path.suffix)
        reader_cls = _READER_REGISTRY[doc_format]
        return reader_cls(path)

    @staticmethod
    def detect_format(file_path: str | Path) -> DocumentFormat:
        return DocumentFormat.from_suffix(Path(file_path).suffix)
