# -*- coding: utf-8 -*-
"""
opie_tools.py
=============
把 opal_graph.OpalGraphState 的操作包装成 LangChain StructuredTool,
供 Opie(LLM Agent)以 function calling 方式调用。

用法:
    from opal_graph import OpalGraphState
    from opie_tools import build_opie_tools

    graph_state = OpalGraphState()          # 每个用户会话一个实例
    tools = build_opie_tools(graph_state)   # 得到 8 个 LangChain Tool

    # 之后把 tools 传给 create_agent(...) 即可

设计要点:
- 每个 tool 的 name / description / 参数 schema 与设计文档
  《opie-tool-schema-design.md》第2节对应。
- 所有工具的返回值统一是 JSON 字符串(而不是 Python dict),
  因为 LangChain 的 ToolMessage content 期望是字符串;
  LLM 侧读到的是清晰的 JSON 文本,方便它在后续决策里引用 step_id。
- 校验错误(GraphValidationError)被捕获后**不会抛出异常中断流程**,
  而是转换成一条 "error" 字段返回给 LLM,让 LLM 有机会读到错误信息、
  自我修正后重试(比如补上漏连的 parent),这是 agent loop 里更稳健的做法。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from opal_graph import GraphValidationError, OpalGraphState
from opal_skills import discover_skills
from logger import get_logger


# ------------------------------------------------
# 日志配置:将工具调用日志写入当前目录下的 server.log
# ------------------------------------------------
logger = get_logger(__name__)


def _ok(payload: Dict[str, Any]) -> str:
    return json.dumps({"success": True, **payload}, ensure_ascii=False)


def _err(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


# =======================================
# 2.1 graph_get_overview
# =======================================

class _GetOverviewArgs(BaseModel):
    pass


def _make_get_overview_tool(graph: OpalGraphState) -> StructuredTool:
    def _run() -> str:
        logger.info("Tools<graph_get_overview> invoked.")
        return json.dumps(graph.get_overview(), ensure_ascii=False)

    return StructuredTool.from_function(
        func=_run,
        name="graph_get_overview",
        description=(
            #"获取当前图的完整结构:所有节点(含step_id、title、type、prompt摘要)"
            #"和所有连线关系。建图或编辑前必须先调用此工具了解现状。"
            "Get the complete structure of the current graph, including all nodes "
            "(with step_id, title, type, and prompt summary) and all connection relationships. "
            "This tool MUST be called to understand the current state before creating or editing a graph."
        ),
        args_schema=_GetOverviewArgs,
    )


# =======================================
# 2.2 create_input_step
# =======================================

class _CreateInputStepArgs(BaseModel):
    title: str = Field(..., description="The node title, which must be brief and clear (e.g., 'Height Cm', 'User Email', 'Upload File'). "
                                        "This is the exact title users will see on the canvas.")
    question_text: str = Field(..., description="The question or prompt text displayed to the user "
                                                "(e.g., 'Enter your height in centimeters.' or 'Upload your Excel file').")
    modality: str = Field(
        "Any",
        description=(
            "The expected input modality. Allowed values:\n"
            "- 'Text': Plain text input (e.g., name, email, numbers)\n"
            "- 'Image': Image upload (e.g., avatar, photo, screenshot)\n"
            "- 'Audio': Audio upload (e.g., voice message, recording)\n"
            "- 'Any': Any input type, including file uploads (e.g., Excel/PDF/Word documents, images, audio, video)\n"
            "Critical Rules:\n"
            "• When the user explicitly mentions 'upload file', 'select file', 'import Excel/PDF/Word', etc., this MUST be set to 'Any' or its specific modality.\n"
            "• 'Any' is the most flexible choice, supporting hybrid scenarios of file uploads and text inputs.\n"
            "• Use 'Text' ONLY for pure text-entry scenarios (e.g., entering names or numbers)."
        ),
    )
    required: bool = Field(
        True,
        description="Whether this input is required. Set to False if the user can skip it (e.g., scenarios like 'Optional: Add your preferences').",
    )


def _make_create_input_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(title: str, question_text: str, modality: str = "Any", required: bool = True) -> str:
        logger.info("Tools<create_input_step> invoked: title: %s , desc: %s", title, question_text)
        try:
            step = graph.add_input_step(
                title=title, question_text=question_text, modality=modality, required=required
            )
            return _ok({"step_id": step.step_id, "title": step.title})
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="create_input_step",
        description=(
            "Create an input node to ask the user for information. Used to collect raw data provided by the user:\n"
            "- Text input (numbers, names, emails, etc.) → modality='Text'\n"
            "- File upload (Excel/PDF/Word documents, CSV, etc.) → modality='Any'\n"
            "- Image upload (photos, screenshots, design drafts, etc.) → modality='Image'\n"
            "- Audio upload (voice messages, recordings, etc.) → modality='Audio'\n"
            "- Mixed input (accepts both text and files) → modality='Any'\n"
            "Critical Identification Rules: When the user mentions keywords like 'upload', 'import', 'select file', 'Excel file', 'PDF', etc., "
            "you MUST use modality='Any' (or its specific modality) instead of defaulting to 'Text'.\n"
            "This is a starting node of the graph and typically has no upstream connections. "
            "The return value contains the step_id of the new node, which must be referenced when creating downstream nodes."
        ),
        args_schema=_CreateInputStepArgs,
    )


# =======================================
# 2.3 create_agent_step
# =======================================


def _build_skills_field_description() -> str:
    """构造 skills 字段的说明文本,把当前可用的 skill 名称+简介列进去,
    让构图 LLM 知道有哪些 skill 可挂载以及各自的适用场景。"""
    skills = discover_skills()
    base = (
        "A list of Agent Skill names callable by this node (optional). "
        "Each skill represents a pre-configured set of professional capabilities (containing a SKILL.md instruction manual and executable scripts). "
        "Once declared, the usage instructions for the skill will be injected into the agent during execution, "
        "and a sandboxed tool restricted to running scripts only within that skill directory will be exposed. "
        "Best suited for specialized file-processing tasks."
    )
    if not skills:
        return base + " No available skills found."
    lines = [base + " Available skills:"]
    for name in sorted(skills):
        desc = (skills[name].description or "").strip()
        if len(desc) > 200:
            desc = desc[:200] + "…"
        lines.append(f"- {name}: {desc}")
    return "\n".join(lines)


class _RouteSpec(BaseModel):
    target_step_id: str = Field(..., description="The step_id of the target routing node.")
    label: str = Field(..., description="The semantic label of this route (e.g., 'Morning'/'Evening'). "
                                        "This will be incorporated into the prompt to guide the agent on when to select this route.")


class _CreateAgentStepArgs(BaseModel):
    title: str = Field(..., description="The node title summarizing the responsibility of this step (e.g., 'Calculate BMI And Category').")
    prompt: str = Field(
        ...,
        description=(
            "Pure goal-oriented text (objective) without any tag syntax. "
            "Write it using the structure: Role/Goal → Numbered Tasks → Return Values. "
            "Do NOT insert tags like <parent> or <tool> within this text—upstream/downstream connections "
            "and tools must be declared exclusively via the structured fields below."
        ),
    )
    expected_output: str = Field(..., description="A description of the final result this node should return (e.g., 'BMI value and health assessment').")
    parents: List[str] = Field(
        default_factory=list,
        description="A list of step_ids for upstream nodes (retrieved from graph_get_overview or the return values of previous 'create' calls).",
    )
    tools: List[str] = Field(
        default_factory=list,
        description=(
            "A list of tool capabilities to be mounted on this node. "
            "Allowed values: read-file, write-file, code-execution, search-web, get-webpage, search-internal, memory"
        ),
    )
    skills: List[str] = Field(
        default_factory=list,
        description=_build_skills_field_description(),
    )
    generation_capabilities: List[str] = Field(
        default_factory=lambda: ["text"],
        description="The generation capabilities required by this node. "
                    "Allowed values: text, image, video, speech, music. Defaults to ['text'].",
    )
    enable_chat: bool = Field(False, description="Whether multi-turn conversation with the user is required (as opposed to a single-run execution).")
    enable_memory: bool = Field(False, description="Whether to enable persistent memory (to retain state across sessions).")
    terse_mode: bool = Field(
        False,
        description=(
            "Whether this node's output is purely fed to the next node and not shown directly to the user. "
            "If set to True, conversational pleasantries (such as 'Okay', 'Alright', etc.) will be disabled, "
            "making the output better suited for direct consumption by downstream nodes. "
            "This is ideal for intermediate processing nodes in a workflow (e.g., intermediate steps in chains like "
            "'Research → Draft Outline → Write Article') and should NOT be used for nodes that interact directly "
            "with the user or present final results."
        ),
    )
    expected_output_is_list: bool = Field(
        False,
        description="Set to True if the result described in expected_output is inherently a list (such as multiple recommendations or multiple items).",
    )
    image_aspect_ratio: Optional[str] = Field(
        None,
        description=(
            "Only applicable when generation_capabilities contains 'image'. "
            "Specifies the aspect ratio of the generated image (e.g., '16:9', '9:16', '1:1'). "
            "Do NOT pass this parameter if no image generation is involved."
        ),
    )
    routes: List[_RouteSpec] = Field(
        default_factory=list,
        description=(
            "Declare all candidate routes here if this node requires conditional routing (taking only one branch rather than all downstream edges)."
            "Note: Target routing nodes MUST already exist. "
            "You should create the target nodes first before creating the source node containing the routes."
        ),
    )
    asset_ids: List[str] = Field(
        default_factory=list,
        description=(
            "A list of asset IDs to be referenced by this node (created via register_asset or retrieved from graph_get_overview)." 
            "Best suited for scenarios where the agent needs to analyze or process user-uploaded files, images, documents, or videos."
        ),
    )


def _make_create_agent_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        title: str,
        prompt: str,
        expected_output: str,
        parents: Optional[List[str]] = None,
        tools: Optional[List[str]] = None,
        skills: Optional[List[str]] = None,
        generation_capabilities: Optional[List[str]] = None,
        enable_chat: bool = False,
        enable_memory: bool = False,
        terse_mode: bool = False,
        expected_output_is_list: bool = False,
        image_aspect_ratio: Optional[str] = None,
        routes: Optional[List[Dict[str, str]]] = None,
        asset_ids: Optional[List[str]] = None,
    ) -> str:
        logger.info("Tools<create_agent_step> invoked: title: %s", title)
        try:
            step = graph.add_agent_step(
                title=title,
                prompt=prompt,
                expected_output=expected_output,
                parents=parents or [],
                tools=tools or [],
                skills=skills or [],
                generation_capabilities=generation_capabilities or ["text"],
                enable_chat=enable_chat,
                enable_memory=enable_memory,
                terse_mode=terse_mode,
                expected_output_is_list=expected_output_is_list,
                image_aspect_ratio=image_aspect_ratio,
                routes=[dict(r) for r in (routes or [])],
                asset_ids=asset_ids or [],
            )
            return _ok({"step_id": step.step_id, "title": step.title})
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="create_agent_step",
        description=(
            "Create an autonomous Agentic computation/generation node, "
            "driven by an LLM to accomplish a goal-oriented task (such as calculation, analysis, generating text/image/video/audio, multi-turn conversation, etc.). "
            "This is the core node type within the graph. "
            "The return value contains the step_id of the newly created node."
        ),
        args_schema=_CreateAgentStepArgs,
    )


# =======================================
# 2.4 create_render_step
# =======================================

class _CreateRenderStepArgs(BaseModel):
    title: str = Field(..., description="The node title, such as 'Design Dashboard'.")
    parents: List[str] = Field(
        default_factory=list,
        description=(
            "A list of step_ids representing the data source nodes to be displayed. "
            "Can be left empty—for instance, when this render node is the routing target of an agent node and needs to be created first, "
            "you can omit 'parents' initially and link them later using 'manage_connection' once that agent node is created.\n"
            "Important Notes:\n"
            "(1) This list should typically include the original input nodes (rather than just the downstream computation nodes).\n"
            "(2) If the 'design_brief' requires displaying images, videos, or audio, "
            "the corresponding media-generating agent nodes or media assets MUST be included in 'parents' or 'asset_ids'; "
            "otherwise, the creation request will be rejected."
        ),
    )
    design_brief: str = Field(
        ...,
        description=(
            "A description of the visual design requirements: overall vibe/atmosphere, color scheme, layout sections, and key component specifications. "
            "Do NOT mention technical implementation details (such as Tailwind CSS, CSP, etc.), as those are handled by the system's fixed templates. "
            "If a footer is included, it must only be described as a disclaimer or explanatory text—do NOT describe it as copyright or legal notice content."
        ),
    )
    asset_ids: List[str] = Field(
        default_factory=list,
        description="A list of asset IDs to be displayed by this node (such as images, documents, videos, etc.; "
                    "created via 'register_asset' or retrieved from 'graph_get_overview').",
    )
    render_mode: str = Field(
        "Auto",
        description=(
            "The rendering mode. "
            "Allowed values are 'Auto' (AI automatically generates the complete layout; use this for the vast majority of scenarios) "
            "or 'ManualLayout' (a mode closer to manually positioning elements, whose exact use case is not yet fully defined; "
            "do NOT actively select this option unless explicitly instructed)."
        ),
    )


def _make_create_render_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        title: str,
        design_brief: str,
        parents: Optional[List[str]] = None,
        asset_ids: Optional[List[str]] = None,
        render_mode: str = "Auto",
    ) -> str:
        logger.info("Tools<create_render_step> invoked: title: %s", title)
        try:
            step = graph.add_render_step(
                title=title,
                parents=parents or [],
                design_brief=design_brief,
                asset_ids=asset_ids or [],
                render_mode=render_mode,
            )
            return _ok({"step_id": step.step_id, "title": step.title})
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="create_render_step",
        description=(
            "Create a final presentation page node to render upstream data into a self-contained HTML result page. "
            "This is used as the endpoint of the graph to present visual results directly to the user."
        ),
        args_schema=_CreateRenderStepArgs,
    )


# =======================================
# 2.5 edit_step
# =======================================

class _EditStepArgs(BaseModel):
    step_id: str = Field(..., description="The step_id of the target node.")
    title: Optional[str] = Field(None, description="A new title for the node (optional).")
    prompt: Optional[str] = Field(None, description="The new prompt or design_brief text (optional; the specific meaning of this field depends on the node type).")
    tools: Optional[List[str]] = Field(None, description="An overriding list of tool capabilities (optional; applicable only to agent nodes).")
    skills: Optional[List[str]] = Field(None, description="An overriding list of skills (optional; applicable only to agent nodes; refer to the skills documentation in create_agent_step).")
    enable_chat: Optional[bool] = Field(None, description="An overriding flag for multi-turn conversation (optional; applicable only to agent nodes).")
    enable_memory: Optional[bool] = Field(None, description="An overriding flag for persistent memory (optional; applicable only to agent nodes; refer to the documentation in create_agent_step).")
    terse_mode: Optional[bool] = Field(None, description="An overriding flag for terse mode (optional; applicable only to agent nodes; refer to the documentation in create_agent_step).")
    asset_ids: Optional[List[str]] = Field(None, description="An overriding list of referenced asset IDs (optional; applicable to both agent and render nodes).")
    render_mode: Optional[str] = Field(None, description="The rendering mode, either 'Auto' or 'ManualLayout' (optional; applicable only to render nodes).")


def _make_edit_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        step_id: str,
        title: Optional[str] = None,
        prompt: Optional[str] = None,
        tools: Optional[List[str]] = None,
        skills: Optional[List[str]] = None,
        enable_chat: Optional[bool] = None,
        enable_memory: Optional[bool] = None,
        terse_mode: Optional[bool] = None,
        asset_ids: Optional[List[str]] = None,
        render_mode: Optional[str] = None,
    ) -> str:
        logger.info("Tools<edit_step> invoked: step_id: %s, title: %s", step_id, title)
        try:
            step = graph.edit_step(
                step_id=step_id,
                title=title,
                prompt=prompt,
                tools=tools,
                skills=skills,
                enable_chat=enable_chat,
                enable_memory=enable_memory,
                terse_mode=terse_mode,
                asset_ids=asset_ids,
                render_mode=render_mode,
            )
            return _ok({"step_id": step.step_id, "title": step.title})
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="edit_step",
        description="Modify the configuration of an existing node. "
                    "Only pass the fields that need to be changed; "
                    "any unpassed fields will retain their original values.",
        args_schema=_EditStepArgs,
    )


# =======================================
# 2.6 remove_step
# =======================================

class _RemoveStepArgs(BaseModel):
    step_id: str = Field(..., description="The step_id of the node to be deleted.")


def _make_remove_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(step_id: str) -> str:
        logger.info("Tools<remove_step> invoked: step_id: %s", step_id)
        try:
            graph.remove_step(step_id)
            return _ok({"removed_step_id": step_id})
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="remove_step",
        description="Delete a node. This will automatically clean up all associated edges "
                    "(both the 'parents' references within this node and any references to this node as a parent of other nodes).",
        args_schema=_RemoveStepArgs,
    )


# =======================================
# 2.7 manage_connection
# =======================================

class _ManageConnectionArgs(BaseModel):
    action: str = Field(..., description="The action to perform: 'add' or 'remove'.")
    connection_type: str = Field(..., description="The type of connection: 'parent' (data dependency) or 'route' (conditional branching).")
    source_step_id: str = Field(..., description="The step_id of the source (origin) node.")
    target_step_id: str = Field(..., description="The step_id of the target (destination) node.")
    route_label: Optional[str] = Field(
        None, description="Required ONLY when connection_type is 'route' and action is 'add'. "
                          "Describes the condition or semantic criteria for choosing this route."
    )


def _make_manage_connection_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        action: str,
        connection_type: str,
        source_step_id: str,
        target_step_id: str,
        route_label: Optional[str] = None,
    ) -> str:
        logger.info("Tools<manage_connection> invoked: %s -> %s", source_step_id, target_step_id)
        try:
            graph.manage_connection(
                action=action,
                connection_type=connection_type,
                source_step_id=source_step_id,
                target_step_id=target_step_id,
                route_label=route_label,
            )
            return _ok({
                "action": action,
                "connection_type": connection_type,
                "source_step_id": source_step_id,
                "target_step_id": target_step_id,
            })
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="manage_connection",
        description="Add or remove directed edges (connections) between graph nodes. "
                    "Supports two connection types: data dependencies ('parent') and conditional branching ('route').",
        args_schema=_ManageConnectionArgs,
    )


# =======================================
# 2.8 set_graph_metadata
# =======================================

class _SetGraphMetadataArgs(BaseModel):
    title: Optional[str] = Field(None, description="The title of the graph.")
    description: Optional[str] = Field(None, description="The description of the graph.")
    tags: Optional[List[str]] = Field(None, description="A list of tags associated with the graph.")


def _make_set_graph_metadata_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        title: Optional[str] = None,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> str:
        logger.info("Tools<set_graph_metadata> invoked: title: %s , description: %s", title, description)
        result = graph.set_metadata(title=title, description=description, tags=tags)
        return _ok(result)

    return StructuredTool.from_function(
        func=_run,
        name="set_graph_metadata",
        description="Set or update the metadata (title, description, and tags) for the entire graph.",
        args_schema=_SetGraphMetadataArgs,
    )


# =======================================
# 2.9 register_asset (v4新增)
# =======================================

class _RegisterAssetArgs(BaseModel):
    title: str = Field(..., description="The display name of the asset, such as 'Product_Specification.pdf' or 'Brand_Promo_Video'.")
    kind: str = Field(
        ...,
        description=(
            "The type of the asset. Allowed values:\n"
            "- 'inline_text': A plain text reference material. (This is the only type where Opie can directly create content from scratch; ideal for injecting background knowledge, reference copy, sample data, etc.)\n"
            "- 'uploaded_file': A reference to an uploaded file that already exists in the host application. (Requires 'drive_handle'; these assets are typically registered by the host application after a user uploads them in the UI, rather than being created from scratch by Opie)\n"
            "- 'google_drive_doc': A reference to an existing Google Drive document. (Requires 'drive_handle')\n"
            "- 'youtube_video': A reference to a YouTube video link. (Requires 'file_uri')\n"
            "- 'drawing': A reference to a hand-drawn sketch or diagram. (Requires 'drive_handle')"
        ),
    )
    text_content: Optional[str] = Field(None, description="Required ONLY when kind='inline_text'. The actual text content of the asset.")
    mime_type: Optional[str] = Field(None, description="The MIME type, such as 'image/png' or 'video/mp4'. Can be omitted for text assets.")
    drive_handle: Optional[str] = Field(
        None, description="Required ONLY when kind is 'uploaded_file', 'google_drive_doc', or 'drawing'. The format should be similar to 'drive:/{file_id}'."
    )
    file_uri: Optional[str] = Field(None, description="Required ONLY when kind='youtube_video'. The full URL of the video.")


def _make_register_asset_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        title: str,
        kind: str,
        text_content: Optional[str] = None,
        mime_type: Optional[str] = None,
        drive_handle: Optional[str] = None,
        file_uri: Optional[str] = None,
    ) -> str:
        try:
            asset = graph.register_asset(
                title=title,
                kind=kind,
                mime_type=mime_type,
                drive_handle=drive_handle,
                file_uri=file_uri,
                text_content=text_content,
            )
            return _ok({"asset_id": asset.asset_id, "title": asset.title})
        except GraphValidationError as e:
            return _err(str(e))

    """
    description=(
        "Register an asset (file/doc/video/text) for use in agent/render steps. "
        "Only 'inline_text' creates new content; other types reference existing resources. "
        "Examples: register_asset(title='FAQ.txt', kind='inline_text', text_content='...') "
        "or register_asset(title='Logo', kind='uploaded_file', drive_handle='drive:/abc123', mime_type='image/png')"
    )
    """
    return StructuredTool.from_function(
        func=_run,
        name="register_asset",
        description=(
            "Register an asset (file, document, video, or text) to be referenced by the 'asset_ids' field in 'create_agent_step' or 'create_render_step'. "
            "Only 'inline_text' can create content from scratch; all other types register references to already existing resources. "
            "Before calling this tool, always use 'graph_get_overview' to check if the asset has already been registered to avoid duplication.\n"
            "Examples:\n"
            "register_asset(title='FAQ', kind='inline_text', text_content='...')\n"
            "or register_asset(title='Logo', kind='uploaded_file', drive_handle='drive:/abc123', mime_type='image/png')"
        ),
        args_schema=_RegisterAssetArgs,
    )


# =======================================
# 工厂函数:一次性构建全部 9 个工具
# =======================================

def build_opie_tools(graph: OpalGraphState) -> List[StructuredTool]:
    """
    传入一个 OpalGraphState 实例(每个会话独立一份),返回绑定了该状态的
    9 个 LangChain 工具(v4新增 register_asset)。所有工具共享同一个 graph
    闭包,因此对图的修改在多次工具调用之间是持久的(在这个 Python 进程/
    会话的生命周期内)。
    """
    return [
        _make_get_overview_tool(graph),
        _make_create_input_step_tool(graph),
        _make_create_agent_step_tool(graph),
        _make_create_render_step_tool(graph),
        _make_edit_step_tool(graph),
        _make_remove_step_tool(graph),
        _make_manage_connection_tool(graph),
        _make_set_graph_metadata_tool(graph),
        _make_register_asset_tool(graph),
    ]