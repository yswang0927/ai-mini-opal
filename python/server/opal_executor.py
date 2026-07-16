# -*- coding: utf-8 -*-
"""
opal_executor.py
================
基于 LangGraph 的 Opal 图执行器。

将 compile_to_opal_json() 生成的图 JSON 动态转换为可执行的 LangGraph StateGraph,
支持:
- Input 节点: 暂停执行等待用户输入 (interrupt)
- Agent 节点: LLM 驱动的计算/生成,支持工具调用
- Render 节点: LLM 生成 HTML
- Route 条件路由: 根据 agent 的 routing tool call 选择分支

使用方式:
    from opal_executor import OpalExecutor

    executor = OpalExecutor(graph_json, llm_config={...})
    # 首次运行 — 会在第一个 input 节点暂停
    state = executor.start()
    # 提供用户输入后继续
    state = executor.resume(user_inputs={"input_xxx": "hello"})
"""

from __future__ import annotations

import json
import re
import os
from datetime import datetime
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Annotated
from operator import add

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, ToolMessage
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import MemorySaver

from opal_runtime_tools import build_runtime_tools, build_skill_tools
from opal_skills import load_skill_doc


# ---------------------------------------------------------------------------
# Executor State
# ---------------------------------------------------------------------------

class ExecutionStatus(str, Enum):
    PENDING = "pending"
    WAITING_INPUT = "waiting_input"
    RUNNING = "running"
    COMPLETED = "completed"
    ERROR = "error"


class ExecutorState(Dict):
    """LangGraph state schema — 使用 TypedDict 风格。"""
    pass


# 用于 langgraph 的 state 注解
def _replace_dict(existing: dict, new: dict) -> dict:
    """State reducer: 新值覆盖旧值中对应的key。"""
    result = existing.copy()
    result.update(new)
    return result


# ---------------------------------------------------------------------------
# Placeholder 解析
# ---------------------------------------------------------------------------

# 匹配任意 {{ ... }} 占位符块(非贪婪),内部作为 JSON 解析,
# 不依赖字段顺序。花括号内不允许再出现 { 或 },因此不会跨占位符误匹配。
_PLACEHOLDER_RE = re.compile(r'\{\{([^{}]*)\}\}')


def resolve_placeholders(text: str, outputs: Dict[str, str]) -> str:
    """将 prompt 文本中的占位符解析处理。

    占位符是 JSON 对象,字段顺序不固定,例如:
        {{"type":"in","path":"<step_id>","title":"<title>"}}
        {{"title":"<title>","type":"tool","path":"..."}}

    处理规则:
        - type == "in": 替换为上游节点 path 对应的实际输出
        - 其它 type (tool/asset 等): 移除,它们是给 Opal 平台用的
        - 无法解析为 JSON 的块: 原样保留
    """
    def _replace(match):
        raw = match.group(1).strip()
        try:
            spec = json.loads("{" + raw + "}")
        except (ValueError, TypeError):
            # 解析失败,原样保留
            return match.group(0)

        if not isinstance(spec, dict):
            return match.group(0)

        ptype = spec.get("type")
        if ptype == "in":
            step_id = spec.get("path", "")
            title = spec.get("title", step_id)
            return str(outputs.get(step_id, f"[{title}: no output yet]"))
        # tool / asset / 其它类型:执行器不需要,移除
        return ""

    result = _PLACEHOLDER_RE.sub(_replace, text)
    return result.strip()


# 编译产物中 routing 工具的 path,它由执行器的条件路由机制处理,不作为普通工具
_ROUTING_TOOL_PATH = "control-flow/routing"


def extract_tool_paths(text: str) -> List[str]:
    """从 prompt 文本中提取所有 type == "tool" 的占位符 path。

    排除 routing 工具(control-flow/routing),它由条件路由机制单独处理。
    返回去重后的 path 列表,保持出现顺序。
    """
    paths: List[str] = []
    for match in _PLACEHOLDER_RE.finditer(text):
        raw = match.group(1).strip()
        try:
            spec = json.loads("{" + raw + "}")
        except (ValueError, TypeError):
            continue
        if not isinstance(spec, dict) or spec.get("type") != "tool":
            continue
        path = (spec.get("path") or "").strip()
        if not path or path == _ROUTING_TOOL_PATH:
            continue
        if path not in paths:
            paths.append(path)
    return paths


def extract_skill_names(text: str) -> List[str]:
    """从 prompt 文本中提取所有 type == "skill" 的占位符名称(path 字段)。

    对应编译层写入的 {{"type":"skill","path":"<name>","title":"<name>"}}。
    返回去重后的 skill 名称列表,保持出现顺序。
    """
    names: List[str] = []
    for match in _PLACEHOLDER_RE.finditer(text):
        raw = match.group(1).strip()
        try:
            spec = json.loads("{" + raw + "}")
        except (ValueError, TypeError):
            continue
        if not isinstance(spec, dict) or spec.get("type") != "skill":
            continue
        name = (spec.get("path") or "").strip()
        if name and name not in names:
            names.append(name)
    return names


