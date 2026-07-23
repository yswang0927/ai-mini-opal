# -*- coding: utf-8 -*-
"""pyc_pack.py —— 把目标目录下的 .py 编译为 sourceless .pyc。

用法:
    python pyc_pack.py <target_dir> [exclude_dirname ...]

行为:
  1. 递归编译 <target_dir> 下所有 .py 为 .pyc(与本解释器版本一致的字节码);
  2. 把 __pycache__/<mod>.cpython-XY.pyc 提升回源文件位置为 <mod>.pyc;
  3. 删除对应的 .py 源文件;
  4. 清理空的 __pycache__ 目录。

exclude_dirname:按「目录名」排除(任意层级),该目录整棵子树保持 .py 明文不动。
典型用于 skills/ —— 运行时以 `python <script>.py` 子进程动态执行,不能编译。

只操作传入目录(即打包产物副本),不应指向仓库源码树。
"""
from __future__ import annotations

import os
import sys
import compileall


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python pyc_pack.py <target_dir> [exclude_dirname ...]", file=sys.stderr)
        return 2

    target = os.path.abspath(sys.argv[1])
    excludes = set(sys.argv[2:])

    if not os.path.isdir(target):
        print(f"[pyc_pack] 目标目录不存在: {target}", file=sys.stderr)
        return 1

    def is_excluded(dirpath: str) -> bool:
        # 路径任意一段命中排除名即视为排除(如 .../server/skills/...)
        parts = os.path.relpath(dirpath, target).split(os.sep)
        return any(p in excludes for p in parts)

    compiled = 0
    removed = 0

    # 第一步:编译。用 compile_file 逐个处理,方便跳过 excludes。
    for dirpath, dirnames, filenames in os.walk(target):
        # 原地裁剪 os.walk,避免进入被排除目录
        dirnames[:] = [d for d in dirnames if d not in excludes]
        if is_excluded(dirpath):
            continue
        if os.path.basename(dirpath) == "__pycache__":
            continue
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            src = os.path.join(dirpath, fn)
            if compileall.compile_file(src, quiet=1, optimize=0):
                compiled += 1
            else:
                print(f"[pyc_pack] 编译失败: {src}", file=sys.stderr)
                return 1

    # 第二步:提升 .pyc 回源位置 + 删 .py + 清 __pycache__
    for dirpath, dirnames, filenames in os.walk(target):
        if os.path.basename(dirpath) != "__pycache__":
            continue
        parent = os.path.dirname(dirpath)
        if is_excluded(parent):
            continue
        for fn in filenames:
            # 形如 <mod>.cpython-312.pyc
            if not fn.endswith(".pyc"):
                continue
            mod = fn.split(".")[0]
            src_py = os.path.join(parent, mod + ".py")
            dst_pyc = os.path.join(parent, mod + ".pyc")
            os.replace(os.path.join(dirpath, fn), dst_pyc)
            if os.path.isfile(src_py):
                os.remove(src_py)
                removed += 1

    # 清理空 __pycache__
    for dirpath, dirnames, filenames in os.walk(target, topdown=False):
        if os.path.basename(dirpath) == "__pycache__":
            try:
                os.rmdir(dirpath)
            except OSError:
                pass

    print(f"[pyc_pack] 编译 {compiled} 个模块,删除 {removed} 个 .py 源文件;"
          f"保留明文目录: {sorted(excludes) or '无'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
