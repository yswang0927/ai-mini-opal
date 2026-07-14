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
  《opie-tool-schema-design.md》第2节严格对应。
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


def _ok(payload: Dict[str, Any]) -> str:
    return json.dumps({"success": True, **payload}, ensure_ascii=False)


def _err(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


# ===========================================================================
# 2.1 graph_get_overview
# ===========================================================================

class _GetOverviewArgs(BaseModel):
    pass


def _make_get_overview_tool(graph: OpalGraphState) -> StructuredTool:
    def _run() -> str:
        return json.dumps(graph.get_overview(), ensure_ascii=False)

    return StructuredTool.from_function(
        func=_run,
        name="graph_get_overview",
        description=(
            "获取当前图的完整结构:所有节点(含step_id、title、type、prompt摘要)"
            "和所有连线关系。建图或编辑前必须先调用此工具了解现状。"
        ),
        args_schema=_GetOverviewArgs,
    )


# ===========================================================================
# 2.2 create_input_step
# ===========================================================================

class _CreateInputStepArgs(BaseModel):
    title: str = Field(..., description="节点标题,简短明确,如'Height Cm'、'User Email'、'Upload File'。用户在画布上看到的就是这个标题。")
    question_text: str = Field(..., description="向用户展示的提问文案,如'Enter your height in centimeters.'或'Upload your Excel file'。")
    modality: str = Field(
        "Any",
        description=(
            "期望的输入模态,可选值:\n"
            "- 'Text': 纯文本输入(如姓名、邮箱、数字)\n"
            "- 'Image': 图片上传(如头像、照片、截图)\n"
            "- 'Audio': 音频上传(如语音消息、录音)\n"
            "- 'Any': 任意类型输入,包括文件上传(Excel/PDF/Word等文档、图片、音频、视频等)\n"
            "关键规则:\n"
            "• 当用户明确提到'上传文件'、'选择文件'、'导入Excel/PDF/Word'等,必须设置为'Any'或对应的专用类型\n"
            "• 'Any'是最灵活的选择,支持文件上传+文本输入的组合场景\n"
            "• 纯文本场景(如输入姓名、数字)才用'Text'"
        ),
    )
    required: bool = Field(
        True,
        description="该输入是否必填。设为False表示用户可以跳过(如'可选:补充你的偏好'这类场景)。",
    )


def _make_create_input_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(title: str, question_text: str, modality: str = "Any", required: bool = True) -> str:
        print(f" >>> Tools<create_input_step> invoked: {title} - {question_text}")
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
            "创建一个向用户询问信息的输入节点。用于收集用户需要提供的原始数据:\n"
            "• 文本输入(数字、姓名、邮箱等) → modality='Text'\n"
            "• 文件上传(Excel/PDF/Word文档、CSV等) → modality='Any'\n"
            "• 图片上传(照片、截图、设计稿等) → modality='Image'\n"
            "• 音频上传(语音消息、录音等) → modality='Audio'\n"
            "• 混合输入(文本+文件都接受) → modality='Any'\n"
            "关键识别规则:当用户提到'上传'、'导入'、'选择文件'、'Excel文件'、'PDF'等关键词时,"
            "必须使用 modality='Any' 或对应的专用类型,而不是默认的'Text'。\n"
            "这是图的起点节点,通常没有上游连接。返回值包含新节点的 step_id,后续创建下游节点时需要引用它。"
        ),
        args_schema=_CreateInputStepArgs,
    )


# ===========================================================================
# 2.3 create_agent_step
# ===========================================================================

class _RouteSpec(BaseModel):
    target_step_id: str = Field(..., description="路由目标节点的 step_id")
    label: str = Field(..., description="该路由的语义标签,如'Morning'/'Evening',会体现在prompt里指导agent何时选择该路由")