def current_date_system_message() -> SystemMessage:
    """构造一条告知 LLM 当前日期的 system 消息。

    LLM 本身不知道"今天"是哪天,生成日期/时效相关内容(如页面页脚、报告日期、
    "最近"判断)时容易用到训练截止日期。执行期注入实时日期可修正这一点。
    """
    now = datetime.now()
    weekday_cn = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][now.weekday()]
    return SystemMessage(
        content=(
            f"Today's date is {now.strftime('%Y-%m-%d')} ({weekday_cn})。"
            f"当前时间为 {now.strftime('%H:%M')}。"
            "涉及日期/时间的内容请以此为准。"
        )
    )


# ---------------------------------------------------------------------------
# 拓扑排序
# ---------------------------------------------------------------------------

def _topological_sort(nodes: List[Dict], edges: List[Dict]) -> List[str]:
    """对节点进行拓扑排序,返回 node id 的有序列表。"""
    graph: Dict[str, List[str]] = {n["id"]: [] for n in nodes}
    in_degree: Dict[str, int] = {n["id"]: 0 for n in nodes}

    for edge in edges:
        from_id = edge["from"]
        to_id = edge["to"]
        if to_id in graph:
            graph[from_id].append(to_id) if from_id in graph else None
            in_degree[to_id] = in_degree.get(to_id, 0) + 1

    queue = [nid for nid, deg in in_degree.items() if deg == 0]
    result = []

    while queue:
        node = queue.pop(0)
        result.append(node)
        for neighbor in graph.get(node, []):
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    return result


# ---------------------------------------------------------------------------
# 路由解析
# ---------------------------------------------------------------------------

ROUTING_TOOL_PATH = _ROUTING_TOOL_PATH


class _SelectRouteInput(BaseModel):
    target: str = Field(
        description="要跳转到的目标节点 id。必须从提供的候选 id 中精确选择一个。"
    )


def _build_route_tool(
    targets: List[Dict[str, str]],
    decision_holder: Dict[str, str],
) -> StructuredTool:
    """构建 select_route 控制流工具。

    编译器为路由节点在 prompt 中写入 {{"type":"tool","path":"control-flow/routing",...}}
    占位符,并在图上生成 out=<target_id> 的路由边。执行器把它实现为一个真实可调用的
    工具:agent 通过调用 select_route(target=<id>) 显式表达它选择的分支,执行器据此在
    conditional edge 中路由。

    Args:
        targets: [{"id": <step_id>, "title": <title>}, ...] 候选路由目标。
        decision_holder: 用于回传 agent 选择的可变字典,写入 {"target": <id>}。
    """
    valid_ids = {t["id"] for t in targets}
    options_desc = "; ".join(f'"{t["id"]}"({t["title"]})' for t in targets)

    def _select_route(target: str) -> str:
        target = (target or "").strip()
        if target not in valid_ids:
            return (
                f"无效的路由目标 '{target}'。请从以下候选中精确选择一个 id: {options_desc}"
            )
        decision_holder["target"] = target
        return f"已选择路由目标: {target}"

    return StructuredTool.from_function(
        func=_select_route,
        name="select_route",
        description=(
            "选择工作流接下来要执行的分支(路由)。当你根据判断条件确定应走哪条分支时,"
            "调用本工具并传入目标节点 id。可选目标: " + options_desc + "。"
            "你必须且只能调用一次本工具来确定唯一的后续分支。"
        ),
        args_schema=_SelectRouteInput,
    )


# ---------------------------------------------------------------------------
# OpalExecutor
# ---------------------------------------------------------------------------

