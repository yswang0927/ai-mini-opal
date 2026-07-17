# -*- coding: utf-8 -*-
"""
logger.py
=========
公共日志配置模块,供多个 python 文件复用。

用法:
    from logger import get_logger

    logger = get_logger(__name__)
    logger.info("...")

所有日志统一写入当前目录下的 server.log。
"""

from __future__ import annotations

import logging
import os

# 日志文件固定写到本模块所在目录下的 server.log
_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log")

_FORMATTER = logging.Formatter(
    "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)


def get_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """返回一个配置好文件 handler 的 logger。

    重复调用同名 logger 不会重复添加 handler。
    """
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(level)
        file_handler = logging.FileHandler(_LOG_PATH, encoding="utf-8")
        file_handler.setFormatter(_FORMATTER)
        logger.addHandler(file_handler)
    return logger
