# -*- coding: utf-8 -*-
"""
opal_graph.py
=============
Opie 图状态管理 + 后端编译器。

这个模块不涉及任何 LLM / LangChain 逻辑,是纯粹的状态机 + 编译器:
- OpalGraphState 维护当前图的内存表示(节点、连线)。
- compile_to_opal_json() 把内存表示编译成与 Google Opal 实际导出格式
  对齐的 JSON 结构(embed:// URI、坐标、config$prompt 拼接、
  b-system-instruction 固定模板等实现细节都在这里落地)。

设计对应关系(见设计文档 opie-tool-schema-design.md):
- 2.2 create_input_step  -> add_input_step()
- 2.3 create_agent_step  -> add_agent_step()
- 2.4 create_render_step -> add_render_step()
- 2.5 edit_step          -> edit_step()
- 2.6 remove_step        -> remove_step()
- 2.7 manage_connection  -> add_parent()/remove_parent()/add_route()/remove_route()
- 2.8 set_graph_metadata -> set_metadata()
- 6.1 render系统指令固定模板 -> RENDER_SYSTEM_INSTRUCTION 常量
- 6.3 媒体连线校验 -> validate_render_media_parents()

【版本历史 / 假设边界】
v1: 只有 BMI 一份样本,tools/chat/memory/routes 字段完全靠猜测占位。

v3: 补充了 5 份真实 Opal 导出样本,修正了两处明确错误(tools是inline占位符;
render节点的system-instruction是服务端默认值不应写入)。

v4(当前版本): 补充了一份官方"全节点/全资产/全工具"kitchen-sink测试样本,
带来三处重大修正:
  1. **routing 的真实机制被证实,此前的实现完全错误**——路由不是独立的
     `<a>`/route边体系,而是复用 tool 占位符:
     {{"type":"tool","path":"control-flow/routing","instance":"<目标step_id>","title":"<目标节点标题>"}}
     对应的 edge 的 out 字段值是目标节点 id 本身,不是字符串 "route"。
  2. **新增 Assets(资产)体系**——graph级别的资源池(上传文件/Google Doc/
     YouTube链接/纯文本/手绘),节点通过 {{"type":"asset","path":"<asset_id>",
     "mimeType":"...","title":"..."}} 占位符引用。此前完全没建模。
  3. search-maps / code-execution 两个工具的 path 被验证命中此前的推测;
     新确认 input 节点的 p-required 字段、render 节点的 p-render-mode
     还有 "Manual layout" 这个取值。

仍然是推断、未被样本直接证实的部分(标注在对应代码位置):
  - generation-capabilities / p-aspect-ratio 等图像生成相关字段(仅1个样本)
  - config$list 字段的确切语义(仅1个样本)
  - get-weather / search-internal / search-enterprise 三个工具的 path
    (按已确认工具的命名风格类推,尚未见到真实样本)
  - 多路由(3个以上分支)场景下 routing 占位符的排列方式(目前只见过单路由样本)

拿到更多真实样本或官方 schema 后,优先核实上面这几项。
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# 常量:embed:// URI 映射(来自真实 Opal 导出样本)
# ---------------------------------------------------------------------------

EMBED_URI_INPUT = "embed://a2/a2.bgl.json#module:user-inputs"
EMBED_URI_AGENT = "embed://a2/generate.bgl.json#module:main"
EMBED_URI_RENDER = "embed://a2/a2.bgl.json#module:render-outputs"

# ---------------------------------------------------------------------------
# 常量:工具 path 映射表(基于多份真实样本修正)
#
# 【修正说明 v3】之前版本假设工具是通过 configuration 里一个独立字段挂载的
# (如 attached-tools),这是错的。真实机制是:工具引用是 inline 写在
# config$prompt 文本里的占位符,格式统一为:
#     {{"type":"tool","path":"<TOOL_PATH>","title":"<Display Title>"}}
# 但 <TOOL_PATH> 的命名空间在不同工具之间并不一致 —— search-web/get-webpage
# 用 embed://a2/tools.bgl.json#module:X 这种路径,而 memory 用完全不同的
# function-group/use-memory。下表只有 search-web / get-webpage / memory
# 三项是从真实样本里直接观察到的,其余是按前者的命名风格类推的占位猜测,
# 用 confirmed=False 标注,接入真实后端前建议单独验证。
# ---------------------------------------------------------------------------

TOOL_PATH_MAP: Dict[str, Dict[str, Any]] = {
    "search-web": {
        "path": "embed://a2/tools.bgl.json#module:search-web",
        "display_title": "Search Web",
        "confirmed": True,
    },
    "get-webpage": {
        "path": "embed://a2/tools.bgl.json#module:get-webpage",
        "display_title": "Get Webpage",
        "confirmed": True,
    },
    "memory": {
        "path": "function-group/use-memory",
        "display_title": "Use Memory",
        "confirmed": True,
    },
    "search-maps": {
        "path": "embed://a2/tools.bgl.json#module:search-maps",
        "display_title": "Search Maps",
        "confirmed": True,  # v4确认
    },
    "code-execution": {
        "path": "embed://a2/tools.bgl.json#module:code-execution",
        "display_title": "Code Execution",
        "confirmed": True,  # v4确认
    },
    "get-weather": {
        "path": "embed://a2/tools.bgl.json#module:get-weather",
        "display_title": "Get Weather",
        "confirmed": False,
    },
    "search-internal": {
        "path": "embed://a2/tools.bgl.json#module:search-internal",
        "display_title": "Search Internal",
        "confirmed": False,
    },
    "search-enterprise": {
        "path": "embed://a2/tools.bgl.json#module:search-enterprise",
        "display_title": "Search Enterprise",
        "confirmed": False,
    },
}

# ---------------------------------------------------------------------------
# 常量:routing 的特殊 tool path(v4新增,来自kitchen-sink样本,已确认)
#
# 路由不是独立的标签/边体系,而是复用了 tool 占位符机制,只是多了一个
# "instance" 字段指向目标节点的 step_id:
#     {{"type":"tool","path":"control-flow/routing","instance":"<目标step_id>","title":"<目标节点标题>"}}
# 对应的 edge 里,out 字段的值是目标节点 id 本身(不是 "context" 也不是
# 我们此前瞎猜的 "route")。
# ---------------------------------------------------------------------------

ROUTING_TOOL_PATH = "control-flow/routing"

# ---------------------------------------------------------------------------
# 常量:agent 节点的"terse 模式"系统指令
#
# 【新增 v3】在 3 个不同真实样本(2 个不同 flow)中,3 个agent节点
# 一字不差地使用了同一段 b-system-instruction 文本,证明这是一个可复用的
# 预设开关,而不是自由文本。用于"这个节点的输出是喂给下一个节点的,
# 不需要对话式的寒暄"这种场景。
# ---------------------------------------------------------------------------

AGENT_TERSE_SYSTEM_INSTRUCTION = (
    "You are working as part of an AI system, so no chit-chat and no "
    "explaining what you're doing and why.\n"
    "DO NOT start with \"Okay\", or \"Alright\" or any preambles. Just the "
    "output, please."
)

# ---------------------------------------------------------------------------
# 【修正说明 v3】render 节点的巨型 system-instruction 不再写入编译后的 JSON。
#
# 证据:同一个 render-outputs 节点在不同样本里,b-system-instruction 呈现
# 三种状态——完整填充(仅出现在 userModified=true 的节点上)、空字符串
# (userModified=false)、或字段整个不存在(同样 userModified=false)。
# 这说明这段巨型指令是【服务端默认值】,只有当节点被显式修改过
# (userModified=true)时,解析后的完整文本才会被回写进图 JSON。
# 我们的编译器默认场景下不应该写入这段文本,而是把它留空/省略,
# 交由服务端在运行时应用默认值。
#
# 这段文本仍然作为下面的常量保留 —— 不是为了写入 JSON,而是作为
# Opie 撰写 design_brief 时应当遵守的约束的【文档依据】(见
# create_render_step 里 design_brief 参数说明中对 footer/媒体的限制,
# 均来自这段文本)。
# ---------------------------------------------------------------------------

RENDER_SERVER_DEFAULT_INSTRUCTION_REFERENCE = """You are an AI Web Developer. Your task is to generate a single, self-contained HTML document for rendering in an iframe, based on user instructions and data.

