"""
流式读取器抽象接口。

设计原则：
1. `iter_units()` 是核心接口，逐个产出 (text, unit_type) —— unit_type 标识逻辑单元类型
   （paragraph/heading/slide/page/block），供后续「逻辑单元分块」直接复用，避免重复解析。
2. 绝不在内存中一次性拼接整篇文档。所有实现必须保证峰值内存与文件大小无强关联
   （docx/pptx 通过 lxml.etree.iterparse 增量解析并及时 clear() 元素；
    pdf 通过逐页解析；txt/markdown 通过固定大小缓冲区读取）。
3. `iter_units()` 每次调用都应重新打开文件、返回全新的生成器（而不是一次性消费的迭代器），
   因为流水线中 Token 估算（第一步）与分块（第二步）需要分别遍历文档一次。
   对于本地磁盘文件，重新打开的 IO 成本远低于将整篇文档常驻内存。
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


@dataclass(frozen=True)
class TextUnit:
    """文档中的一个"逻辑单元"，是流式读取的最小产出单位。"""

    text: str
    unit_type: str  # paragraph / heading / slide / page / block
    # 额外结构信息（如标题层级），供逻辑分块器使用，非必须
    level: int = 0


class BaseStreamingReader(abc.ABC):
    def __init__(self, file_path: str | Path):
        self.file_path = Path(file_path)
        if not self.file_path.exists():
            raise FileNotFoundError(f"文件不存在: {self.file_path}")

    @abc.abstractmethod
    def iter_units(self) -> Iterator[TextUnit]:
        """逐个产出文档的逻辑文本单元。子类必须保证流式、低内存占用。"""
        raise NotImplementedError

    def iter_text(self) -> Iterator[str]:
        """仅需要纯文本流时的便捷方法（如 Token 估算阶段）。"""
        for unit in self.iter_units():
            yield unit.text