class _CreateAgentStepArgs(BaseModel):
    title: str = Field(..., description="节点标题,概括该step的职责,如'Calculate BMI And Category'")
    prompt: str = Field(
        ...,
        description=(
            "纯目标性文本(objective),不含任何标签语法。按角色/目标→编号任务→返回值的结构撰写。"
            "不要在文本里插入<parent>/<tool>等标签——上下游关系和工具通过下面的结构化字段声明。"
        ),
    )
    expected_output: str = Field(..., description="该节点应返回的最终结果描述,如'BMI值和健康评估的字符串'。")
    parents: List[str] = Field(
        default_factory=list,
        description="上游节点的 step_id 列表(通过 graph_get_overview 或此前 create 调用的返回值获取)。",
    )
    tools: List[str] = Field(
        default_factory=list,
        description=(
            "本节点需要挂载的工具能力列表,可选值:get-weather, search-web, get-webpage, "
            "search-maps, search-internal, search-enterprise, code-execution, memory, "
            "read-file, write-file"
        ),
    )
    generation_capabilities: List[str] = Field(
        default_factory=lambda: ["text"],
        description="本节点需要用到的生成模态,可选值:text, image, video, speech, music。默认为['text']。",
    )
    enable_chat: bool = Field(False, description="是否需要与用户进行多轮对话(而非单次执行)。")
    enable_memory: bool = Field(False, description="是否启用持久化记忆(跨session保留状态)。")
    terse_mode: bool = Field(
        False,
        description=(
            "该节点的输出是否只喂给下一个节点、不直接展示给用户看。若为True,"
            "会关闭寒暄式的开场白('Okay'/'Alright'等),让输出更适合被下游"
            "节点直接消费。适用于流程中间的处理型节点(如'先研究再写大纲再成文'"
            "这类链条里的中间环节),不适用于直接与用户对话或作为最终结果展示的节点。"
        ),
    )
    expected_output_is_list: bool = Field(
        False,
        description="expected_output描述的结果本质上是一个列表(如多条推荐、多个条目)时设为True。",
    )
    image_aspect_ratio: Optional[str] = Field(
        None,
        description=(
            "仅当generation_capabilities包含'image'时有意义,指定生成图片的宽高比,"
            "如'16:9'、'9:16'、'1:1'。不涉及图片生成时不要传这个参数。"
        ),
    )
    routes: List[_RouteSpec] = Field(
        default_factory=list,
        description=(
            "若该节点需要条件路由(只走其中一条出边而非全部),在此声明所有候选路由。"
            "注意:路由目标节点必须已经存在(先创建目标节点,再创建带routes的源节点)。"
        ),
    )
    asset_ids: List[str] = Field(
        default_factory=list,
        description=(
            "该节点需要引用的资产id列表(通过register_asset创建或graph_get_overview获取)。"
            "适用场景:让agent基于用户上传的文件/图片/文档/视频进行分析或处理。"
        ),
    )


def _make_create_agent_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        title: str,
        prompt: str,
        expected_output: str,
        parents: Optional[List[str]] = None,
        tools: Optional[List[str]] = None,
        generation_capabilities: Optional[List[str]] = None,
        enable_chat: bool = False,
        enable_memory: bool = False,
        terse_mode: bool = False,
        expected_output_is_list: bool = False,
        image_aspect_ratio: Optional[str] = None,
        routes: Optional[List[Dict[str, str]]] = None,
        asset_ids: Optional[List[str]] = None,
    ) -> str:
        print(f" >>> Tools<create_agent_step> invoked: {title}")
        try:
            step = graph.add_agent_step(
                title=title,
                prompt=prompt,
                expected_output=expected_output,
                parents=parents or [],
                tools=tools or [],
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
            "创建一个自主Agentic计算/生成节点,由LLM驱动完成一个目标性任务"
            "(计算、分析、生成文本/图像/视频/音频、多轮对话等)。这是图里最核心的节点类型。"
            "返回值包含新节点的 step_id。"
        ),
        args_schema=_CreateAgentStepArgs,
    )


# ===========================================================================
# 2.4 create_render_step
# ===========================================================================