**Visual aesthetic:**
    * Aesthetics are crucial. Make the page look amazing, especially on mobile.
    * Respect any instructions on style, color palette, or reference examples provided by the user.
    * **CRITICAL: Aim for premium, state-of-the-art designs. Avoid simple minimum viable products.**
    * **Use Rich Aesthetics**: The USER should be wowed at first glance by the design. Use best practices in modern web design (e.g. vibrant colors, dark modes, glassmorphism, and dynamic animations) to create a stunning first impression. Failure to do this is UNACCEPTABLE.
    * **Prioritize Visual Excellence**: Implement designs that will WOW the user and feel extremely premium:
        - Avoid generic colors (plain red, blue, green). Use curated, harmonious color palettes (e.g., HSL tailored colors, sleek dark modes).
        - Using modern typography (e.g., from Google Fonts like Inter, Roboto, or Outfit) instead of browser defaults.
        - Use smooth gradients.
        - Add subtle micro-animations for enhanced user experience.
    * **Use a Dynamic Design**: An interface that feels responsive and alive encourages interaction. Achieve this with hover effects and interactive elements. Micro-animations, in particular, are highly effective for improving user engagement.
    * **Thematic Specificity**: Do not just create a generic layout. Define a clear "vibe" or theme based on the content. Use specific aesthetic keywords (e.g., "Glassmorphism", "Neobrutalism", "Minimalist", "Comic Book Style") to guide the design.
    * **Typography Hierarchy**: Explicitly import and use font pairings. Use a distinct Display Font for headers and a highly readable Body Font for text.
    * **Readability**: Pay extra attention to readability. Ensure the text is always readable with sufficient contrast against the background. Choose fonts and colors that enhance legibility.

**Design and Functionality:**
    * **Component-Based Design**: Do not just dump text into blocks. Semanticize the content into distinct UI components.
    * **Layout Dynamics**: Break the grid. Avoid strict, identical grid columns. Use asymmetrical layouts, Bento grids, or responsive flexbox layouts where some elements span full width to create visual interest and emphasize key content.
    * **Tailwind Configuration**: Extend the Tailwind configuration within a `<script>` block to define custom font families and color palettes that match the theme.
    * Thoroughly analyze the user's instructions to determine the desired type of webpage, application, or visualization. What are the key features, layouts, or functionality?
    * Analyze any provided data to identify the most compelling layout or visualization of it. For example, if the user requests a visualization, select an appropriate chart type (bar, line, pie, scatter, etc.) to create the most insightful and visually compelling representation. Or if user instructions say `use a carousel format`, you should consider how to break the content and any media into different card components to display within the carousel.
    * If requirements are underspecified, make reasonable assumptions to complete the design and functionality. Your goal is to deliver a working product with no placeholder content.
    * Ensure the generated code is valid and functional. Return only the code, and open the HTML codeblock with the literal string "```html".
    * The output must be a complete and valid HTML document with no placeholder content for the developer to fill in.

**Libraries:**
  Unless otherwise specified, use:
    * Tailwind for CSS
    * **CRITICAL: Use the Tailwind CDN from `https://cdn.tailwindcss.com`. Do NOT use `tailwind.min.css` or any other local Tailwind file. Always include Tailwind using: `<script src="https://cdn.tailwindcss.com"></script>`**

