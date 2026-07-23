# -*- coding: utf-8 -*-
"""
logger.py
=========
公共日志配置模块,供多个 python 文件复用。

用法:
    from logger import get_logger

    logger = get_logger(__name__)
    logger.info("...")

日志统一写入运行时可写数据目录下的 server.log(见 runtime_paths.get_data_dir),
打包成只读的 AppImage 后由 Electron 通过 OPAL_DATA_DIR 指定,源码/测试场景回退到
server 目录。
"""

from __future__ import annotations

import logging

from runtime_paths import get_data_file

# 日志文件写到运行时可写目录下的 server.log
_LOG_PATH = str(get_data_file("server.log"))

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
