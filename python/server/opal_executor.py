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
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Annotated
from operator import add

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import MemorySaver


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

ROUTING_TOOL_PATH = "control-flow/routing"


def _extract_route_target(agent_output: str, routes_config: List[Dict]) -> Optional[str]:
    """
    从 agent 输出中解析它选择的路由目标。
    Agent 在有 routes 时会输出包含 routing tool call 的信息,
    我们从中提取 instance 字段(即目标 step_id)。
    """
    for route in routes_config:
        target_id = route.get("target_step_id") or route.get("to")
        if target_id and target_id in agent_output:
            return target_id
    return routes_config[0]["target_step_id"] if routes_config else None


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

        # 构建 LangGraph
        self.checkpointer = MemorySaver()
        self.compiled_graph = self._build_langgraph()
        self.thread_id = "default"

    def _build_langgraph(self):
        """根据 Opal JSON 构建 LangGraph StateGraph。"""

        from typing import TypedDict

        class GraphState(TypedDict):
            node_outputs: Dict[str, str]
            pending_inputs: List[str]
            current_node: str
            status: str
            error: str

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

        # 构建边: 按拓扑序串联,带路由的节点使用 conditional edge
        nodes_with_routes = {nid for nid, routes in self.routes_map.items() if routes}

        # 添加从 START 到第一个节点的边
        if self.sorted_node_ids:
            builder.add_edge(START, self.sorted_node_ids[0])

        # 为每对相邻节点添加边
        for i, node_id in enumerate(self.sorted_node_ids):
            if node_id in nodes_with_routes:
                # 带路由的节点: 添加 conditional edge
                route_targets = [e["to"] for e in self.routes_map[node_id]]
                builder.add_conditional_edges(
                    node_id,
                    self._make_route_selector(node_id, route_targets),
                    {target: target for target in route_targets},
                )
            else:
                # 普通节点: 连接到拓扑序中的下一个节点
                if i + 1 < len(self.sorted_node_ids):
                    next_id = self.sorted_node_ids[i + 1]
                    # 跳过路由目标节点(它们由 conditional edge 到达)
                    all_route_targets = set()
                    for routes in self.routes_map.values():
                        for r in routes:
                            all_route_targets.add(r["to"])
                    if next_id not in all_route_targets or node_id in all_route_targets:
                        builder.add_edge(node_id, next_id)
                    else:
                        # 找到下一个非路由目标节点
                        found_next = False
                        for j in range(i + 1, len(self.sorted_node_ids)):
                            candidate = self.sorted_node_ids[j]
                            if candidate not in all_route_targets:
                                builder.add_edge(node_id, candidate)
                                found_next = True
                                break
                        if not found_next:
                            builder.add_edge(node_id, END)
                else:
                    builder.add_edge(node_id, END)

        return builder.compile(checkpointer=self.checkpointer)

    def _make_input_handler(self, node_id: str, node_config: Dict):
        """创建 input 节点的处理函数 — 使用 interrupt 等待用户输入。"""
        def handler(state: Dict) -> Dict:
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
        def handler(state: Dict) -> Dict:
            outputs = state.get("node_outputs", {})
            config = node_config.get("configuration", {})

            # 获取 prompt 并解析占位符
            prompt_content = config.get("config$prompt", {}).get("content", "")
            resolved_prompt = resolve_placeholders(prompt_content, outputs)

            # 构建消息
            messages = []

            # system instruction (terse mode etc.)
            sys_inst = config.get("system-instruction")
            if sys_inst and sys_inst.get("content"):
                messages.append(SystemMessage(content=sys_inst["content"]))

            messages.append(HumanMessage(content=resolved_prompt))

            # 调用 LLM
            try:
                response = self.llm.invoke(messages)
                result = response.content
            except Exception as e:
                result = f"[Error executing agent node {node_id}: {str(e)}]"

            new_outputs = outputs.copy()
            new_outputs[node_id] = result
            return {
                **state,
                "node_outputs": new_outputs,
                "current_node": node_id,
                "status": "running",
            }
        return handler

    def _make_render_handler(self, node_id: str, node_config: Dict):
        """创建 render 节点的处理函数 — 调用 LLM 生成 HTML。"""
        def handler(state: Dict) -> Dict:
            outputs = state.get("node_outputs", {})
            config = node_config.get("configuration", {})

            # 获取 design brief 并解析占位符
            brief_content = config.get("text", {}).get("content", "")
            resolved_brief = resolve_placeholders(brief_content, outputs)

            # 构建消息: 使用 render 节点的 system instruction
            messages = []

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

    def _make_route_selector(self, source_id: str, targets: List[str]):
        """创建条件路由选择函数。"""
        def selector(state: Dict) -> str:
            outputs = state.get("node_outputs", {})
            agent_output = outputs.get(source_id, "")

            # 从 agent 输出中匹配路由目标
            for target in targets:
                if target in agent_output:
                    return target

            # 默认走第一个路由
            return targets[0] if targets else END
        return selector

    def _is_terminal(self, node_id: str) -> bool:
        """判断该节点是否是图的终端节点(没有下游边)。"""
        for edge in self.edges:
            if edge["from"] == node_id:
                return False
        return True

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
        status = state.get("status", "running")

        # 判断是否所有节点都已执行完
        all_done = all(nid in outputs for nid in self.sorted_node_ids)
        if all_done:
            status = "completed"

        return {
            "status": status,
            "current_node": state.get("current_node", ""),
            "node_outputs": outputs,
            "completed_nodes": [nid for nid in self.sorted_node_ids if nid in outputs],
            "pending_nodes": [nid for nid in self.sorted_node_ids if nid not in outputs],
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