class OpalExecutor:
    """
    将编译后的 Opal JSON 转换为可执行的 LangGraph 图并运行。

    生命周期:
        1. __init__(graph_json, llm) — 解析 JSON, 构建 LangGraph
        2. start() — 开始执行, 遇到 input 节点暂停
        3. resume(user_inputs) — 提供用户输入后继续执行
        4. get_status() — 查询执行状态
        5. get_outputs() — 获取所有节点的输出
    """

    def __init__(
        self,
        graph_json: Dict[str, Any],
        llm: Optional[ChatOpenAI] = None,
        llm_config: Optional[Dict[str, str]] = None,
    ):
        self.graph_json = graph_json
        self.nodes_config = {n["id"]: n for n in graph_json.get("nodes", [])}
        self.edges = graph_json.get("edges", [])
        self.sorted_node_ids = _topological_sort(graph_json.get("nodes", []), self.edges)

        # 构建依赖关系映射: node_id -> [parent_node_ids]
        self.parents_map: Dict[str, List[str]] = {nid: [] for nid in self.nodes_config}
        # 构建路由映射: node_id -> [route_edges] (out 字段不是 "context" 的边)
        self.routes_map: Dict[str, List[Dict]] = {nid: [] for nid in self.nodes_config}

        for edge in self.edges:
            out_val = (edge.get("out") or "").strip()
            # 数据/依赖边: out 为空 或 "context"。
            #   - 服务端编译产物用 "context" 标记数据边;
            #   - 前端编辑器 (ChatGraph.tsx) 保存的边 out 统一为空字符串 ""。
            # 这类边只表示数据流与执行先后,不产生条件分支。
            # 只有 out 携带非空且非 "context" 的路由标记时,才是真正的条件路由边。
            if out_val == "" or out_val == "context":
                self.parents_map[edge["to"]].append(edge["from"])
            else:
                # routing edge: out 字段携带路由目标标记
                self.routes_map[edge["from"]].append(edge)

        # 反向路由映射: target_node_id -> [router_source_ids]。
        # 一个节点若出现在此表中,说明它是「路由目标」(受控节点):只有当某个
        # 指向它的路由源实际选择了它时,它才应当执行;否则应被跳过。
        # 没有入路由边的节点是纯数据流节点,总是执行。
        self.routers_of: Dict[str, List[str]] = {nid: [] for nid in self.nodes_config}
        for src, route_edges in self.routes_map.items():
            for e in route_edges:
                if e["to"] in self.routers_of:
                    self.routers_of[e["to"]].append(src)

        # LLM 实例
        if llm:
            self.llm = llm
        elif llm_config:
            self.llm = ChatOpenAI(
                base_url=llm_config["base_url"],
                api_key=llm_config["api_key"],
                model=llm_config["model"],
                temperature=0.7,
            )
        else:
            self.llm = ChatOpenAI(
                base_url=os.environ.get("OPIE_LLM_BASE_URL", ""),
                api_key=os.environ.get("OPIE_LLM_API_KEY", ""),
                model=os.environ.get("OPIE_LLM_MODEL", ""),
                temperature=0.7,
            )

        # agent 运行时工具共享的进程内记忆(memory 工具用)
        self._memory_store: Dict[str, str] = {}
        # agent 工具循环的最大轮数,防止无限调用
        self._max_tool_iterations = 6

        # 构建 LangGraph
        self.checkpointer = MemorySaver()
        self.compiled_graph = self._build_langgraph()
        self.thread_id = "default"

        # run-to-here 执行作用域:仅执行「目标节点及其全部祖先」,其余节点一律跳过。
        # None 表示不限制(整图执行)。由 stream_start(target_node=...) 设定,resume 时保持。
        self._run_scope: Optional[set] = None

    def _build_langgraph(self):
        """根据 Opal JSON 构建 LangGraph StateGraph。"""

        from typing import TypedDict

        class GraphState(TypedDict):
            node_outputs: Dict[str, str]
            pending_inputs: List[str]
            current_node: str
            status: str
            error: str
            # 路由节点 -> agent 通过 select_route 工具选定的目标节点 id
            route_decisions: Dict[str, str]
            # 因路由未命中而被跳过、不执行的节点 id 列表
            skipped_nodes: List[str]

        builder = StateGraph(GraphState)

        # 为每个节点创建对应的 graph node function
        for node_id in self.sorted_node_ids:
            node_config = self.nodes_config[node_id]
            node_type = node_config["type"]

            if node_type == "user-inputs":
                builder.add_node(node_id, self._make_input_handler(node_id, node_config))
            elif node_type == "agent-generate":
                builder.add_node(node_id, self._make_agent_handler(node_id, node_config))
            elif node_type == "render-outputs":
                builder.add_node(node_id, self._make_render_handler(node_id, node_config))

        # 边的构建:按拓扑序串成一条线性链。
        #
        # 关键设计:路由不是靠图拓扑(条件边)实现,而是靠每个节点 handler 在运行时
        # 的执行门控(_should_execute)。原因:
        #   - 线性链天然满足「父节点先于子节点」与 fan-in(汇聚节点在拓扑序上位于所有
        #     父节点之后),这正是现有非路由图能正确运行的根基;
        #   - 用条件边做分支跳过时,汇聚节点在 LangGraph 的 Pregel 模型下容易因等待
        #     未触发的分支而行为异常。
        # 因此这里只串线性链;被路由「没选中」的分支节点会在 handler 里自我跳过
        # (不产出 output、记入 skipped_nodes),从而既修复「未选中分支仍执行」的缺陷,
        # 又不动摇 fan-in 的正确性。
        if self.sorted_node_ids:
            builder.add_edge(START, self.sorted_node_ids[0])

        for i, node_id in enumerate(self.sorted_node_ids):
            if i + 1 < len(self.sorted_node_ids):
                builder.add_edge(node_id, self.sorted_node_ids[i + 1])
            else:
                builder.add_edge(node_id, END)

        return builder.compile(checkpointer=self.checkpointer)

    def _should_execute(self, node_id: str, state: Dict) -> bool:
        """运行时执行门控:判断该节点在当前路由决定下是否应当执行。

        因为节点按拓扑序执行,轮到某节点时其所有上游(数据父节点、路由源)都已
        执行完或已被跳过,故可据 state 直接判定:

        1. 路由目标节点(routers_of 非空):只有当指向它的某个路由源实际选择了它
           (route_decisions[router] == node_id)时才执行;否则跳过。
        2. 非路由目标、但有数据父节点:只要没有任何父节点产出 output(说明其所在
           分支在上游已被整体裁剪),就跳过;否则执行。
        3. 源节点(无任何父节点):总是执行。
        """
        # run-to-here 作用域限制:目标节点及其祖先之外的一律跳过。
        if self._run_scope is not None and node_id not in self._run_scope:
            return False

        routers = self.routers_of.get(node_id, [])
        if routers:
            decisions = state.get("route_decisions", {}) or {}
            return any(decisions.get(r) == node_id for r in routers)

        data_parents = self.parents_map.get(node_id, [])
        if data_parents:
            outputs = state.get("node_outputs", {})
            skipped = set(state.get("skipped_nodes", []) or [])
            # 至少一个父节点有产出(且不是被跳过的)即视为分支存活。
            return any(p in outputs and p not in skipped for p in data_parents)

        return True

    def _skip_state(self, node_id: str, state: Dict) -> Dict:
        """构造「跳过该节点」后的 state:不产出 output,记入 skipped_nodes。"""
        skipped = list(state.get("skipped_nodes", []) or [])
        if node_id not in skipped:
            skipped.append(node_id)
        return {**state, "skipped_nodes": skipped, "current_node": node_id}

    def _make_input_handler(self, node_id: str, node_config: Dict):
        """创建 input 节点的处理函数 — 使用 interrupt 等待用户输入。"""
        def handler(state: Dict) -> Dict:
            # 路由未命中的分支上的输入节点:跳过,不向用户提问。
            if not self._should_execute(node_id, state):
                return self._skip_state(node_id, state)

            outputs = state.get("node_outputs", {})

            # 如果已有该节点的输出(resume 时提供的),直接跳过
            if node_id in outputs and outputs[node_id]:
                return state

            # 获取提问文案
            config = node_config.get("configuration", {})
            question = config.get("description", {}).get("content", "Please provide input")

            # 使用 interrupt 暂停执行,等待用户输入
            user_value = interrupt({
                "node_id": node_id,
                "title": node_config.get("metadata", {}).get("title", node_id),
                "question": question,
                "modality": config.get("p-modality", "Any"),
                "required": config.get("p-required", True),
            })

            # resume 后 user_value 是用户提供的值
            new_outputs = outputs.copy()
            new_outputs[node_id] = user_value
            return {
                **state,
                "node_outputs": new_outputs,
                "current_node": node_id,
                "status": "running",
            }
        return handler

    def _make_agent_handler(self, node_id: str, node_config: Dict):
        """创建 agent 节点的处理函数 — 调用 LLM 执行任务。"""
        # 该节点声明的路由目标(编译期生成的 out=<target_id> 路由边)。
        route_edges = self.routes_map.get(node_id, [])
        route_targets = [
            {
                "id": e["to"],
                "title": self.nodes_config.get(e["to"], {})
                .get("metadata", {})
                .get("title", e["to"]),
            }
            for e in route_edges
        ]

        def handler(state: Dict) -> Dict:
            # 路由未命中的分支上的节点:跳过,不调用 LLM。
            if not self._should_execute(node_id, state):
                return self._skip_state(node_id, state)

            outputs = state.get("node_outputs", {})
            config = node_config.get("configuration", {})

            # 获取 prompt 并解析占位符
            prompt_content = config.get("config$prompt", {}).get("content", "")
            resolved_prompt = resolve_placeholders(prompt_content, outputs)

            # 构建消息
            messages = [current_date_system_message()]

            # system instruction (terse mode etc.)
            sys_inst = config.get("system-instruction")
            if sys_inst and sys_inst.get("content"):
                messages.append(SystemMessage(content=sys_inst["content"]))

            # 从 prompt 中提取声明的 skills,把各自的 SKILL.md 说明注入为 system 消息,
            # 让 agent 知道每个 skill 能做什么、脚本怎么调用。
            skill_names = extract_skill_names(prompt_content)
            skill_docs = self._build_skill_docs_message(skill_names)
            if skill_docs:
                messages.append(SystemMessage(content=skill_docs))

            messages.append(HumanMessage(content=resolved_prompt))

            # 从原始 prompt 中提取声明的运行时工具,构建并 bind 到 LLM。
            tool_paths = extract_tool_paths(prompt_content)
            tools = build_runtime_tools(tool_paths, memory_store=self._memory_store)
            # 声明了 skills 的节点,追加受限的 run_skill_script 工具(白名单=声明的 skills)。
            tools = tools + build_skill_tools(skill_names)

            # 该节点是路由源:构建真实可调用的 select_route 工具,让 agent 显式选择分支。
            # decision_holder 承接工具回传的选择,执行结束后写入 state.route_decisions。
            decision_holder: Dict[str, str] = {}
            if route_targets:
                tools = tools + [_build_route_tool(route_targets, decision_holder)]

            # 调用 LLM(带工具则运行工具调用循环)
            try:
                if tools:
                    result = self._run_agent_with_tools(messages, tools, node_id)
                else:
                    response = self.llm.invoke(messages)
                    result = response.content
            except Exception as e:
                result = f"[Error executing agent node {node_id}: {str(e)}]"

            new_outputs = outputs.copy()
            new_outputs[node_id] = result

            new_state = {
                **state,
                "node_outputs": new_outputs,
                "current_node": node_id,
                "status": "running",
            }

            # 记录路由决定(若 agent 调用了 select_route)。
            if route_targets:
                decisions = dict(state.get("route_decisions", {}))
                chosen = decision_holder.get("target")
                if not chosen:
                    # agent 未显式选择:回退到第一个目标,保证图能继续推进。
                    chosen = route_targets[0]["id"]
                decisions[node_id] = chosen
                new_state["route_decisions"] = decisions

            return new_state
        return handler

    def _build_skill_docs_message(self, skill_names: List[str]) -> str:
        """把声明的 skills 的 SKILL.md 正文拼成一段 system 提示。

        提示 agent 有哪些 skill 可用、如何借助 run_skill_script 调用其脚本。
        脚本示例里的 /mnt/skills/... 挂载路径可原样使用(运行时会自动映射)。
        """
        docs = []
        for name in skill_names:
            doc = load_skill_doc(name)
            if not doc:
                continue
            docs.append(f"===== SKILL: {name} =====\n{doc}")
        if not docs:
            return ""
        header = (
            "你可以使用以下 Agent Skill 来完成任务。每个 skill 附带其说明书(SKILL.md)。"
            "要运行 skill 提供的脚本,调用 run_skill_script 工具,传入 skill 名称、脚本相对路径与参数;"
            "说明书里出现的 /mnt/skills/... 路径可直接使用(会被自动映射到真实位置)。"
            "请严格按说明书的步骤与命令来操作。\n\n"
        )
        return header + "\n\n".join(docs)

    def _run_agent_with_tools(self, messages: List, tools: List, node_id: str) -> str:
        """运行 agent 工具调用循环。

        反复: LLM 生成 -> 若请求工具调用则执行并回填 ToolMessage -> 再次生成,
        直到 LLM 不再请求工具或达到最大轮数。
        """
        llm_with_tools = self.llm.bind_tools(tools)
        tools_by_name = {t.name: t for t in tools}
        convo = list(messages)

        for _ in range(self._max_tool_iterations):
            ai_msg = llm_with_tools.invoke(convo)
            convo.append(ai_msg)

            tool_calls = getattr(ai_msg, "tool_calls", None) or []
            if not tool_calls:
                return ai_msg.content or ""

            # 执行每个被请求的工具,回填结果
            for call in tool_calls:
                name = call.get("name")
                args = call.get("args", {}) or {}
                call_id = call.get("id", "")
                tool = tools_by_name.get(name)
                if tool is None:
                    tool_result = f"[未知工具: {name}]"
                else:
                    try:
                        tool_result = tool.invoke(args)
                    except Exception as e:  # noqa: BLE001
                        tool_result = f"[工具 {name} 执行出错: {e}]"
                convo.append(
                    ToolMessage(content=str(tool_result), tool_call_id=call_id)
                )

        # 达到最大轮数仍在调用工具 — 强制让 LLM 基于已有信息给出最终回答
        convo.append(
            HumanMessage(
                content="已达到工具调用上限,请基于以上工具结果给出最终答案。"
            )
        )
        final = self.llm.invoke(convo)
        return final.content or ""

    def _make_render_handler(self, node_id: str, node_config: Dict):
        """创建 render 节点的处理函数 — 调用 LLM 生成 HTML。"""
        def handler(state: Dict) -> Dict:
            # 路由未命中的分支上的节点:跳过,不调用 LLM。
            if not self._should_execute(node_id, state):
                return self._skip_state(node_id, state)

            outputs = state.get("node_outputs", {})
            config = node_config.get("configuration", {})

            # 获取 design brief 并解析占位符
            brief_content = config.get("text", {}).get("content", "")
            resolved_brief = resolve_placeholders(brief_content, outputs)

            # 构建消息: 使用 render 节点的 system instruction
            messages = [current_date_system_message()]

            sys_inst = config.get("system-instruction")
            if sys_inst and sys_inst.get("content"):
                messages.append(SystemMessage(content=sys_inst["content"]))
            else:
                # 使用默认的 render system instruction
                messages.append(SystemMessage(content=_DEFAULT_RENDER_SYSTEM_PROMPT))

            messages.append(HumanMessage(content=resolved_brief))

            # 调用 LLM
            try:
                response = self.llm.invoke(messages)
                result = response.content
            except Exception as e:
                result = f"<html><body><p>Error: {str(e)}</p></body></html>"

            new_outputs = outputs.copy()
            new_outputs[node_id] = result
            return {
                **state,
                "node_outputs": new_outputs,
                "current_node": node_id,
                "status": "completed" if self._is_terminal(node_id) else "running",
            }
        return handler

    def _is_terminal(self, node_id: str) -> bool:
        """判断该节点是否是图的终端节点(没有下游边)。"""
        for edge in self.edges:
            if edge["from"] == node_id:
                return False
        return True

    def _ancestors_closure(self, node_id: str) -> set:
        """计算「运行到此节点」所需的执行作用域:目标节点及其全部上游祖先。

        沿数据父边(parents_map)与路由源边(routers_of)反向遍历。两类上游都要
        纳入:数据父提供 prompt 占位符所需的产出;路由源负责做出选中本节点的路由决定
        (否则 _should_execute 会因 route_decisions 缺失而把目标判为跳过)。
        """
        scope: set = set()
        stack = [node_id]
        while stack:
            nid = stack.pop()
            if nid in scope or nid not in self.nodes_config:
                continue
            scope.add(nid)
            for parent in self.parents_map.get(nid, []):
                stack.append(parent)
            for router in self.routers_of.get(nid, []):
                stack.append(router)
        return scope

    def _set_run_scope(self, target_node: Optional[str]) -> None:
        """设置「运行到此节点」的执行作用域。target_node 为空或非法时清除限制(整图执行)。"""
        if target_node and target_node in self.nodes_config:
            self._run_scope = self._ancestors_closure(target_node)
        else:
            self._run_scope = None

    # ------------------------------------------------------------------
    # 公开 API
    # ------------------------------------------------------------------

    def start(self, thread_id: str = "default") -> Dict[str, Any]:
        """
        开始执行图。遇到第一个 input 节点会暂停。
        返回执行状态信息。
        """
        self.thread_id = thread_id
        config = {"configurable": {"thread_id": thread_id}}
        initial_state = {
            "node_outputs": {},
            "pending_inputs": [],
            "current_node": "",
            "status": "running",
            "error": "",
            "route_decisions": {},
            "skipped_nodes": [],
        }

        self.compiled_graph.invoke(initial_state, config=config)
        return self._get_current_state(thread_id)

    def resume(self, user_inputs: Dict[str, str], thread_id: str = "default") -> Dict[str, Any]:
        """
        提供用户输入后恢复执行。

        Args:
            user_inputs: {node_id: user_value} 映射
            thread_id: 线程ID

        Returns:
            执行状态信息
        """
        self.thread_id = thread_id
        config = {"configurable": {"thread_id": thread_id}}

        # LangGraph interrupt/resume: 每次 resume 只处理一个 interrupt,
        # 对于多个 input 节点需要多次 resume
        for node_id, value in user_inputs.items():
            self.compiled_graph.invoke(Command(resume=value), config=config)

        return self._get_current_state(thread_id)

    def stream_start(self, thread_id: str = "default", target_node: Optional[str] = None):
        """
        流式启动执行。以生成器形式逐节点产出事件,便于前端通过 SSE 实时感知进度。

        产出的事件(dict)形如:
            {"event": "node_complete", "node_id": ..., "node_type": ..., "output": ...}
            {"event": "waiting_input", "interrupts": [...], "waiting_nodes": [...]}
            {"event": "completed", "node_outputs": {...}}
            {"event": "error", "error": ...}
        每个事件都带 completed_nodes / current_node,方便前端重建节点状态。

        target_node 非空时启用「运行到此节点」:仅执行目标节点及其全部祖先,
        其余节点(含目标下游)全部跳过并发 node_skipped 事件。
        """
        self.thread_id = thread_id
        self._set_run_scope(target_node)
        config = {"configurable": {"thread_id": thread_id}}
        initial_state = {
            "node_outputs": {},
            "pending_inputs": [],
            "current_node": "",
            "status": "running",
            "error": "",
            "route_decisions": {},
            "skipped_nodes": [],
        }
        yield from self._stream_run(initial_state, thread_id, config)

    def stream_resume(self, user_inputs: Dict[str, str], thread_id: str = "default"):
        """
        流式恢复执行。为每个用户输入依次 resume,逐节点产出事件。

        与 resume() 一样,LangGraph 每次 resume 只消费一个 interrupt,
        多个 input 节点需要多次 resume;这里对每个输入分别流式执行。
        """
        self.thread_id = thread_id
        config = {"configurable": {"thread_id": thread_id}}

        for node_id, value in user_inputs.items():
            for event in self._stream_run(Command(resume=value), thread_id, config):
                # 中间一次 resume 命中新的 interrupt 时,先产出 waiting_input 让前端提示,
                # 但不结束整体流程(可能还有后续输入未提交)。
                yield event

    def _stream_run(self, graph_input, thread_id: str, config: Dict):
        """
        执行一次 compiled_graph.stream() 并把 LangGraph 的 update 转成前端事件。

        使用 stream_mode="updates": 每个节点执行完成后产出 {node_id: 返回的 state}。
        命中 interrupt 时产出 {"__interrupt__": (Interrupt(...),)}。
        """
        try:
            for chunk in self.compiled_graph.stream(
                graph_input, config=config, stream_mode="updates"
            ):
                if not isinstance(chunk, dict):
                    continue

                # 命中 interrupt: 图在某个 input 节点暂停
                if "__interrupt__" in chunk:
                    snapshot = self.compiled_graph.get_state(config)
                    interrupts = self._collect_interrupts(snapshot)
                    completed = self._completed_from_snapshot(snapshot)
                    yield {
                        "event": "waiting_input",
                        "interrupts": interrupts,
                        "waiting_nodes": list(snapshot.next) if snapshot else [],
                        "completed_nodes": completed,
                        "current_node": "",
                    }
                    return

                # 普通节点完成: chunk = {node_id: 该节点返回的 state}
                for node_id, node_state in chunk.items():
                    ns = node_state if isinstance(node_state, dict) else {}
                    outputs = ns.get("node_outputs", {})
                    skipped = set(ns.get("skipped_nodes", []) or [])
                    # 已完成 = 有产出;已跳过的节点视为「已处理」,不再计入待运行。
                    completed = [nid for nid in self.sorted_node_ids if nid in outputs]
                    done = set(outputs) | skipped
                    # 拓扑序中下一个既未完成也未跳过的节点视为「即将/正在运行」。
                    next_running = next(
                        (nid for nid in self.sorted_node_ids if nid not in done),
                        "",
                    )
                    # 本 chunk 对应的节点若是被跳过的,发 node_skipped 事件供前端置灰。
                    if node_id in skipped and node_id not in outputs:
                        yield {
                            "event": "node_skipped",
                            "node_id": node_id,
                            "node_type": self.nodes_config.get(node_id, {}).get("type", ""),
                            "completed_nodes": completed,
                            "skipped_nodes": list(skipped),
                            "current_node": next_running,
                        }
                        continue
                    yield {
                        "event": "node_complete",
                        "node_id": node_id,
                        "node_type": self.nodes_config.get(node_id, {}).get("type", ""),
                        "output": outputs.get(node_id, ""),
                        "completed_nodes": completed,
                        "skipped_nodes": list(skipped),
                        "current_node": next_running,
                    }

            # 流正常结束(无 interrupt): 判断是否全图完成
            final = self._get_current_state(thread_id)
            if final.get("status") == "waiting_input":
                # 理论上已在上面处理,这里兜底
                return
            yield {
                "event": "completed",
                "node_outputs": final.get("node_outputs", {}),
                "completed_nodes": final.get("completed_nodes", []),
                "skipped_nodes": final.get("skipped_nodes", []),
                "current_node": "",
            }
        except Exception as e:  # noqa: BLE001 — 需要把任何执行错误转成事件回传前端
            yield {"event": "error", "error": str(e)}

    def _collect_interrupts(self, snapshot) -> List[Dict[str, Any]]:
        """从 checkpoint snapshot 中提取待处理的 interrupt 载荷。"""
        interrupts: List[Dict[str, Any]] = []
        if snapshot and getattr(snapshot, "tasks", None):
            for task in snapshot.tasks:
                for intr in getattr(task, "interrupts", None) or []:
                    interrupts.append(intr.value)
        return interrupts

    def _completed_from_snapshot(self, snapshot) -> List[str]:
        """从 snapshot 计算已完成节点列表。"""
        values = getattr(snapshot, "values", None) or {}
        outputs = values.get("node_outputs", {})
        return [nid for nid in self.sorted_node_ids if nid in outputs]

    def get_status(self, thread_id: str = "default") -> Dict[str, Any]:
        """获取当前执行状态。"""
        return self._get_current_state(thread_id)

    def get_outputs(self, thread_id: str = "default") -> Dict[str, str]:
        """获取所有节点的输出。"""
        state = self._get_current_state(thread_id)
        return state.get("node_outputs", {})

    def _get_current_state(self, thread_id: str) -> Dict[str, Any]:
        """获取 LangGraph 的当前 checkpoint 状态。"""
        config = {"configurable": {"thread_id": thread_id}}
        try:
            snapshot = self.compiled_graph.get_state(config)
            if snapshot and snapshot.values:
                result = self._format_result(snapshot.values)
                # 检查是否有 pending interrupt
                if snapshot.next:
                    result["status"] = "waiting_input"
                    result["waiting_nodes"] = list(snapshot.next)
                    # 获取 interrupt 信息
                    if hasattr(snapshot, 'tasks') and snapshot.tasks:
                        interrupts = []
                        for task in snapshot.tasks:
                            if hasattr(task, 'interrupts') and task.interrupts:
                                for intr in task.interrupts:
                                    interrupts.append(intr.value)
                        if interrupts:
                            result["interrupts"] = interrupts
                return result
            return {"status": "pending", "node_outputs": {}}
        except Exception:
            return {"status": "pending", "node_outputs": {}}

    def _format_result(self, state: Dict) -> Dict[str, Any]:
        """格式化执行结果。"""
        if not state:
            return {"status": "pending", "node_outputs": {}}

        outputs = state.get("node_outputs", {})
        skipped = set(state.get("skipped_nodes", []) or [])
        status = state.get("status", "running")

        # 判断是否所有节点都已「处理完」:有产出 或 被路由跳过。
        done = set(outputs) | skipped
        all_done = all(nid in done for nid in self.sorted_node_ids)
        if all_done:
            status = "completed"

        return {
            "status": status,
            "current_node": state.get("current_node", ""),
            "node_outputs": outputs,
            "route_decisions": dict(state.get("route_decisions", {}) or {}),
            "skipped_nodes": [nid for nid in self.sorted_node_ids if nid in skipped],
            "completed_nodes": [nid for nid in self.sorted_node_ids if nid in outputs],
            "pending_nodes": [
                nid for nid in self.sorted_node_ids if nid not in done
            ],
        }


