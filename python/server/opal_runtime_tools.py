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

from opal_skills import run_skill_script
from logger import get_logger


# ----------------------------------------------
# 日志配置:将工具调用日志写入当前目录下的 server.log
# ----------------------------------------------
logger = get_logger(__name__)


# --------------------------------------------
# code-execution — 本地受限 exec
# --------------------------------------------

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
    logger.info(">>> tool_run_code: %s", code)

    safe_globals: Dict[str, Any] = {
        "__builtins__": _SAFE_BUILTINS,
        **_SAFE_MODULES,
    }

    stdout = io.StringIO()
    try:
        with contextlib.redirect_stdout(stdout):
            exec(code, safe_globals, safe_globals)  # noqa: S102 (受限沙箱)
    except Exception:  # noqa: BLE001 — 把执行错误作为工具结果返回给 LLM
        logger.exception("Tool run code失败: \n%s", code)
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


# --------------------------------------------
# get-webpage — 抓取网页正文
# --------------------------------------------

class GetWebpageInput(BaseModel):
    url: str = Field(description="要抓取的网页 URL(http/https)。")


def _get_webpage(url: str) -> str:
    logger.info(">> tool_get_webpage: %s", url)
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


# --------------------------------------------
# search-web — 外部搜索(需配置 API)
# --------------------------------------------

class SearchWebInput(BaseModel):
    query: str = Field(description="搜索关键词。")


def _search_web(query: str) -> str:
    """使用 Tavily API(若配置了 TAVILY_API_KEY)执行网络搜索。"""
    logger.info(">> tool_search_web: %s", query)
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


# --------------------------------------------
# memory — 进程内简单记忆
# --------------------------------------------

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


# --------------------------------------------
# read-file / write-file — 按绝对路径读写文件
# --------------------------------------------

# 单个文件读取上限(字节),防止读入超大文件撑爆上下文
_FILE_MAX_BYTES = 1_000_000


class ReadFileInput(BaseModel):
    file_path: str = Field(
        description="要读取的文件的绝对路径(如 /data/foo/report.txt)。"
    )


def _read_file(file_path: str) -> str:
    logger.info(">> tool_read_file: %s", file_path)
    path = os.path.abspath(os.path.expanduser(file_path))
    if not os.path.isfile(path):
        logger.error("Tool<read_file>读取的文件不存在: %s", file_path)
        return f"文件不存在: {file_path}"
    try:
        size = os.path.getsize(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(_FILE_MAX_BYTES)
    except Exception as e:  # noqa: BLE001
        logger.exception("Tool<read_file>读取文件失败: %s", file_path)
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
    logger.info(">> tool_write_file: %s \n %s", file_path, content)
    path = os.path.abspath(os.path.expanduser(file_path))
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:  # noqa: BLE001
        logger.exception("Tool<write_file>写文件失败: %s \n%s", file_path, content)
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


# --------------------------------------------
# summarize-document — 长文档端到端摘要
#
# 复用 summarization 模块的 summarize_document():上传文档 ->(估算 + 分块)
# -> 归约(Map-Reduce / Refine)-> 最终摘要。适合超出单次上下文窗口的长文档
# (txt / markdown / docx / pptx / pdf)。
# summarize_document 是 async 的,而执行器以同步方式 tool.invoke(args) 调用工具,
# 因此这里用 _run_coro 把协程驱动到完成再返回字符串。
# --------------------------------------------

class SummarizeDocumentInput(BaseModel):
    file_path: str = Field(
        description="要摘要的文档的绝对路径(支持 txt / markdown / docx / pptx / pdf)。"
    )
    summarization_strategy: str = Field(
        default="map_reduce",
        description=(
            "归约方式:'map_reduce'(并行 Map + 分层 Reduce,延迟低,适合分块数多的场景,默认)"
            "或 'refine'(串行滚动精炼,更适合强调叙事/时间线连贯性的文档)。"
        ),
    )


def _run_coro(coro):
    """把协程驱动到完成并返回结果。

    执行器在同步上下文里调用工具(tool.invoke),正常情况下没有运行中的事件循环,
    直接 asyncio.run 即可;若身处已运行的事件循环(以防未来改为异步执行),则退到
    独立线程里另起事件循环执行,避免 'event loop is already running' 报错。
    """
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is None:
        return asyncio.run(coro)

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


def _summarize_document(file_path: str, summarization_strategy: str = "map_reduce") -> str:
    logger.info(">> tool_summarize_document: %s (strategy=%s)", file_path, summarization_strategy)
    path = os.path.abspath(os.path.expanduser(file_path))
    if not os.path.isfile(path):
        logger.error("Tool<summarize_document>要总结的文件不存在: %s", file_path)
        return f"文档不存在: {file_path}"

    # 延迟导入:service 会拉起 llm_client / langchain / tiktoken 等重依赖,
    # 避免模块导入期的硬依赖(与 llm_client 内的延迟导入约定一致)。
    try:
        from summarization.service import summarize_document
        from summarization.config import SummarizationStrategy
    except Exception as e:  # noqa: BLE001
        logger.exception("summarization module加载失败(import summarization.service,summarization.config)")
        return f"摘要模块加载失败: {e}"

    # 工具边界唯一要做的转换:把 LLM 传入的字符串适配成枚举。
    try:
        strategy = SummarizationStrategy((summarization_strategy or "map_reduce").strip().lower())
    except ValueError:
        logger.error("未知的归约策略: %s ,可选值:'map_reduce' 或 'refine'", summarization_strategy)
        return f"未知的归约策略 '{summarization_strategy}',可选值:'map_reduce' 或 'refine'。"

    # 分块/归约/LLM 全部逻辑都在 service.summarize_document 内,这里只负责:
    # 同步驱动这个 async 接口、并把 SummarizationResult 压成有界字符串。
    try:
        result = _run_coro(summarize_document(path, summarization_strategy=strategy))
    except Exception as e:  # noqa: BLE001
        logger.exception("文档摘要失败: %s", file_path)
        return f"文档摘要失败 ({file_path}): {e}"

    summary = (result.final_summary or "").strip()
    if not summary:
        return f"文档摘要为空({file_path}),可能未成功归约。"

    chunk_count = result.chunking.total_chunks if result.chunking else 0
    return f"[文档摘要 | 策略={strategy.value} | 分块数={chunk_count}]\n{summary}"


def _make_summarize_document_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_summarize_document,
        name="summarize_document",
        description=(
            "对超长文档做端到端摘要:自动分块并归约,返回最终摘要文本。"
            "支持 (txt / markdown / docx / pptx / pdf)。输入文档的绝对路径。"
        ),
        args_schema=SummarizeDocumentInput,
    )


