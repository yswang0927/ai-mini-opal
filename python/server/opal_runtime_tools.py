# -*- coding: utf-8 -*-
"""
opal_runtime_tools.py
=====================
Opal 执行器运行时工具实现。

区别于 opie_tools.py(那是给"构图 LLM"用来搭建图的工具),
本模块提供的是 agent 节点在**执行阶段**真正调用的运行时工具:

- code-execution: 本地受限 exec 执行 Python 代码,捕获 stdout
- get-webpage:    抓取网页并返回纯文本
- search-web:     调用外部搜索 API(需配置,未配置时返回明确提示)
- memory:         简单的进程内 KV 记忆
- search-internal: 内部检索占位(未接入时返回明确提示)

编译后的 agent prompt 里以占位符声明所需工具,例如:
    {{"type":"tool","path":"code-execution","title":"Code Execution"}}

执行器根据 prompt 中出现的 tool path 调用 build_runtime_tools([...]),
拿到对应的 LangChain StructuredTool 列表并 bind 到 LLM 上。
"""

from __future__ import annotations

import io
import os
import contextlib
import traceback
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field
from langchain_core.tools import StructuredTool


# ---------------------------------------------------------------------------
# code-execution — 本地受限 exec
# ---------------------------------------------------------------------------

# 允许在沙箱里使用的安全内建。刻意不暴露 open / __import__ / eval / exec 等。
_SAFE_BUILTINS: Dict[str, Any] = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "divmod": divmod, "enumerate": enumerate, "filter": filter, "float": float,
    "format": format, "frozenset": frozenset, "int": int, "isinstance": isinstance,
    "len": len, "list": list, "map": map, "max": max, "min": min, "next": next,
    "pow": pow, "print": print, "range": range, "repr": repr, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum,
    "tuple": tuple, "zip": zip, "abs": abs,
}

# 预先导入并允许使用的安全模块。
import math as _math
import statistics as _statistics
import json as _json
import datetime as _datetime
import re as _re
import random as _random

_SAFE_MODULES: Dict[str, Any] = {
    "math": _math,
    "statistics": _statistics,
    "json": _json,
    "datetime": _datetime,
    "re": _re,
    "random": _random,
}

_CODE_EXEC_TIMEOUT_NOTE = (
    "注意:代码在受限环境中运行,仅可使用以下模块 "
    "math, statistics, json, datetime, re, random;"
    "不可访问文件系统、网络或导入其它模块。"
)


class CodeExecutionInput(BaseModel):
    code: str = Field(
        description=(
            "要执行的 Python 代码。通过 print() 输出结果。"
            "可用模块: math, statistics, json, datetime, re, random。"
            "不能访问文件系统 / 网络 / 其它 import。"
        )
    )


def _run_code(code: str) -> str:
    """在受限命名空间中执行代码,捕获 stdout / 异常。"""
    print(f">>> tool_run_code: {code}")
    safe_globals: Dict[str, Any] = {
        "__builtins__": _SAFE_BUILTINS,
        **_SAFE_MODULES,
    }
    stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout):
            exec(code, safe_globals, safe_globals)  # noqa: S102 (受限沙箱)
    except Exception:  # noqa: BLE001 — 把执行错误作为工具结果返回给 LLM
        tb = traceback.format_exc(limit=3)
        out = stdout.getvalue()
        return (
            (f"stdout:\n{out}\n" if out else "")
            + f"执行出错:\n{tb}"
        )

    out = stdout.getvalue()
    if not out.strip():
        return "代码执行成功,但没有任何 print 输出。请用 print() 输出你需要的结果。"
    return out


def _make_code_execution_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_run_code,
        name="code_execution",
        description=(
            "执行 Python 代码并返回其 print 输出,用于精确计算、数据处理等。"
            + _CODE_EXEC_TIMEOUT_NOTE
        ),
        args_schema=CodeExecutionInput,
    )


# ---------------------------------------------------------------------------
# get-webpage — 抓取网页正文
# ---------------------------------------------------------------------------