class _CreateRenderStepArgs(BaseModel):
    title: str = Field(..., description="节点标题,如'Design Dashboard'")
    parents: List[str] = Field(
        default_factory=list,
        description=(
            "需要展示的数据来源节点的 step_id 列表。可以为空——比如这个render节点"
            "是某个agent节点的routing目标、需要先创建出来时,可以先不传parents,"
            "等对应的agent节点建好后用manage_connection补上。注意:"
            "(1) 通常应包含原始输入节点(而非仅计算结果节点);"
            "(2) 若design_brief要求展示图片/视频/音频,对应的媒体生成agent节点或"
            "媒体类asset必须包含在parents/asset_ids里,否则会被拒绝创建。"
        ),
    )
    design_brief: str = Field(
        ...,
        description=(
            "视觉设计需求描述:整体氛围/vibe、配色方案、布局分区、关键组件说明。"
            "不需要提及技术实现细节(Tailwind/CSP等),那部分是系统固定模板。"
            "若涉及footer,只能描述为免责声明/说明性文字,不要描述为版权/法律声明类内容。"
        ),
    )
    asset_ids: List[str] = Field(
        default_factory=list,
        description="该节点需要展示的资产id列表(图片/文档/视频等,通过register_asset创建或graph_get_overview获取)。",
    )
    render_mode: str = Field(
        "Auto",
        description=(
            "渲染模式,可选 'Auto'(AI自动生成完整布局,绝大多数场景用这个)或"
            "'Manual layout'(更接近手动摆放元素的模式,用途尚不完全明确,"
            "没有明确指示时不要主动选择这个选项)。"
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
        print(f" >>> Tools<create_render_step> invoked: {title}")
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
            "创建一个最终展示页面节点,将上游数据渲染为一个自包含的HTML结果页。"
            "用于图的终点,呈现给用户看的可视化结果。"
        ),
        args_schema=_CreateRenderStepArgs,
    )


# ===========================================================================
# 2.5 edit_step
# ===========================================================================

class _EditStepArgs(BaseModel):
    step_id: str = Field(..., description="目标节点的 step_id")
    title: Optional[str] = Field(None, description="新标题(可选)")
    prompt: Optional[str] = Field(None, description="新的prompt/design_brief文本(可选,字段含义视节点类型而定)")
    tools: Optional[List[str]] = Field(None, description="覆盖式设置工具列表(可选,仅agent节点适用)")
    enable_chat: Optional[bool] = Field(None, description="(可选,仅agent节点适用)")
    enable_memory: Optional[bool] = Field(None, description="(可选,仅agent节点适用)")
    terse_mode: Optional[bool] = Field(None, description="(可选,仅agent节点适用)见create_agent_step说明")
    asset_ids: Optional[List[str]] = Field(None, description="覆盖式设置资产引用列表(可选,agent/render节点均适用)")
    render_mode: Optional[str] = Field(None, description="'Auto'或'Manual layout'(可选,仅render节点适用)")


def _make_edit_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        step_id: str,
        title: Optional[str] = None,
        prompt: Optional[str] = None,
        tools: Optional[List[str]] = None,
        enable_chat: Optional[bool] = None,
        enable_memory: Optional[bool] = None,
        terse_mode: Optional[bool] = None,
        asset_ids: Optional[List[str]] = None,
        render_mode: Optional[str] = None,
    ) -> str:
        print(f" >>> Tools<edit_step> invoked: {step_id}({title})")
        try:
            step = graph.edit_step(
                step_id=step_id,
                title=title,
                prompt=prompt,
                tools=tools,
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
        description="修改一个已存在节点的配置。只需传入需要变更的字段,未传字段保持原值。",
        args_schema=_EditStepArgs,
    )


# ===========================================================================
# 2.6 remove_step
# ===========================================================================

class _RemoveStepArgs(BaseModel):
    step_id: str = Field(..., description="要删除的节点的 step_id")


def _make_remove_step_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(step_id: str) -> str:
        print(f" >>> Tools<remove_step> invoked: {step_id}")
        try:
            graph.remove_step(step_id)
            return _ok({"removed_step_id": step_id})
        except GraphValidationError as e:
            return _err(str(e))

    return StructuredTool.from_function(
        func=_run,
        name="remove_step",
        description="删除一个节点。会自动清理所有与之相关的连线(该节点的parents引用和作为其他节点parent的引用)。",
        args_schema=_RemoveStepArgs,
    )