# ---------------------------------------------------------------------------
# 默认 Render System Prompt (精简版,用于执行器)
# ---------------------------------------------------------------------------

_DEFAULT_RENDER_SYSTEM_PROMPT = r"""You are an expert HTML/CSS developer. Your task is to generate a single, self-contained HTML document for rendering in an iframe, based on user instructions and data. The page must:
- Be a single HTML file with inline CSS and no external dependencies
- Use modern CSS (flexbox/grid) for layout
- Be responsive and visually polished
- Include all content data directly in the HTML, you can use emojis and placeholder text as needed
- Use UTF-8 encoding
- Output ONLY the HTML code, no explanations

**Visual aesthetic:**
    * Aesthetics are crucial. Make the page look amazing, especially on mobile.
    * Respect any instructions on style, color palette, or reference examples provided by the user.
    * **CRITICAL: Aim for premium, state-of-the-art designs. Avoid simple minimum viable products.**
    * **Use Rich Aesthetics**: The USER should be wowed at first glance by the design. Use best practices in modern web design (e.g. vibrant colors, dark modes, glassmorphism, and dynamic animations) to create a stunning first impression. Failure to do this is UNACCEPTABLE.
    * **Prioritize Visual Excellence**: Implement designs that will WOW the user and feel extremely premium:
        - Avoid generic colors (plain red, blue, green). Use curated, harmonious color palettes (e.g., HSL tailored colors, sleek dark modes).
        - Use smooth gradients.
        - Add subtle micro-animations for enhanced user experience.
    * **Use a Dynamic Design**: An interface that feels responsive and alive encourages interaction. Achieve this with hover effects and interactive elements. Micro-animations, in particular, are highly effective for improving user engagement.
    * **Thematic Specificity**: Do not just create a generic layout. Define a clear "vibe" or theme based on the content. Use specific aesthetic keywords (e.g., "Glassmorphism", "Neobrutalism", "Minimalist", "Comic Book Style") to guide the design.
    * **Readability**: Pay extra attention to readability. Ensure the text is always readable with sufficient contrast against the background. Choose fonts and colors that enhance legibility.

**Design and Functionality:**
    * **Layout Dynamics**: Break the grid. Avoid strict, identical grid columns. Use asymmetrical layouts, Bento grids, or responsive flexbox layouts where some elements span full width to create visual interest and emphasize key content.
    * Thoroughly analyze the user's instructions to determine the desired type of webpage, application, or visualization. What are the key features, layouts, or functionality?
    * Analyze any provided data to identify the most compelling layout or visualization of it. For example, if the user requests a visualization, select an appropriate chart type (bar, line, pie, scatter, etc.) to create the most insightful and visually compelling representation. Or if user instructions say \`use a carousel format\`, you should consider how to break the content and any media into different card components to display within the carousel.
    * If requirements are underspecified, make reasonable assumptions to complete the design and functionality. Your goal is to deliver a working product with no placeholder content.
    * Ensure the generated code is valid and functional. Return only the code, and open the HTML codeblock with the literal string "\`\`\`html".
    * The output must be a complete and valid HTML document with no placeholder content for the developer to fill in.

**Constraints:**
  * **External Links:** You ARE allowed to generate external links (\`<a href="...">\` and \`window.open(...)\`) to external websites (e.g. google.com, wikipedia.org) for user navigation.
  * **NO External Embeds:** Do NOT embed any external resources (e.g. \`<script src="...">\`, \`<img src="...">\`, \`<iframe src="...">\`, \`<link href="...">\`) from external URLs. Content Security Policy (CSP) will block them.
  * **Media Restriction:** ONLY use media URLs that are explicitly passed in the input. Do NOT generate or hallucinate any other media URLs (e.g. from placeholder sites or external CDNs).
  * **Render All Media:** You MUST render ALL media (images, videos, audio) that are passed in. Do NOT skip or omit any provided media items. Every passed-in media URL must appear in the final HTML output.
  * **Navigation Restriction:** Do NOT generate unneeded fake links or buttons to sub-pages (e.g. "About", "Contact", "Learn More") unless explicitly requested. Stick to the plan and the provided content.
  * **Footer Restriction:** **NEVER** generate any footer content, including legal footers like "All rights reserved" or "Copyright 2026".
"""