class GetWebpageInput(BaseModel):
    url: str = Field(description="要抓取的网页 URL(http/https)。")


def _get_webpage(url: str) -> str:
    if not url.lower().startswith(("http://", "https://")):
        return f"无效的 URL: {url}"
    try:
        import urllib.request

        req = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0 (OpalExecutor)"}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
            raw = resp.read(2_000_000)  # 最多 2MB
            charset = resp.headers.get_content_charset() or "utf-8"
            html = raw.decode(charset, errors="replace")
    except Exception as e:  # noqa: BLE001
        return f"抓取网页失败 ({url}): {e}"

    text = _html_to_text(html)
    if len(text) > 12000:
        text = text[:12000] + "\n...[内容已截断]"
    return text or "(网页无可提取的文本内容)"


def _html_to_text(html: str) -> str:
    """极简 HTML -> 文本:去脚本/样式/标签。"""
    html = _re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", html)
    html = _re.sub(r"(?s)<[^>]+>", " ", html)
    import html as _htmlmod

    text = _htmlmod.unescape(html)
    text = _re.sub(r"[ \t\r\f]+", " ", text)
    text = _re.sub(r"\n\s*\n\s*", "\n\n", text)
    return text.strip()


def _make_get_webpage_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_get_webpage,
        name="get_webpage",
        description="抓取指定 URL 网页并返回其纯文本正文内容。",
        args_schema=GetWebpageInput,
    )


# ---------------------------------------------------------------------------
# search-web — 外部搜索(需配置 API)
# ---------------------------------------------------------------------------

class SearchWebInput(BaseModel):
    query: str = Field(description="搜索关键词。")


def _search_web(query: str) -> str:
    """使用 Tavily API(若配置了 TAVILY_API_KEY)执行网络搜索。"""
    print(f">>> tool_search_web: {query}")
    api_key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not api_key:
        return (
            "search-web 工具未配置搜索后端(缺少 TAVILY_API_KEY 环境变量),"
            "无法执行联网搜索。请基于已有知识回答,或提示用户配置搜索 API。"
        )
    try:
        import json as _j
        import urllib.request

        payload = _j.dumps(
            {"api_key": api_key, "query": query, "max_results": 5}
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.tavily.com/search",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
            data = _j.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return f"联网搜索失败: {e}"

    results = data.get("results", [])
    if not results:
        return f"未找到与「{query}」相关的结果。"
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(
            f"{i}. {r.get('title', '')}\n   {r.get('url', '')}\n   {r.get('content', '')}"
        )
    return "\n".join(lines)


def _make_search_web_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_search_web,
        name="search_web",
        description="联网搜索,返回相关网页的标题、URL 与摘要。用于获取实时/外部信息。",
        args_schema=SearchWebInput,
    )


# ---------------------------------------------------------------------------
# memory — 进程内简单记忆
# ---------------------------------------------------------------------------

class MemorySetInput(BaseModel):
    key: str = Field(description="记忆条目的键。")
    value: str = Field(description="要记住的内容。")


class MemoryGetInput(BaseModel):
    key: str = Field(description="要读取的记忆条目键;留空则返回全部记忆。", default="")


def _make_memory_tools(store: Dict[str, str]) -> List[StructuredTool]:
    def _remember(key: str, value: str) -> str:
        store[key] = value
        return f"已记住: {key}"

    def _recall(key: str = "") -> str:
        if not key:
            if not store:
                return "(记忆为空)"
            return "\n".join(f"{k}: {v}" for k, v in store.items())
        return store.get(key, f"(没有找到 key={key} 的记忆)")

    return [
        StructuredTool.from_function(
            func=_remember,
            name="memory_remember",
            description="把一条信息存入记忆,供后续步骤调用。",
            args_schema=MemorySetInput,
        ),
        StructuredTool.from_function(
            func=_recall,
            name="memory_recall",
            description="从记忆中读取信息;不传 key 则返回全部记忆。",
            args_schema=MemoryGetInput,
        ),
    ]