# ===========================================================================
# 2.7 manage_connection
# ===========================================================================

class _ManageConnectionArgs(BaseModel):
    action: str = Field(..., description="add 或 remove")
    connection_type: str = Field(..., description="parent 或 route")
    source_step_id: str = Field(..., description="起点节点 step_id")
    target_step_id: str = Field(..., description="终点节点 step_id")
    route_label: Optional[str] = Field(
        None, description="仅当 connection_type 为 route 且 action 为 add 时需要,描述该路由的选择条件语义"
    )


def _make_manage_connection_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        action: str,
        connection_type: str,
        source_step_id: str,
        target_step_id: str,
        route_label: Optional[str] = None,
    ) -> str:
        print(f" >>> Tools<manage_connection> invoked: {source_step_id} -> {target_step_id}")
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
        description="增加或移除节点之间的连线,支持数据依赖连线(parent)和条件路由连线(route)两种类型。",
        args_schema=_ManageConnectionArgs,
    )


# ===========================================================================
# 2.8 set_graph_metadata
# ===========================================================================

class _SetGraphMetadataArgs(BaseModel):
    title: Optional[str] = Field(None, description="图的标题")
    description: Optional[str] = Field(None, description="图的描述")
    tags: Optional[List[str]] = Field(None, description="图的标签列表")


def _make_set_graph_metadata_tool(graph: OpalGraphState) -> StructuredTool:
    def _run(
        title: Optional[str] = None,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> str:
        print(f" >>> Tools<set_graph_metadata> invoked: {title} {description}")
        result = graph.set_metadata(title=title, description=description, tags=tags)
        return _ok(result)

    return StructuredTool.from_function(
        func=_run,
        name="set_graph_metadata",
        description="设置或更新整个图的标题、描述、标签。",
        args_schema=_SetGraphMetadataArgs,
    )


# ===========================================================================
# 2.9 register_asset (v4新增)
# ===========================================================================

class _RegisterAssetArgs(BaseModel):
    title: str = Field(..., description="资产的显示名称,如'产品说明.pdf'、'品牌宣传视频'。")
    kind: str = Field(
        ...,
        description=(
            "资产类型,可选值:\n"
            "- 'inline_text': 一段纯文本参考资料(唯一Opie能直接凭空创建内容的类型,"
            "适合注入一段背景知识、参考文案、示例数据等)\n"
            "- 'uploaded_file': 已经存在于宿主应用里的上传文件引用(需要drive_handle,"
            "这类资产通常是用户在界面里上传后由宿主应用登记,而不是Opie凭空创建)\n"
            "- 'google_drive_doc': 已有的Google Drive文档引用(需要drive_handle)\n"
            "- 'youtube_video': YouTube视频链接引用(需要file_uri)\n"
            "- 'drawing': 手绘图引用(需要drive_handle)"
        ),
    )
    text_content: Optional[str] = Field(None, description="kind='inline_text'时必填,资产的文本内容。")
    mime_type: Optional[str] = Field(None, description="MIME类型,如'image/png'、'video/mp4'。文本资产可不填。")
    drive_handle: Optional[str] = Field(
        None, description="kind为uploaded_file/google_drive_doc/drawing时必填,格式类似'drive:/{file_id}'。"
    )
    file_uri: Optional[str] = Field(None, description="kind='youtube_video'时必填,完整视频URL。")


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
            "登记一个资产(文件/文档/视频/文本),供 create_agent_step / "
            "create_render_step 的 asset_ids 引用。只有 kind='inline_text' 能"
            "凭空创建内容,其余类型是登记已存在的资源引用。调用前先用 "
            "graph_get_overview 检查是否已登记过,避免重复。\n"
            "示例: register_asset(title='FAQ', kind='inline_text', text_content='...') "
            "或 register_asset(title='Logo', kind='uploaded_file', "
            "drive_handle='drive:/abc123', mime_type='image/png')"
        ),
        args_schema=_RegisterAssetArgs,
    )


# ===========================================================================
# 工厂函数:一次性构建全部 9 个工具
# ===========================================================================

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