# --------------------------------------------
# search-internal — 内部检索占位
# --------------------------------------------

class SearchInternalInput(BaseModel):
    query: str = Field(description="内部知识库检索关键词。")


def _search_internal(query: str) -> str:
    logger.info(">> tool_search_internal: %s", query)
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


# --------------------------------------------
# run_skill_script — 在声明的 skill 目录内执行脚本(受限)
# --------------------------------------------


class RunSkillScriptInput(BaseModel):
    skill: str = Field(description="要调用的 skill 名称(必须是本节点已声明的 skill)。")
    script: str = Field(
        description=(
            "要执行的脚本路径,相对该 skill 目录(如 'scripts/analyze.py')。"
            "也可直接使用 SKILL.md 里给出的挂载路径(如 "
            "'/mnt/skills/public/<skill>/scripts/analyze.py'),会被自动映射。"
        )
    )
    args: List[str] = Field(
        default_factory=list,
        description="传给脚本的命令行参数列表,如 ['--files', '/tmp/a.xlsx', '--action', 'inspect']。",
    )


def _make_run_skill_script_tool(allowed_skills: List[str]) -> StructuredTool:
    """构建 run_skill_script 工具。allowed_skills 是本 agent 节点声明的 skill 白名单,
    工具只能执行这些 skill 目录内的脚本。"""

    def _run(skill: str, script: str, args: Optional[List[str]] = None) -> str:
        return run_skill_script(
            allowed_skills=allowed_skills,
            skill=skill,
            script=script,
            args=args or [],
        )

    allowed = ", ".join(allowed_skills) if allowed_skills else "(无)"
    return StructuredTool.from_function(
        func=_run,
        name="run_skill_script",
        description=(
            "执行某个已声明 skill 提供的脚本并返回其输出。"
            f"本节点可调用的 skills: {allowed}。"
            "请先阅读注入的 SKILL.md 说明,再按其中的命令与参数调用对应脚本。"
        ),
        args_schema=RunSkillScriptInput,
    )


def build_skill_tools(skill_names: List[str]) -> List[StructuredTool]:
    """为一个 agent 节点声明的 skills 构建运行时工具。

    目前所有 skill 共用同一个受限的 run_skill_script 工具(白名单限定为声明的 skills)。
    若没有声明任何 skill,返回空列表。
    """
    if not skill_names:
        return []
    return [_make_run_skill_script_tool(list(skill_names))]


# --------------------------------------------
# 工厂:按 tool path 构建运行时工具
# --------------------------------------------

# prompt 占位符里出现的 path -> 构建器。
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
        elif path == "read-file":
            tools.append(_make_read_file_tool())
        elif path == "write-file":
            tools.append(_make_write_file_tool())
        elif path == "summarize-document":
            tools.append(_make_summarize_document_tool())
        elif path == "get-webpage":
            tools.append(_make_get_webpage_tool())
        elif path == "search-web":
            tools.append(_make_search_web_tool())
        elif path in ("memory", "use-memory"):
            tools.extend(_make_memory_tools(memory_store))
        elif path in ("search-internal", "search-enterprise"):
            tools.append(_make_search_internal_tool())
        # 其它(如 control-flow/routing)由执行器另行处理,这里忽略
    return tools


__all__ = ["build_runtime_tools", "build_skill_tools"]
