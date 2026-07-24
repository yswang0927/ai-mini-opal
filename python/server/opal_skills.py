# -*- coding: utf-8 -*-
"""
opal_skills.py
==============
Agent Skills 发现与调用支持。

`skills/` 目录下每个子目录是一个 Anthropic 风格的 Agent Skill:
    skills/<name>/SKILL.md          —— 带 YAML frontmatter(name/description)的说明书
    skills/<name>/scripts/*.py      —— 该 skill 提供的可执行脚本
    skills/<name>/*.md              —— 其它参考文档(reference.md 等)

本模块被"构图层"和"执行层"共用:
- 构图层(opie_tools/opal_graph)用 discover_skills() / get_skill() 校验节点声明的
  skills 是否存在,并把 skill 的 name/description 暴露给构图 LLM。
- 执行层(opal_executor/opal_runtime_tools)用 load_skill_doc() 把 SKILL.md 正文
  注入 agent 的 system 提示,并用 run_skill_script() 提供一个"只能在 skills/ 目录
  内执行脚本"的受限运行时工具。

安全边界(见 run_skill_script):
- 只能执行 skills/<声明的skill>/ 目录内、且真实存在的脚本文件;
- 不接受任意 shell 命令,只接受"脚本相对路径 + 参数列表";
- 参数以列表形式传给 subprocess(不经过 shell),避免命令注入;
- 有超时和输出大小上限。
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys

import yaml
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Dict, List, Optional
from logger import get_logger

logger = get_logger(__name__)

# skills 根目录:默认取本文件同级的 skills/,可用环境变量覆盖。
SKILLS_ROOT = os.environ.get(
    "OPAL_SKILLS_ROOT",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills"),
)

# SKILL.md 中脚本示例常用的挂载前缀(如 /mnt/skills/public/<name>/scripts/x.py),
# 运行时会被重写成真实的 skills 根目录。
_MOUNT_PREFIXES = (
    "/mnt/skills/public/",
    "/mnt/skills/",
)

# SKILL.md 里 --files / --output-file 等参数示例常用的"用户数据"挂载前缀。
# 这些虚拟目录只存在于 Anthropic 沙箱,本地环境并不存在;LLM 会照着示例把真实
# 路径拼在前缀之后(如 "/mnt/user-data/uploads/E:\\sales.xlsx"),运行时统一剥离,
# 恢复出真实路径。顺序从最长到最短,确保先匹配更具体的前缀。
_DATA_MOUNT_PREFIXES = (
    "/mnt/user-data/uploads/",
    "/mnt/user-data/outputs/",
    "/mnt/user-data/workspace/",
    "/mnt/user-data/",
)

# 单次脚本执行的超时与输出上限。
_SCRIPT_TIMEOUT_SEC = 300
_SCRIPT_OUTPUT_MAX = 20000


@dataclass
class Skill:
    """一个已发现的 skill。"""
    name: str
    description: str
    path: str  # skill 目录的绝对路径
    doc: str = ""  # SKILL.md 去掉 frontmatter 后的正文


def _parse_frontmatter(text: str) -> tuple[Dict[str, str], str]:
    """解析 SKILL.md 顶部的 YAML frontmatter。

    - frontmatter 由首尾两行 '---' 界定;
    - frontmatter 块用 yaml.safe_load 解析,完整支持多行值、引号、列表/嵌套等 YAML 语法;
    - 返回的字段字典里,标量值统一转成字符串(name/description 均按字符串使用)。

    返回 (字段字典, frontmatter 之后的正文)。无 frontmatter 或解析失败时字段为空、正文原样返回。
    """
    if not text.startswith("---"):
        return {}, text

    # 用首尾两行 '---' 界定 frontmatter,分离出 frontmatter 块与其后的正文。
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text

    body_fm, body_rest = m.group(1), m.group(2)
    try:
        data = yaml.safe_load(body_fm)
    except yaml.YAMLError:
        logger.exception("解析SKILL.md frontmatter失败")
        return {}, body_rest.lstrip("\n")

    fields: Dict[str, str] = {}
    if isinstance(data, dict):
        for key, val in data.items():
            if val is None:
                continue
            fields[str(key)] = val if isinstance(val, str) else str(val)
    return fields, body_rest.lstrip("\n")


@lru_cache(maxsize=1)
def _discover_cached(root: str, mtime_key: float) -> Dict[str, Skill]:
    """真正的发现逻辑,按 (root, 目录 mtime) 缓存。"""
    skills: Dict[str, Skill] = {}
    if not os.path.isdir(root):
        return skills

    for entry in sorted(os.listdir(root)):
        skill_dir = os.path.join(root, entry)
        skill_md = os.path.join(skill_dir, "SKILL.md")
        if not os.path.isfile(skill_md):
            continue
        try:
            with open(skill_md, "r", encoding="utf-8", errors="replace") as f:
                raw = f.read()
        except OSError:
            logger.exception("读取SKILL.md文件失败: %s", skill_md)
            continue

        fields, doc = _parse_frontmatter(raw)
        name = fields.get("name") or entry
        skills[name] = Skill(
            name=name,
            description=fields.get("description", ""),
            path=skill_dir,
            doc=doc,
        )
    return skills


def discover_skills(root: Optional[str] = None) -> Dict[str, Skill]:
    """发现 skills 根目录下所有可用的 skill,返回 {name: Skill}。
    结果按目录 mtime 缓存,skills 目录变动后会自动失效重扫。
    """
    root = root or SKILLS_ROOT
    try:
        mtime_key = os.path.getmtime(root) if os.path.isdir(root) else 0.0
    except OSError:
        mtime_key = 0.0
    return _discover_cached(root, mtime_key)


def get_skill(name: str, root: Optional[str] = None) -> Optional[Skill]:
    """按名称取单个 skill,不存在返回 None。"""
    return discover_skills(root).get(name)


def list_skill_names(root: Optional[str] = None) -> List[str]:
    """返回所有可用 skill 名称(已排序)。"""
    return sorted(discover_skills(root).keys())


def load_skill_doc(name: str, root: Optional[str] = None) -> str:
    """返回某个 skill 的 SKILL.md 正文(不含 frontmatter);不存在返回空串。"""
    skill = get_skill(name, root)
    return skill.doc if skill else ""


# ---------------------------------------------------------------------------
# 脚本路径解析 — 把 SKILL.md 示例里的挂载前缀重写成真实目录,并锁定在 skills/ 内
# ---------------------------------------------------------------------------

def _resolve_script_path(
    allowed_skills: List[str], skill: str, script: str, root: str
) -> tuple[Optional[str], Optional[str]]:
    """把 (skill, script) 解析为一个真实且合法的脚本绝对路径。

    合法性要求:
    - skill 必须在本节点声明的 allowed_skills 白名单内且真实存在;
    - script 可以是相对 skill 目录的路径(如 'scripts/analyze.py'),也可以是
      SKILL.md 里出现的挂载路径(如 '/mnt/skills/public/data-analysis/scripts/analyze.py'),
      后者会被重写;
    - 解析后的真实路径必须仍位于该 skill 目录内(防止 ../ 逃逸);
    - 目标必须是真实存在的文件。

    返回 (绝对路径, None) 或 (None, 错误信息)。
    """
    if skill not in allowed_skills:
        logger.warning("调用了无效的SKILL: %s", skill)
        return None, (
            f"Skill '{skill}' is not declared in this node and cannot be invoked. "
            f"Available skills for this node: {allowed_skills or '(none)'}"
        )
    sk = get_skill(skill, root)
    if not sk:
        logger.warning("Skill< %s >不存在", skill)
        return None, f"Skill '{skill}' does not exist. Available skills: {list_skill_names(root)}"

    rel = script.strip()
    # 去掉挂载前缀:/mnt/skills/public/<name>/scripts/x.py -> scripts/x.py
    for prefix in _MOUNT_PREFIXES:
        if rel.startswith(prefix):
            tail = rel[len(prefix):]
            # tail 形如 <name>/scripts/x.py,剥掉开头的 <name>/
            parts = tail.split("/", 1)
            rel = parts[1] if len(parts) == 2 else tail
            break
    # 绝对路径(非挂载前缀)一律拒绝,必须相对 skill 目录
    if os.path.isabs(rel):
        return None, f"Script path must be relative to the skill directory, received absolute path: {script}"

    candidate = os.path.normpath(os.path.join(sk.path, rel))
    skill_root = os.path.normpath(sk.path)
    if os.path.commonpath([candidate, skill_root]) != skill_root:
        return None, f"Script path is out of bounds (escaped the skill directory): {script}"
    if not os.path.isfile(candidate):
        return None, f"Script does not exist: {skill}/{rel}"
    return candidate, None


def _strip_data_mount_prefix(arg: str) -> str:
    """剥离参数里残留的"用户数据"挂载前缀,恢复真实路径。

    LLM 依照 SKILL.md 示例常把真实路径拼到虚拟前缀之后,例如:
        "/mnt/user-data/uploads/E:\\sales.xlsx" -> "E:\\sales.xlsx"
        "/mnt/user-data/uploads/report.csv"     -> "report.csv"
    仅处理以这些前缀开头的字符串;其余参数原样返回。
    """
    for prefix in _DATA_MOUNT_PREFIXES:
        if arg.startswith(prefix):
            return arg[len(prefix):]
    return arg


def run_skill_script(
    allowed_skills: List[str],
    skill: str,
    script: str,
    args: Optional[List[str]] = None,
    root: Optional[str] = None,
) -> str:
    """在受限边界内执行某个 skill 的脚本,返回其 stdout/stderr。

    这是执行层 run_skill_script 运行时工具的底层实现。安全约束:
    - 只能执行 allowed_skills 白名单内 skill 的、真实存在的脚本;
    - args 以列表形式传给 subprocess(不经过 shell),规避命令注入;
    - .py 脚本用当前 Python 解释器执行,其它可执行文件直接执行;
    - 有超时与输出大小上限。
    """
    root = root or SKILLS_ROOT
    # 剥离 LLM 依照 SKILL.md 示例拼在真实路径前的虚拟数据挂载前缀。
    args = [_strip_data_mount_prefix(a) for a in (args or [])]

    path, err = _resolve_script_path(allowed_skills, skill, script, root)
    if err:
        logger.error("[Skill invocation rejected]: %s", err)
        return f"[Skill invocation rejected] {err}"

    if path.endswith(".py"):
        cmd = [sys.executable, path, *args]
    else:
        cmd = [path, *args]

    logger.info(f">>> run_skill_script: %s -> %s", skill, shlex.join(cmd))

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=_SCRIPT_TIMEOUT_SEC,
            cwd=os.path.dirname(path),
        )
    except subprocess.TimeoutExpired:
        logger.exception("Skill脚本执行超时: %s/%s", skill, script)
        return f"[Script execution timeout (>{_SCRIPT_TIMEOUT_SEC}s)] {skill}/{script}"
    except Exception as e:  # noqa: BLE001 — 作为工具结果回传给 LLM
        logger.exception("Skill脚本执行失败: %s/%s", skill, script)
        return f"[Script execution failed] {skill}/{script}: {e}"

    out = (proc.stdout or "").strip()
    errout = (proc.stderr or "").strip()
    segments = []
    if out:
        segments.append(f"stdout:\n{out}")
    if errout:
        logger.error("Skill脚本< %s/%s >执行输出错误: %s", skill, script, errout)
        segments.append(f"stderr:\n{errout}")
    if proc.returncode != 0:
        segments.append(f"(exit code: {proc.returncode})")
    result = "\n\n".join(segments) or "(Script executed successfully with no output)"

    if len(result) > _SCRIPT_OUTPUT_MAX:
        result = result[:_SCRIPT_OUTPUT_MAX] + "\n...[output truncated]"
    return result


__all__ = [
    "Skill",
    "SKILLS_ROOT",
    "discover_skills",
    "get_skill",
    "list_skill_names",
    "load_skill_doc",
    "run_skill_script",
]