**Constraints:**
  * **External Links:** You ARE allowed to generate external links (`<a href="...">` and `window.open(...)`) to external websites (e.g. google.com, wikipedia.org) for user navigation.
  * **NO External Embeds:** Do NOT embed any external resources (e.g. `<script src="...">`, `<img src="...">`, `<iframe src="...">`, `<link href="...">`) from external URLs. Content Security Policy (CSP) will block them.
  * **Media Restriction:** ONLY use media URLs that are explicitly passed in the input. Do NOT generate or hallucinate any other media URLs (e.g. from placeholder sites or external CDNs).
  * **Render All Media:** You MUST render ALL media (images, videos, audio) that are passed in. Do NOT skip or omit any provided media items. Every passed-in media URL must appear in the final HTML output.
  * **Navigation Restriction:** Do NOT generate unneeded fake links or buttons to sub-pages (e.g. "About", "Contact", "Learn More") unless explicitly requested. Stick to the plan and the provided content.
  * **Footer Restriction:** **NEVER** generate any footer content, including legal footers like "All rights reserved" or "Copyright 2024". [It is a violation of Google's policies to hallucinate legal footers.]
"""

# 判断 design_brief 是否"提到展示媒体"的启发式关键词(6.3节校验用)
_MEDIA_KEYWORDS = [
    "图片", "图像", "照片", "插画", "海报", "image", "photo", "picture",
    "视频", "video", "音频", "audio", "语音", "配音", "music", "音乐",
]

_MEDIA_CAPABILITIES = {"image", "video", "speech", "music"}

# ---------------------------------------------------------------------------
# v4新增:Assets(资产)体系
#
# 来自 kitchen-sink 样本的顶层 "assets" 字典,是独立于 nodes/edges 的
# graph级资源池。节点通过 {{"type":"asset","path":"<asset_id>",
# "mimeType":"...","title":"..."}} 占位符引用某个资产。样本里观察到
# 5 种资产形态,对应下面的 AssetKind 枚举:
#
#   - uploaded_file  : type=file, managed=true,  parts=[{storedData:{handle,mimeType,contentLength}}]
#   - google_drive_doc: type=content, managed=false, subType=gdrive,  parts=[{storedData:{handle,mimeType}}] (无contentLength)
#   - youtube_video   : type=content, subType=youtube, parts=[{fileData:{fileUri,mimeType}}]
#   - inline_text     : type=content, parts=[{text:...}]
#   - drawing         : type=content, subType=drawable, parts=[{storedData:{handle,mimeType,contentLength}}]
#
# 【重要边界声明】我们的工具调用架构里,Opie 没有真正"上传文件"的能力
# (拿不到 Google Drive handle、算不出 contentLength)。register_asset()
# 因此设计成"登记一个已经存在的资产引用"——真实产品里,这通常应该由
# 宿主 App 在用户实际上传文件/粘贴链接后调用(不一定经过 Opie 的 LLM
# 决策),Opie 主要消费 graph_get_overview 里已登记的资产列表,并把它们
# 挂到某个节点上。我们仍然把 register_asset 暴露成一个工具,方便端到端
# 测试和"用户口头描述一个已知外部资源(如YouTube链接)"这种场景。
# ---------------------------------------------------------------------------

class AssetKind(str, Enum):
    UPLOADED_FILE = "uploaded_file"
    GOOGLE_DRIVE_DOC = "google_drive_doc"
    YOUTUBE_VIDEO = "youtube_video"
    INLINE_TEXT = "inline_text"
    DRAWING = "drawing"


# 图片/视频/音频类 mimeType 前缀,用于6.3节媒体校验时把"资产提供的媒体"
# 也算作合法来源(不只是agent生成的媒体节点才算数)。
_MEDIA_MIME_PREFIXES = ("image/", "video/", "audio/")


@dataclass
class Asset:
    asset_id: str
    title: str
    kind: AssetKind
    mime_type: Optional[str] = None
    drive_handle: Optional[str] = None
    file_uri: Optional[str] = None
    text_content: Optional[str] = None


class GraphValidationError(Exception):
    """工具层校验失败时抛出,message 会原样返回给 LLM 作为工具结果。"""


class StepType(str, Enum):
    INPUT = "input"
    AGENT = "agent"
    RENDER = "render"


def _slugify(title: str) -> str:
    """把标题转成用于生成 step_id 的 slug(仅内部使用,不面向用户/LLM)。"""
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", title.strip().lower()).strip("_")
    return slug or "step"


def _short_hash() -> str:
    return uuid.uuid4().hex[:6]


@dataclass
class Step:
    step_id: str
    title: str
    step_type: StepType
    created_at: float = field(default_factory=time.time)

    # --- input 专属 ---
    question_text: Optional[str] = None
    modality: str = "Any"
    required: bool = True  # v4新增:对应 p-required,默认必填(样本里显式设false才是可选)

    # --- agent 专属 ---
    prompt: Optional[str] = None
    expected_output: Optional[str] = None
    expected_output_is_list: bool = False  # v3新增:对应 metadata.expected_output[].list
    tools: List[str] = field(default_factory=list)
    generation_capabilities: List[str] = field(default_factory=lambda: ["text"])
    enable_chat: bool = False
    enable_memory: bool = False
    terse_mode: bool = False  # v3新增:对应 AGENT_TERSE_SYSTEM_INSTRUCTION 开关
    image_aspect_ratio: Optional[str] = None  # v3新增:仅当 generation_capabilities 含 image 时有意义

    # --- render 专属 ---
    design_brief: Optional[str] = None
    render_mode: str = "Auto"  # v4新增:对应 p-render-mode,可选 "Auto" / "Manual layout"

    # --- 通用 ---
    user_modified: bool = False  # v3新增:新建默认False,edit_step后置True(见 6.1 节修正)
    parents: List[str] = field(default_factory=list)          # 数据依赖父节点
    routes: List[Dict[str, str]] = field(default_factory=list)  # [{"target_step_id":..,"label":..}]
    asset_ids: List[str] = field(default_factory=list)  # v4新增:引用的资产id列表(agent/render节点均可用)


class OpalGraphState:
    """
    维护单个 opal 图的内存状态,并提供编译为最终 Opal JSON 的能力。
    一个用户会话 = 一个 OpalGraphState 实例。
    """

    def __init__(self) -> None:
        self.steps: Dict[str, Step] = {}
        self.assets: Dict[str, Asset] = {}
        self.title: str = "Untitled Opal"
        self.description: str = ""
        self.tags: List[str] = []

    # ------------------------------------------------------------------
    # 只读:overview
    # ------------------------------------------------------------------
    def get_overview(self) -> Dict[str, Any]:
        nodes = []
        for s in self.steps.values():
            entry: Dict[str, Any] = {
                "step_id": s.step_id,
                "title": s.title,
                "step_type": s.step_type.value,
                "parents": list(s.parents),
            }
            if s.step_type == StepType.AGENT:
                entry["prompt_preview"] = (s.prompt or "")[:80]
                entry["tools"] = list(s.tools)
                entry["enable_chat"] = s.enable_chat
                entry["enable_memory"] = s.enable_memory
                entry["routes"] = list(s.routes)
                entry["asset_ids"] = list(s.asset_ids)
            elif s.step_type == StepType.RENDER:
                entry["asset_ids"] = list(s.asset_ids)
            nodes.append(entry)

        edges = []
        for s in self.steps.values():
            for p in s.parents:
                edges.append({"from": p, "to": s.step_id, "relation": "parent"})
            for r in s.routes:
                edges.append({
                    "from": s.step_id,
                    "to": r["target_step_id"],
                    "relation": "route",
                    "label": r.get("label", ""),
                })

        assets = [
            {"asset_id": a.asset_id, "title": a.title, "kind": a.kind.value, "mime_type": a.mime_type}
            for a in self.assets.values()
        ]

        return {
            "graph_title": self.title,
            "graph_description": self.description,
            "nodes": nodes,
            "edges": edges,
            "assets": assets,
        }

    # ------------------------------------------------------------------
    # 元数据
    # ------------------------------------------------------------------
    def set_metadata(
        self,
        title: Optional[str] = None,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        if title is not None:
            self.title = title
        if description is not None:
            self.description = description
        if tags is not None:
            self.tags = tags
        return {"title": self.title, "description": self.description, "tags": self.tags}

    # ------------------------------------------------------------------
    # 资产(Assets)
    # ------------------------------------------------------------------
    def register_asset(
        self,
        title: str,
        kind: str,
        mime_type: Optional[str] = None,
        drive_handle: Optional[str] = None,
        file_uri: Optional[str] = None,
        text_content: Optional[str] = None,
    ) -> Asset:
        """
        登记一个资产引用(见文件顶部【重要边界声明】—— 这不是真正的文件上传,
        而是把一个已经存在的资源"告知"图状态,使其可以被节点引用)。
        """
        try:
            kind_enum = AssetKind(kind)
        except ValueError:
            raise GraphValidationError(
                f"未知的 asset kind='{kind}'。可用取值: {[k.value for k in AssetKind]}"
            )

        if kind_enum == AssetKind.UPLOADED_FILE and not drive_handle:
            raise GraphValidationError("kind='uploaded_file' 时必须提供 drive_handle。")
        if kind_enum == AssetKind.GOOGLE_DRIVE_DOC and not drive_handle:
            raise GraphValidationError("kind='google_drive_doc' 时必须提供 drive_handle。")
        if kind_enum == AssetKind.YOUTUBE_VIDEO and not file_uri:
            raise GraphValidationError("kind='youtube_video' 时必须提供 file_uri。")
        if kind_enum == AssetKind.INLINE_TEXT and not text_content:
            raise GraphValidationError("kind='inline_text' 时必须提供 text_content。")
        if kind_enum == AssetKind.DRAWING and not drive_handle:
            raise GraphValidationError("kind='drawing' 时必须提供 drive_handle。")

        asset_id = str(uuid.uuid4())
        asset = Asset(
            asset_id=asset_id,
            title=title,
            kind=kind_enum,
            mime_type=mime_type,
            drive_handle=drive_handle,
            file_uri=file_uri,
            text_content=text_content,
        )
        self.assets[asset_id] = asset
        return asset

    def _require_asset(self, asset_id: str) -> Asset:
        if asset_id not in self.assets:
            raise GraphValidationError(
                f"未找到 asset_id='{asset_id}' 对应的资产。请先调用 graph_get_overview "
                f"确认已登记的资产列表,或先调用 register_asset 登记该资产。"
            )
        return self.assets[asset_id]

    # ------------------------------------------------------------------
    # 内部工具方法
    # ------------------------------------------------------------------
    def _new_id(self, prefix: str, title: str) -> str:
        step_id = f"{prefix}_{_slugify(title)}_{_short_hash()}"
        while step_id in self.steps:
            step_id = f"{prefix}_{_slugify(title)}_{_short_hash()}"
        return step_id

    def _require_step(self, step_id: str) -> Step:
        if step_id not in self.steps:
            raise GraphValidationError(
                f"未找到 step_id='{step_id}' 对应的节点。请先调用 graph_get_overview "
                f"确认正确的 step_id(它由此前的 create_* 工具调用返回,而不是标题)。"
            )
        return self.steps[step_id]

    # ------------------------------------------------------------------
    # 创建节点
    # ------------------------------------------------------------------
    def add_input_step(
        self, title: str, question_text: str, modality: str = "Any", required: bool = True
    ) -> Step:
        step_id = self._new_id("input", title)
        step = Step(
            step_id=step_id,
            title=title,
            step_type=StepType.INPUT,
            question_text=question_text,
            modality=modality,
            required=required,
        )
        self.steps[step_id] = step
        return step

    def add_agent_step(
        self,
        title: str,
        prompt: str,
        expected_output: str,
        parents: Optional[List[str]] = None,
        tools: Optional[List[str]] = None,
        generation_capabilities: Optional[List[str]] = None,
        enable_chat: bool = False,
        enable_memory: bool = False,
        routes: Optional[List[Dict[str, str]]] = None,
        expected_output_is_list: bool = False,
        terse_mode: bool = False,
        image_aspect_ratio: Optional[str] = None,
        asset_ids: Optional[List[str]] = None,
    ) -> Step:
        parents = parents or []
        for p in parents:
            self._require_step(p)  # 校验父节点必须已存在

        if routes:
            for r in routes:
                self._require_step(r["target_step_id"])  # 校验路由目标必须已存在(方案1)

        for aid in (asset_ids or []):
            self._require_asset(aid)  # 校验引用的资产必须已登记

        resolved_tools = list(tools or [])
        if enable_memory and "memory" not in resolved_tools:
            # enable_memory=True 时自动确保 memory 工具引用会被写进
            # prompt(见 _compile_agent_prompt_text),用户不需要在 tools
            # 里重复声明一遍 "memory"。
            resolved_tools.append("memory")

        unknown_tools = [t for t in resolved_tools if t not in TOOL_PATH_MAP]
        if unknown_tools:
            raise GraphValidationError(
                f"未知的工具名称: {unknown_tools}。可用工具: {sorted(TOOL_PATH_MAP.keys())}"
            )

        step_id = self._new_id("agent", title)
        step = Step(
            step_id=step_id,
            title=title,
            step_type=StepType.AGENT,
            prompt=prompt,
            expected_output=expected_output,
            expected_output_is_list=expected_output_is_list,
            parents=parents,
            tools=resolved_tools,
            generation_capabilities=generation_capabilities or ["text"],
            enable_chat=enable_chat,
            enable_memory=enable_memory,
            terse_mode=terse_mode,
            image_aspect_ratio=image_aspect_ratio,
            routes=routes or [],
            asset_ids=asset_ids or [],
        )
        self.steps[step_id] = step
        return step

    def add_render_step(
        self,
        title: str,
        parents: List[str],
        design_brief: str,
        asset_ids: Optional[List[str]] = None,
        render_mode: str = "Auto",
    ) -> Step:
        # v4修正:不再强制要求创建时就有非空 parents。routing 场景下,
        # 目标节点(如这里的 render 节点)往往需要先于指向它的 agent 节点
        # 创建("方案1":路由目标必须先存在),此时它天然还没有 parents。
        # 允许先创建"空壳"节点,后续用 manage_connection 或 edit_step
        # 补充数据来源。只有当 design_brief 完全没有任何数据来源
        # (parents 和 asset_ids 都为空)时,才在这里给出提醒而非阻断。
        for p in parents:
            self._require_step(p)

        for aid in (asset_ids or []):
            self._require_asset(aid)  # 校验引用的资产必须已登记

        if render_mode not in ("Auto", "Manual layout"):
            raise GraphValidationError(
                f"未知的 render_mode='{render_mode}'。可用取值: 'Auto', 'Manual layout'"
            )

        # --- 6.3 节校验:媒体节点连线完整性(v4:资产也算合法媒体来源) ---
        self._validate_render_media_parents(design_brief, parents, asset_ids or [])

        step_id = self._new_id("render", title)
        step = Step(
            step_id=step_id,
            title=title,
            step_type=StepType.RENDER,
            design_brief=design_brief,
            parents=parents,
            asset_ids=asset_ids or [],
            render_mode=render_mode,
        )
        self.steps[step_id] = step
        return step

    def _validate_render_media_parents(
        self, design_brief: str, parents: List[str], asset_ids: Optional[List[str]] = None
    ) -> None:
        """
        对应设计文档 6.3 节的硬校验:
        如果 design_brief 里提到展示媒体,但 parents 里没有任何一个
        agent 节点声明了对应的媒体生成能力(image/video/speech/music),
        且 asset_ids 里也没有任何图片/视频/音频类资产,直接拒绝创建,
        并告知 LLM 原因,而不是静默生成一个渲染不出媒体的页面。

        v4修正:资产(Assets)现在也是合法的媒体来源(比如用户上传的图片),
        不只是 agent 生成的媒体节点才算数——这是 kitchen-sink 样本里
        render 节点同时引用 agent 输出和多个图片/视频资产揭示的用法。
        """
        brief_lower = design_brief.lower()
        mentions_media = any(kw.lower() in brief_lower for kw in _MEDIA_KEYWORDS)
        if not mentions_media:
            return

        has_media_parent = False
        for p in parents:
            step = self.steps.get(p)
            if step and step.step_type == StepType.AGENT:
                if _MEDIA_CAPABILITIES.intersection(step.generation_capabilities):
                    has_media_parent = True
                    break

        if not has_media_parent:
            for aid in (asset_ids or []):
                asset = self.assets.get(aid)
                if asset and asset.mime_type and asset.mime_type.startswith(_MEDIA_MIME_PREFIXES):
                    has_media_parent = True
                    break

        if not has_media_parent:
            raise GraphValidationError(
                "design_brief 中提到展示图片/视频/音频等媒体内容,但 parents 列表里"
                "没有任何声明了对应 generation_capabilities(image/video/speech/music)"
                "的 agent 节点,asset_ids 里也没有图片/视频/音频类的资产。渲染节点的"
                "系统规则禁止编造媒体 URL,只能渲染上游明确传入的媒体——请检查是否"
                "漏连了媒体生成节点或漏引用了媒体资产,修正后重试。"
            )

    # ------------------------------------------------------------------
    # 编辑 / 删除
    # ------------------------------------------------------------------
    def edit_step(
        self,
        step_id: str,
        title: Optional[str] = None,
        prompt: Optional[str] = None,
        tools: Optional[List[str]] = None,
        enable_chat: Optional[bool] = None,
        enable_memory: Optional[bool] = None,
        terse_mode: Optional[bool] = None,
        asset_ids: Optional[List[str]] = None,
        render_mode: Optional[str] = None,
    ) -> Step:
        step = self._require_step(step_id)
        if title is not None:
            step.title = title
        if prompt is not None:
            if step.step_type == StepType.RENDER:
                step.design_brief = prompt
            else:
                step.prompt = prompt
        if tools is not None:
            if step.step_type != StepType.AGENT:
                raise GraphValidationError("tools 字段仅适用于 agent 类型节点。")
            unknown_tools = [t for t in tools if t not in TOOL_PATH_MAP]
            if unknown_tools:
                raise GraphValidationError(
                    f"未知的工具名称: {unknown_tools}。可用工具: {sorted(TOOL_PATH_MAP.keys())}"
                )
            step.tools = tools
        if enable_chat is not None:
            step.enable_chat = enable_chat
        if enable_memory is not None:
            step.enable_memory = enable_memory
        if terse_mode is not None:
            step.terse_mode = terse_mode
        if asset_ids is not None:
            for aid in asset_ids:
                self._require_asset(aid)
            step.asset_ids = asset_ids
        if render_mode is not None:
            if step.step_type != StepType.RENDER:
                raise GraphValidationError("render_mode 字段仅适用于 render 类型节点。")
            if render_mode not in ("Auto", "Manual layout"):
                raise GraphValidationError(
                    f"未知的 render_mode='{render_mode}'。可用取值: 'Auto', 'Manual layout'"
                )
            step.render_mode = render_mode

        # v3新增:对应"userModified"语义(见 6.1 节修正)——
        # 一旦被编辑过,render节点就不再享受"留空走服务端默认值"的待遇,
        # 后续 compile 时会把解析后的实际取值写回JSON(如适用)。
        step.user_modified = True
        return step

    def remove_step(self, step_id: str) -> None:
        self._require_step(step_id)
        del self.steps[step_id]
        # 清理:其他节点里对该 step_id 的 parent / route 引用
        for step in self.steps.values():
            step.parents = [p for p in step.parents if p != step_id]
            step.routes = [r for r in step.routes if r["target_step_id"] != step_id]

    # ------------------------------------------------------------------
    # 连线管理
    # ------------------------------------------------------------------
    def manage_connection(
        self,
        action: str,
        connection_type: str,
        source_step_id: str,
        target_step_id: str,
        route_label: Optional[str] = None,
    ) -> None:
        source = self._require_step(source_step_id)
        self._require_step(target_step_id)

        if connection_type == "parent":
            # 注意:parent 连线方向在这里指"target 依赖 source",
            # 所以真正被修改 parents 列表的是 target 节点。
            target = self.steps[target_step_id]
            if action == "add":
                if source_step_id not in target.parents:
                    target.parents.append(source_step_id)
            elif action == "remove":
                target.parents = [p for p in target.parents if p != source_step_id]
            else:
                raise GraphValidationError(f"未知 action='{action}'")

        elif connection_type == "route":
            if action == "add":
                if not route_label:
                    raise GraphValidationError("添加 route 连线时必须提供 route_label。")
                source.routes.append({"target_step_id": target_step_id, "label": route_label})
            elif action == "remove":
                source.routes = [
                    r for r in source.routes if r["target_step_id"] != target_step_id
                ]
            else:
                raise GraphValidationError(f"未知 action='{action}'")
        else:
            raise GraphValidationError(f"未知 connection_type='{connection_type}'")

    # ------------------------------------------------------------------
    # 坐标分配(拓扑深度)
    # ------------------------------------------------------------------
    def _compute_depths(self) -> Dict[str, int]:
        depths: Dict[str, int] = {}

        def depth_of(step_id: str, visiting: set) -> int:
            if step_id in depths:
                return depths[step_id]
            if step_id in visiting:
                # 环路保护:出现循环依赖时深度归零,避免无限递归
                return 0
            visiting.add(step_id)
            step = self.steps[step_id]
            if not step.parents:
                d = 0
            else:
                d = 1 + max(depth_of(p, visiting) for p in step.parents if p in self.steps)
            depths[step_id] = d
            visiting.discard(step_id)
            return d

        for sid in self.steps:
            depth_of(sid, set())
        return depths

    def _assign_coordinates(self) -> Dict[str, Dict[str, int]]:
        depths = self._compute_depths()
        coords: Dict[str, Dict[str, int]] = {}
        y_counter: Dict[int, int] = {}

        for step_id, step in self.steps.items():
            d = depths.get(step_id, 0)
            x = 250 + d * 450
            y_index = y_counter.get(d, 0)
            y = 160 + y_index * 150
            y_counter[d] = y_index + 1
            coords[step_id] = {"x": x, "y": y}

        return coords

    # ------------------------------------------------------------------
    # 编译:agent 节点的 prompt 拼接
    # ------------------------------------------------------------------
    def _compile_agent_prompt_text(self, step: Step) -> str:
        lines = [f"1. Objective: {step.prompt}"]
        lines.append(f"2. Output Format: {step.expected_output}")

        if step.parents:
            ctx_lines = ["3. User Input / Context:"]
            for p in step.parents:
                parent = self.steps.get(p)
                parent_title = parent.title if parent else p
                ctx_lines.append(
                    f'{parent_title}: {{{{"type":"in","path":"{p}","title":"{parent_title}"}}}}'
                )
            lines.append("\n".join(ctx_lines))

        # v4修正:工具(含 memory、routing)统一放进同一个 "Use tools:" 块,
        # 空格分隔,一字排开——这是 kitchen-sink 样本里最权威的真实写法。
        # 此前 v3 把 memory 特殊处理成独立句子、routing 完全没实现,均已修正。
        tool_placeholders: List[str] = []
        for t in step.tools:
            spec = TOOL_PATH_MAP[t]
            tool_placeholders.append(
                f'{{{{"type":"tool","path":"{spec["path"]}","title":"{spec["display_title"]}"}}}}'
            )
        for r in step.routes:
            target = self.steps.get(r["target_step_id"])
            target_title = target.title if target else r["target_step_id"]
            tool_placeholders.append(
                f'{{{{"type":"tool","path":"{ROUTING_TOOL_PATH}",'
                f'"instance":"{r["target_step_id"]}","title":"{target_title}"}}}}'
            )
        if tool_placeholders:
            lines.append("Use tools:\n" + " ".join(tool_placeholders))

        # routing 场景下补一句人类可读的判断依据说明(label 仍然有用武之地,
        # 只是不再进 tool 占位符本身,而是作为 prose 提示放在这里,
        # 帮助 agent 理解"什么条件下选哪条路由")。
        if step.routes:
            route_desc = "; ".join(
                f'if {r["label"]}, use the "{(self.steps.get(r["target_step_id"]).title if self.steps.get(r["target_step_id"]) else r["target_step_id"])}" routing tool'
                for r in step.routes
            )
            lines.append(f"Choose exactly one route based on the result: {route_desc}.")

        # v4新增:资产引用块,格式与 kitchen-sink 样本一致。
        if step.asset_ids:
            asset_placeholders = []
            for aid in step.asset_ids:
                asset = self.assets.get(aid)
                if not asset:
                    continue
                asset_placeholders.append(self._compile_asset_placeholder(asset))
            if asset_placeholders:
                lines.append("Use assets:\n" + " ".join(asset_placeholders))

        if step.enable_chat:
            lines.append("Chat with the user as needed to clarify or confirm details.")

        return "\n\n".join(lines)

    def _compile_asset_placeholder(self, asset: "Asset") -> str:
        """
        编译单个资产引用占位符:{{"type":"asset","path":"...","mimeType":"...","title":"..."}}
        kitchen-sink 样本里,纯文本资产(inline_text)引用时不带 mimeType 字段,
        其余带 storedData/fileData 的资产都带 mimeType,这里按同样规则处理。
        """
        if asset.mime_type:
            return (
                f'{{{{"type":"asset","path":"{asset.asset_id}",'
                f'"mimeType":"{asset.mime_type}","title":"{asset.title}"}}}}'
            )
        return f'{{{{"type":"asset","path":"{asset.asset_id}","title":"{asset.title}"}}}}'

        return "\n\n".join(lines)

    def _compile_agent_configuration(self, step: Step) -> Dict[str, Any]:
        """
        编译 agent 节点的 configuration 字段。

        v3 修正(基于 demo2/demo3/demo5 三份真实样本):
        - enable_chat 的真实底层字段是 config$ask-user(布尔,含义与直觉相反:
          "是否允许停下来问用户问题")。真正需要对话的节点(demo5)完全不设置
          这个字段(推测默认就是允许);明确不该打断用户的自动化节点
          (demo2/demo3 里的处理型节点)会显式设为 false。因此我们只在
          enable_chat=False 时写入 config$ask-user=false,enable_chat=True
          时不写这个字段(交给默认值)。
        - tools 不再作为独立字段,而是编译进 config$prompt 文本内部
          (见 _compile_agent_prompt_text)。
        - b-system-instruction 只在 terse_mode=True 时写入固定的
          AGENT_TERSE_SYSTEM_INSTRUCTION 常量,而不是让 LLM 自由发挥。
        - config$list 目前只有单个样本佐证(demo3),按 expected_output_is_list
          原样透传。
        - generation-capabilities / p-aspect-ratio 等图像相关字段仍缺乏
          充分样本验证,标注为待确认。
        """
        config: Dict[str, Any] = {
            "config$prompt": {
                "parts": [{"text": self._compile_agent_prompt_text(step)}],
                "role": "user",
            },
            "generation-mode": "agent",
        }

        if not step.enable_chat:
            config["config$ask-user"] = False  # 确认字段(demo2 x2, demo3)

        config["config$list"] = step.expected_output_is_list  # 部分确认(仅demo3一例)

        if step.terse_mode:
            config["b-system-instruction"] = {
                "role": "user",
                "parts": [{"text": AGENT_TERSE_SYSTEM_INSTRUCTION}],
            }

        if step.generation_capabilities and step.generation_capabilities != ["text"]:
            config["generation-capabilities"] = list(step.generation_capabilities)  # 待确认字段

        if step.image_aspect_ratio and "image" in step.generation_capabilities:
            config["p-aspect-ratio"] = step.image_aspect_ratio  # 部分确认(仅demo2一例)

        return config

    # ------------------------------------------------------------------
    # 编译:主入口
    # ------------------------------------------------------------------
    def compile_to_opal_json(self) -> Dict[str, Any]:
        coords = self._assign_coordinates()
        nodes: List[Dict[str, Any]] = []
        edges: List[Dict[str, Any]] = []

        for step in self.steps.values():
            xy = coords[step.step_id]
            base_metadata = {
                "title": step.title,
                "visual": {
                    "x": xy["x"],
                    "y": xy["y"],
                    "collapsed": "expanded",
                    "outputHeight": 88,
                },
            }

            # v3新增:所有节点类型都带 userModified,对应真实样本里
            # 普遍存在的这个字段,同时也是我们 render 节点
            # b-system-instruction 是否留空的判断依据(见下方)。
            base_metadata["userModified"] = step.user_modified

            if step.step_type == StepType.INPUT:
                # v3新增:demo4 显示 input 节点也可以带结构化 expected_output,
                # 这里用 question_text 自动生成一个合理的描述。
                base_metadata["expected_output"] = [
                    {"type": "text", "description": step.question_text, "list": False}
                ]
                node = {
                    "id": step.step_id,
                    "metadata": base_metadata,
                    "type": EMBED_URI_INPUT,
                    "configuration": {
                        "description": {
                            "parts": [{"text": step.question_text}],
                            "role": "user",
                        },
                        "p-modality": step.modality,
                        "p-required": step.required,  # v4新增,确认字段
                    },
                }

            elif step.step_type == StepType.AGENT:
                base_metadata["step_intent"] = step.prompt
                # v3修正:expected_output 是结构化 metadata 字段,不再只是
                # prompt 文本里的一段话(prompt 文本里仍会带一份"Output Format"
                # 描述,供 LLM 阅读;这里额外补一份结构化版本供 UI/下游读取)。
                base_metadata["expected_output"] = [
                    {
                        "type": "text",
                        "description": step.expected_output,
                        "list": step.expected_output_is_list,
                    }
                ]
                node = {
                    "id": step.step_id,
                    "metadata": base_metadata,
                    "type": EMBED_URI_AGENT,
                    "configuration": self._compile_agent_configuration(step),
                }

            elif step.step_type == StepType.RENDER:
                brief_text = step.design_brief
                if step.parents:
                    ctx_lines = []
                    for p in step.parents:
                        parent = self.steps.get(p)
                        parent_title = parent.title if parent else p
                        var_name = _slugify(parent_title)
                        ctx_lines.append(
                            f'{var_name}: {{{{"type":"in","path":"{p}","title":"{parent_title}"}}}}'
                        )
                    brief_text = brief_text + "\n\n" + "\n\n".join(ctx_lines)

                # v4新增:render 节点也可以直接引用资产(kitchen-sink 样本里
                # Output 节点同时展示了 agent 输出和多个图片/视频/文档资产)。
                if step.asset_ids:
                    asset_placeholders = []
                    for aid in step.asset_ids:
                        asset = self.assets.get(aid)
                        if asset:
                            asset_placeholders.append(self._compile_asset_placeholder(asset))
                    if asset_placeholders:
                        brief_text = brief_text + "\n\n" + " ".join(asset_placeholders)

                base_metadata["step_intent"] = (
                    f"Create an HTML page presenting: {step.design_brief[:120]}"
                )
                base_metadata["expected_output"] = [
                    {"list": False, "description": "HTML code for a rendered result page", "type": "text"}
                ]

                render_config: Dict[str, Any] = {
                    "text": {"role": "user", "parts": [{"text": brief_text}]},
                    "p-render-mode": step.render_mode,  # v4修正:此前硬编码"Auto"
                    "b-render-model-name": "gemini-flash",
                }

                # v3修正(见文件顶部说明):巨型 system-instruction 是服务端
                # 默认值,默认场景下不写入。只有这个节点被 edit_step 修改过
                # (user_modified=True)时,才写入解析后的完整参考文本 ——
                # 这对应真实样本里"只有 userModified=true 的render节点
                # 才带完整文本"的观察。
                if step.user_modified:
                    render_config["b-system-instruction"] = {
                        "role": "user",
                        "parts": [{"text": RENDER_SERVER_DEFAULT_INSTRUCTION_REFERENCE}],
                    }

                node = {
                    "id": step.step_id,
                    "metadata": base_metadata,
                    "type": EMBED_URI_RENDER,
                    "configuration": render_config,
                }
            else:
                raise AssertionError(f"未知 step_type: {step.step_type}")

            nodes.append(node)

            # v4修正:先收集这个 step 作为路由源头会产生的 (from,to) 对,
            # 用于后面跳过重复的 context 边——kitchen-sink 样本里 Generate→Output
            # 只有【一条】边(routing 语义的 out=target_id),而不是"一条context
            # 边 + 一条routing边"两条并存。当上游节点对某个目标声明了 route,
            # 就用 routing 语义的边替代普通的 context 边。
            routed_targets = {r["target_step_id"] for r in step.routes}

            for p in step.parents:
                # 如果 p 这个上游节点已经对当前 step 声明了 route(即 p 会在
                # 自己的 routes 循环里生成 out=step.step_id 的边),这里就
                # 不再重复生成一条 out="context" 的边。
                parent_step = self.steps.get(p)
                if parent_step and step.step_id in {r["target_step_id"] for r in parent_step.routes}:
                    continue
                edges.append({
                    "from": p,
                    "to": step.step_id,
                    "out": "context",
                    "in": f"p-z-{p}",
                })
            for r in step.routes:
                # v4修正(kitchen-sink样本确认):routing edge的out字段值是
                # 目标节点id本身,不是字符串"route";in字段依然是普通的
                # p-z-{source} 格式,和parent边一致,没有特殊前缀。
                edges.append({
                    "from": step.step_id,
                    "to": r["target_step_id"],
                    "out": r["target_step_id"],
                    "in": f"p-z-{step.step_id}",
                })

        return {
            "metadata": {
                "intent": self.description or self.title,
                "revision_intents": [],
                "raw_intent": self.description or self.title,
                "tags": self.tags,
                "parameters": {},
            },
            "assets": self._compile_assets(),
            "title": self.title,
            "description": self.description,
            "version": "0.0.1",
            "nodes": nodes,
            "edges": edges,
        }

    # ------------------------------------------------------------------
    # 编译:顶层 assets 字典
    # ------------------------------------------------------------------
    def _compile_assets(self) -> Dict[str, Any]:
        """
        把 self.assets 编译成顶层 assets 字典,格式对齐 kitchen-sink 样本里
        观察到的 5 种资产形态(见文件顶部 v4 说明)。
        """
        compiled: Dict[str, Any] = {}
        for asset in self.assets.values():
            if asset.kind == AssetKind.INLINE_TEXT:
                part: Dict[str, Any] = {"text": asset.text_content}
                asset_type = "content"
                extra_meta: Dict[str, Any] = {}
            elif asset.kind == AssetKind.UPLOADED_FILE:
                part = {
                    "storedData": {
                        "handle": asset.drive_handle,
                        "mimeType": asset.mime_type,
                    }
                }
                asset_type = "file"
                extra_meta = {"managed": True}
            elif asset.kind == AssetKind.GOOGLE_DRIVE_DOC:
                part = {"storedData": {"handle": asset.drive_handle, "mimeType": asset.mime_type}}
                asset_type = "content"
                extra_meta = {"managed": False, "subType": "gdrive"}
            elif asset.kind == AssetKind.YOUTUBE_VIDEO:
                part = {"fileData": {"fileUri": asset.file_uri, "mimeType": asset.mime_type}}
                asset_type = "content"
                extra_meta = {"subType": "youtube"}
            elif asset.kind == AssetKind.DRAWING:
                part = {"storedData": {"handle": asset.drive_handle, "mimeType": asset.mime_type}}
                asset_type = "content"
                extra_meta = {"subType": "drawable"}
            else:
                raise AssertionError(f"未知 AssetKind: {asset.kind}")

            compiled[asset.asset_id] = {
                "data": [{"parts": [part], "role": "user"}],
                "metadata": {
                    "title": asset.title,
                    "type": asset_type,
                    **extra_meta,
                },
            }
        return compiled
