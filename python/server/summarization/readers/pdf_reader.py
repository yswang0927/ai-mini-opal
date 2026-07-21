"""
PDF 流式读取实现。

pypdf.PdfReader 在打开文件时仅解析 xref 表与文档结构（开销与页数弱相关，
不会一次性提取全部文本），真正的文本抽取发生在逐页调用 page.extract_text() 时。
因此按页迭代、每页处理完即释放引用，可以将峰值内存控制在"单页"量级，
而不是整份 PDF 的量级。

局限说明（生产环境需知）：
- 扫描件 / 图片型 PDF 无法通过 extract_text() 得到文本，需要接入 OCR
  （如 Tesseract / 云端 OCR 服务），不在本模块职责范围内，建议在上层
  ReaderFactory 之前做文档类型探测并路由到 OCR 流水线。
- 对于加密 PDF，会抛出 DocumentReadError，上层应提示用户提供密码或预先解密。
"""

from __future__ import annotations

from typing import Iterator

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from summarization.exceptions import DocumentReadError
from summarization.readers.base import BaseStreamingReader, TextUnit

from logger import get_logger

logger = get_logger(__name__)


class PdfStreamReader(BaseStreamingReader):
    def iter_units(self) -> Iterator[TextUnit]:
        try:
            reader = PdfReader(str(self.file_path))
        except (PdfReadError, OSError) as exc:
            raise DocumentReadError(f"打开 PDF 失败: {self.file_path}") from exc

        if reader.is_encrypted:
            # 尝试空密码解密（部分 PDF 仅做了权限限制而非真正加密）
            try:
                reader.decrypt("")
            except Exception as exc:  # noqa: BLE001
                raise DocumentReadError(
                    f"PDF 已加密且无法用空密码解密: {self.file_path}"
                ) from exc

        for page_index, page in enumerate(reader.pages, start=1):
            try:
                text = (page.extract_text() or "").strip()
            except Exception as exc:  # noqa: BLE001  pypdf 对畸形页面可能抛出多种异常
                logger.warning("第 %d 页文本抽取失败，已跳过: %s", page_index, exc)
                continue
            if text:
                yield TextUnit(text=text, unit_type="page", level=page_index)