# ---------------------------------------------------------------------------
# read-file / write-file — 按绝对路径读写文件
# ---------------------------------------------------------------------------

# 单个文件读取上限(字节),防止读入超大文件撑爆上下文
_FILE_MAX_BYTES = 1_000_000


class ReadFileInput(BaseModel):
    file_path: str = Field(
        description="要读取的文件的绝对路径(如 /data/foo/report.txt)。"
    )


def _read_file(file_path: str) -> str:
    path = os.path.abspath(os.path.expanduser(file_path))
    if not os.path.isfile(path):
        return f"文件不存在: {file_path}"
    try:
        size = os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(_FILE_MAX_BYTES)
    except Exception as e:  # noqa: BLE001
        return f"读取文件失败 ({file_path}): {e}"
    if size > _FILE_MAX_BYTES:
        content += f"\n...[文件超过 {_FILE_MAX_BYTES} 字节,已截断]"
    return content


class WriteFileInput(BaseModel):
    file_path: str = Field(
        description="要写入的文件的绝对路径(如 /data/foo/report.txt)。父目录会自动创建。"
    )
    content: str = Field(description="要写入文件的文本内容(覆盖写入)。")


def _write_file(file_path: str, content: str) -> str:
    path = os.path.abspath(os.path.expanduser(file_path))
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:  # noqa: BLE001
        return f"写入文件失败 ({file_path}): {e}"
    return f"已写入 {len(content)} 字符到 {file_path}"


def _make_read_file_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_read_file,
        name="read_file",
        description="按绝对路径读取某个文件的文本内容并返回。",
        args_schema=ReadFileInput,
    )


def _make_write_file_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_write_file,
        name="write_file",
        description="按绝对路径把文本内容写入文件(覆盖写入,父目录自动创建)。",
        args_schema=WriteFileInput,
    )


# ---------------------------------------------------------------------------
# search-internal — 内部检索占位
# ---------------------------------------------------------------------------

class SearchInternalInput(BaseModel):
    query: str = Field(description="内部知识库检索关键词。")


def _search_internal(query: str) -> str:
    return (
        "search-internal(内部检索)尚未接入后端知识库,无法返回结果。"
        "请基于已有上下文回答。"
    )


def _make_search_internal_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_search_internal,
        name="search_internal",
        description="检索企业/内部知识库(当前为未接入占位)。",
        args_schema=SearchInternalInput,
    )


# ---------------------------------------------------------------------------
# 工厂:按 tool path 构建运行时工具
# ---------------------------------------------------------------------------

# prompt 占位符里出现的 path -> 构建器。
# 注意 memory 在编译产物中的 path 是 "function-group/use-memory"。
def build_runtime_tools(
    tool_paths: List[str],
    memory_store: Optional[Dict[str, str]] = None,
) -> List[StructuredTool]:
    """根据 agent prompt 中声明的 tool path 列表,构建对应运行时工具。

    未知 / 未支持的 path 会被忽略。
    """
    if memory_store is None:
        memory_store = {}

    tools: List[StructuredTool] = []
    seen: set = set()

    for raw in tool_paths:
        path = (raw or "").strip()
        if path in seen:
            continue
        seen.add(path)

        if path == "code-execution":
            tools.append(_make_code_execution_tool())
        elif path == "get-webpage":
            tools.append(_make_get_webpage_tool())
        elif path == "search-web":
            tools.append(_make_search_web_tool())
        elif path in ("memory", "function-group/use-memory", "use-memory"):
            tools.extend(_make_memory_tools(memory_store))
        elif path in ("search-internal", "search-enterprise"):
            tools.append(_make_search_internal_tool())
        elif path == "read-file":
            tools.append(_make_read_file_tool())
        elif path == "write-file":
            tools.append(_make_write_file_tool())
        # 其它(如 control-flow/routing)由执行器另行处理,这里忽略
    return tools


__all__ = ["build_runtime_tools"]
