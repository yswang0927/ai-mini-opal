# -*- coding: utf-8 -*-
"""
runtime_paths.py
================
统一解析「运行时可写目录」。

打包成 Electron AppImage 后,程序被挂载到只读文件系统(如 /tmp/.mount_xxx/),
安装目录不可写,因此日志、session 等运行时产物不能再写到 server 目录里。

约定:Electron 主进程启动 python 子进程时,通过环境变量 OPAL_DATA_DIR 传入一个
可写目录(通常是 app.getPath('userData'))。python 侧所有运行时写入都落到这里。
若该变量未设置(直接跑源码 / 单元测试等场景),回退到 server 目录,保持旧行为。
"""

from __future__ import annotations

import os
from pathlib import Path

# 环境变量名:由 Electron 主进程注入
_ENV_DATA_DIR = "OPAL_DATA_DIR"

# 回退基准:本模块(即 server 目录)所在位置
_SERVER_DIR = Path(__file__).resolve().parent


def get_data_dir() -> Path:
    """返回运行时可写的数据根目录,确保其存在。

    优先取环境变量 OPAL_DATA_DIR(打包环境由 Electron 注入),
    未设置时回退到 server 目录(源码 / 测试场景)。
    """
    env_value = os.environ.get(_ENV_DATA_DIR, "").strip()
    base = Path(env_value).expanduser() if env_value else _SERVER_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_data_subdir(name: str) -> Path:
    """返回可写数据目录下的子目录,确保其存在。"""
    sub = get_data_dir() / name
    sub.mkdir(parents=True, exist_ok=True)
    return sub


def get_data_file(name: str) -> Path:
    """返回可写数据目录下的文件路径(父目录已确保存在)。"""
    return get_data_dir() / name
