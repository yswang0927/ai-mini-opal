# -*- coding: utf-8 -*-
"""
test_opal_executor.py
=====================
OpalExecutor 的单元测试 + 集成测试。

运行方式:
    python test_opal_executor.py            # 运行所有测试(含真实LLM调用)
    python test_opal_executor.py --unit     # 仅单元测试(不调用LLM)
    python test_opal_executor.py --e2e      # 仅端到端测试(需要LLM配置)
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

load_dotenv()

from opal_executor import (
    OpalExecutor,
    resolve_placeholders,
    _topological_sort,
)


SAMPLE_GRAPH_PATH = Path(__file__).parent / "generated_graph.json"


def _load_sample_graph() -> dict:
    return json.loads(SAMPLE_GRAPH_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Unit Tests (no LLM calls)
# ---------------------------------------------------------------------------


class TestTopologicalSort(unittest.TestCase):
    def test_linear_graph(self):
        nodes = [{"id": "a"}, {"id": "b"}, {"id": "c"}]
        edges = [
            {"from": "a", "to": "b", "out": "context"},
            {"from": "b", "to": "c", "out": "context"},
        ]
        result = _topological_sort(nodes, edges)
        self.assertEqual(result, ["a", "b", "c"])

    def test_diamond_graph(self):
        nodes = [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}]
        edges = [
            {"from": "a", "to": "b", "out": "context"},
            {"from": "a", "to": "c", "out": "context"},
            {"from": "b", "to": "d", "out": "context"},
            {"from": "c", "to": "d", "out": "context"},
        ]
        result = _topological_sort(nodes, edges)
        self.assertLess(result.index("a"), result.index("b"))
        self.assertLess(result.index("a"), result.index("c"))
        self.assertLess(result.index("b"), result.index("d"))
        self.assertLess(result.index("c"), result.index("d"))

    def test_sample_graph(self):
        graph = _load_sample_graph()
        result = _topological_sort(graph["nodes"], graph["edges"])
        # 源节点(user-inputs)排在最前,最终 render 节点排在最后。
        self.assertIn(result[0], ("ask_user_client_name",
                                  "9de7f9a7-3c63-4979-9956-c0c7bf60dacb"))
        self.assertEqual(result[-1], "node_step_meeting_brief")


class TestResolvePlaceholders(unittest.TestCase):
    def test_basic_replacement(self):
        text = 'Topic: {{"type":"in","path":"node_1","title":"My Input"}}'
        outputs = {"node_1": "Hello World"}
        result = resolve_placeholders(text, outputs)
        self.assertEqual(result, "Topic: Hello World")

    def test_missing_output(self):
        text = 'Topic: {{"type":"in","path":"node_1","title":"My Input"}}'
        outputs = {}
        result = resolve_placeholders(text, outputs)
        self.assertIn("[My Input: no output yet]", result)

    def test_tool_placeholder_removed(self):
        text = 'Use: {{"type":"tool","path":"search-web","title":"Search Web"}}'
        result = resolve_placeholders(text, {})
        self.assertNotIn("search-web", result)

    def test_multiple_placeholders(self):
        text = (
            'A: {{"type":"in","path":"n1","title":"First"}} and '
            'B: {{"type":"in","path":"n2","title":"Second"}}'
        )
        outputs = {"n1": "val1", "n2": "val2"}
        result = resolve_placeholders(text, outputs)
        self.assertIn("val1", result)
        self.assertIn("val2", result)

    def test_field_order_independent(self):
        """字段顺序不固定时也能正确解析。"""
        text = 'Topic: {{"title":"My Input","path":"node_1","type":"in"}}'
        outputs = {"node_1": "Hello World"}
        result = resolve_placeholders(text, outputs)
        self.assertEqual(result, "Topic: Hello World")

    def test_tool_placeholder_field_order(self):
        """tool 占位符字段顺序变化也能被移除。"""
        text = 'Use: {{"title":"Search Web","type":"tool","path":"search-web"}}'
        result = resolve_placeholders(text, {})
        self.assertNotIn("search-web", result)

    def test_asset_placeholder_removed(self):
        text = 'Img: {{"type":"asset","path":"logo.png","mimeType":"image/png","title":"Logo"}}'
        result = resolve_placeholders(text, {})
        self.assertNotIn("logo.png", result)

    def test_malformed_placeholder_preserved(self):
        """无法解析为 JSON 的块原样保留。"""
        text = 'Keep this: {{not valid json}}'
        result = resolve_placeholders(text, {})
        self.assertIn("{{not valid json}}", result)

    def test_skipped_placeholder_resolved_to_skipped(self):
        text = 'Topic: {{"type":"in","path":"node_1","title":"My Input"}}'
        outputs = {}
        result = resolve_placeholders(text, outputs, skipped_nodes={"node_1"})
        self.assertEqual(result, "Topic: [Skipped]")


class TestExecutorBuild(unittest.TestCase):
    """测试 executor 的图构建(不触发 LLM)。"""

    def setUp(self):
        os.environ.setdefault("OPIE_LLM_BASE_URL", "https://api.deepseek.com")
        os.environ.setdefault("OPIE_LLM_API_KEY", "sk-test")
        os.environ.setdefault("OPIE_LLM_MODEL", "deepseek-v4-flash")

    def test_build_from_sample(self):
        graph = _load_sample_graph()
        executor = OpalExecutor(graph)
        self.assertEqual(len(executor.sorted_node_ids), len(graph["nodes"]))
        self.assertIsNotNone(executor.compiled_graph)

    def test_parents_map(self):
        graph = _load_sample_graph()
        executor = OpalExecutor(graph)
        # 源输入节点没有数据父节点。
        self.assertEqual(executor.parents_map["ask_user_client_name"], [])
        # 最终 render 节点汇聚多个上游(fan-in)。
        self.assertIn(
            "node_step_brief_content",
            executor.parents_map["node_step_meeting_brief"],
        )

    def test_start_pauses_at_input(self):
        graph = _load_sample_graph()
        executor = OpalExecutor(graph)
        state = executor.start(thread_id="test-build-1")
        self.assertEqual(state["status"], "waiting_input")
        # 拓扑序第一个节点是某个 user-inputs 节点,应在此暂停等待输入。
        first = executor.sorted_node_ids[0]
        self.assertIn(first, state.get("waiting_nodes", []))


class TestFrontendEdgeClassification(unittest.TestCase):
    """前端 (ChatGraph.tsx) 保存的边 out 统一为空字符串 "",
    这类数据边不应被误判为条件路由边。回归 bug:多个 input 节点
    只弹出第一个,填完后直接跑完,不再提示后续 input。"""

    def setUp(self):
        os.environ.setdefault("OPIE_LLM_BASE_URL", "https://api.deepseek.com")
        os.environ.setdefault("OPIE_LLM_API_KEY", "sk-test")
        os.environ.setdefault("OPIE_LLM_MODEL", "deepseek-v4-flash")

    def _frontend_two_input_graph(self):
        # 模拟前端产物:所有边 out == ""(见 ChatGraph.tsx onGraphChanged)
        return {
            "title": "BMI",
            "nodes": [
                {"id": "in_cm", "type": "user-inputs",
                 "metadata": {"title": "Height"},
                 "configuration": {"description": {"content": "cm?"}}},
                {"id": "in_kg", "type": "user-inputs",
                 "metadata": {"title": "Weight"},
                 "configuration": {"description": {"content": "kg?"}}},
                {"id": "agent_bmi", "type": "agent-generate",
                 "configuration": {"config$prompt": {"content": "compute"}}},
                {"id": "render_bmi", "type": "render-outputs",
                 "configuration": {"text": {"content": "show"}}},
            ],
            "edges": [
                {"from": "in_cm", "to": "agent_bmi", "out": "", "in": ""},
                {"from": "in_kg", "to": "agent_bmi", "out": "", "in": ""},
                {"from": "in_cm", "to": "render_bmi", "out": "", "in": ""},
                {"from": "in_kg", "to": "render_bmi", "out": "", "in": ""},
                {"from": "agent_bmi", "to": "render_bmi", "out": "", "in": ""},
            ],
        }

    def test_empty_out_is_data_edge_not_route(self):
        executor = OpalExecutor(self._frontend_two_input_graph())
        # 空 out 应归为数据边,不产生任何条件路由
        self.assertEqual(
            {k: v for k, v in executor.routes_map.items() if v}, {}
        )
        self.assertIn("in_cm", executor.parents_map["agent_bmi"])
        self.assertIn("in_kg", executor.parents_map["agent_bmi"])

    def test_both_inputs_prompted_in_sequence(self):
        executor = OpalExecutor(self._frontend_two_input_graph())

        state = executor.start(thread_id="fe-two-1")
        self.assertEqual(state["status"], "waiting_input")
        self.assertIn("in_cm", state.get("waiting_nodes", []))

        # 填完第一个 input 后应停在第二个 input,而不是直接跑完
        state = executor.resume({"in_cm": "175"}, thread_id="fe-two-1")
        self.assertEqual(state["status"], "waiting_input")
        self.assertIn("in_kg", state.get("waiting_nodes", []))
        self.assertEqual(state["completed_nodes"], ["in_cm"])


# ---------------------------------------------------------------------------
# Streaming Tests (SSE 事件流)
# ---------------------------------------------------------------------------


class _FakeMsg:
    def __init__(self, content):
        self.content = content


class _FakeLLM:
    """离线桩:agent/render 节点直接返回固定内容,不真正调用 LLM。"""

    def invoke(self, messages):
        return _FakeMsg("FAKE_OUTPUT")


class TestStreamExecution(unittest.TestCase):
    """验证 stream_start / stream_resume 逐节点产出事件,
    并在 input 节点处暂停、最终产出 completed。"""

    def _two_input_graph(self):
        return {
            "title": "BMI",
            "nodes": [
                {"id": "in_cm", "type": "user-inputs",
                 "metadata": {"title": "Height"},
                 "configuration": {"description": {"content": "cm?"}}},
                {"id": "in_kg", "type": "user-inputs",
                 "metadata": {"title": "Weight"},
                 "configuration": {"description": {"content": "kg?"}}},
                {"id": "agent_bmi", "type": "agent-generate",
                 "configuration": {"config$prompt": {"content": "compute"}}},
                {"id": "render_bmi", "type": "render-outputs",
                 "configuration": {"text": {"content": "show"}}},
            ],
            "edges": [
                {"from": "in_cm", "to": "agent_bmi", "out": "", "in": ""},
                {"from": "in_kg", "to": "agent_bmi", "out": "", "in": ""},
                {"from": "agent_bmi", "to": "render_bmi", "out": "", "in": ""},
            ],
        }

    def test_stream_pauses_and_completes(self):
        executor = OpalExecutor(self._two_input_graph(), llm=_FakeLLM())

        # start 应立即在第一个 input 处产出 waiting_input
        events = list(executor.stream_start(thread_id="stream-1"))
        self.assertTrue(events)
        self.assertEqual(events[-1]["event"], "waiting_input")
        self.assertIn("in_cm", events[-1]["waiting_nodes"])

        # 提交第一个输入 -> 停在第二个 input
        events = list(executor.stream_resume({"in_cm": "175"}, thread_id="stream-1"))
        self.assertEqual(events[-1]["event"], "waiting_input")
        self.assertIn("in_kg", events[-1]["waiting_nodes"])

        # 提交第二个输入 -> agent、render 逐节点产出,最后 completed
        events = list(executor.stream_resume({"in_kg": "70"}, thread_id="stream-1"))
        types = [e["event"] for e in events]
        self.assertIn("node_complete", types)
        self.assertEqual(events[-1]["event"], "completed")

        node_completes = [e["node_id"] for e in events if e["event"] == "node_complete"]
        self.assertIn("agent_bmi", node_completes)
        self.assertIn("render_bmi", node_completes)

        final = events[-1]
        self.assertIn("render_bmi", final["completed_nodes"])


# ---------------------------------------------------------------------------
# E2E Tests (requires LLM)
# ---------------------------------------------------------------------------


class TestExecutorE2E(unittest.TestCase):
    """端到端测试,需要有效的 LLM 配置。"""

    def setUp(self):
        if not os.environ.get("OPIE_LLM_API_KEY") or os.environ.get("OPIE_LLM_API_KEY") == "sk-test":
            self.skipTest("No valid LLM API key configured")

    def test_full_execution(self):
        """完整执行: start -> resume -> 全部完成。"""
        graph = _load_sample_graph()
        executor = OpalExecutor(graph)

        # Start
        state = executor.start(thread_id="e2e-full")
        self.assertEqual(state["status"], "waiting_input")

        # Resume — 依次提供所有 user-inputs 节点的值。
        state = executor.resume(
            user_inputs={
                "9de7f9a7-3c63-4979-9956-c0c7bf60dacb": "new client",
                "ask_user_client_name": "Acme Corp",
                "93719889-e5f0-4f0d-9976-fc2b6366b8ad": "no prior notes",
            },
            thread_id="e2e-full",
        )
        self.assertEqual(state["status"], "completed")

        outputs = state["node_outputs"]
        self.assertEqual(outputs["ask_user_client_name"], "Acme Corp")
        # 最终 render 节点应产出网页内容。
        self.assertTrue(len(outputs["node_step_meeting_brief"]) > 100)
        self.assertTrue(len(outputs["agent_blog_writer_23ca06a2"]) > 200)
        self.assertIn("<html", outputs["render_blog_post_display_da5a77f8"].lower())


# ---------------------------------------------------------------------------
# Route Tests (with a mock routing graph)
# ---------------------------------------------------------------------------


class TestRouteExecution(unittest.TestCase):
    """测试条件路由执行。"""

    def _make_route_graph(self):
        """构建一个带路由的测试图:
        input -> classifier --(route)--> positive_handler
                            --(route)--> negative_handler
        """
        return {
            "metadata": {"intent": "test"},
            "assets": {},
            "title": "Route Test",
            "description": "",
            "version": "0.0.1",
            "nodes": [
                {
                    "id": "input_feedback",
                    "metadata": {"title": "Feedback"},
                    "type": "user-inputs",
                    "configuration": {
                        "description": {"content": "Enter feedback", "role": "user"},
                        "p-modality": "Text",
                        "p-required": True,
                    },
                },
                {
                    "id": "agent_classifier",
                    "metadata": {"title": "Classifier"},
                    "type": "agent-generate",
                    "configuration": {
                        "config$prompt": {
                            "content": '1. Classify the feedback as positive or negative.\n\n3. User Input:\n{{"type":"in","path":"input_feedback","title":"Feedback"}}',
                            "role": "user",
                        },
                        "generation-mode": "agent",
                    },
                },
                {
                    "id": "render_positive",
                    "metadata": {"title": "Positive Response"},
                    "type": "render-outputs",
                    "configuration": {
                        "text": {
                            "content": 'Show thank you message for: {{"type":"in","path":"input_feedback","title":"Feedback"}}',
                            "role": "user",
                        },
                        "p-render-mode": "Auto",
                    },
                },
                {
                    "id": "render_negative",
                    "metadata": {"title": "Negative Response"},
                    "type": "render-outputs",
                    "configuration": {
                        "text": {
                            "content": 'Show apology for: {{"type":"in","path":"input_feedback","title":"Feedback"}}',
                            "role": "user",
                        },
                        "p-render-mode": "Auto",
                    },
                },
            ],
            "edges": [
                {"from": "input_feedback", "to": "agent_classifier", "out": "context", "in": "p-z-input_feedback"},
                {"from": "agent_classifier", "to": "render_positive", "out": "render_positive", "in": "p-z-agent_classifier"},
                {"from": "agent_classifier", "to": "render_negative", "out": "render_negative", "in": "p-z-agent_classifier"},
            ],
        }

    def test_route_graph_builds(self):
        os.environ.setdefault("OPIE_LLM_BASE_URL", "https://api.deepseek.com")
        os.environ.setdefault("OPIE_LLM_API_KEY", "sk-test")
        os.environ.setdefault("OPIE_LLM_MODEL", "deepseek-v4-flash")

        graph = self._make_route_graph()
        executor = OpalExecutor(graph)
        self.assertIn("agent_classifier", executor.routes_map)
        self.assertEqual(len(executor.routes_map["agent_classifier"]), 2)

    def _make_fake_llm(self, route_choice: str):
        """构造一个假 LLM:路由节点通过 select_route 工具选择 route_choice,
        其余节点直接产出占位文本。用于在不调用真实 LLM 的情况下验证路由/跳过。"""
        from langchain_core.messages import AIMessage

        class FakeLLM:
            def __init__(self):
                self._tools = []

            def bind_tools(self, tools):
                self._tools = tools
                return self

            def invoke(self, _messages):
                if any(getattr(t, "name", "") == "select_route" for t in self._tools):
                    return AIMessage(
                        content="",
                        tool_calls=[{
                            "name": "select_route",
                            "args": {"target": route_choice},
                            "id": "call_route",
                        }],
                    )
                return AIMessage(content="[stub output]")

        return FakeLLM()

    def test_routing_executes_only_chosen_branch(self):
        """回归:agent 选中某分支后,未选中的分支必须被跳过(不执行)。"""
        graph = self._make_route_graph()

        for chosen, other in (
            ("render_positive", "render_negative"),
            ("render_negative", "render_positive"),
        ):
            executor = OpalExecutor(graph, llm=self._make_fake_llm(chosen))
            tid = f"route-{chosen}"
            executor.start(thread_id=tid)
            state = executor.resume(
                user_inputs={"input_feedback": "great product"}, thread_id=tid
            )

            self.assertEqual(state["status"], "completed")
            self.assertEqual(
                state["route_decisions"]["agent_classifier"], chosen
            )
            outputs = state["node_outputs"]
            # 选中分支执行、产出;未选中分支被跳过、无产出。
            self.assertIn(chosen, outputs)
            self.assertNotIn(other, outputs)
            self.assertIn(other, state.get("skipped_nodes", []))

    def test_invalid_route_choice_falls_back(self):
        """agent 未做出有效选择时,回退到第一个路由目标以保证图能推进。"""
        graph = self._make_route_graph()
        executor = OpalExecutor(graph, llm=self._make_fake_llm("no_such_node"))
        tid = "route-fallback"
        executor.start(thread_id=tid)
        state = executor.resume(
            user_inputs={"input_feedback": "meh"}, thread_id=tid
        )
        self.assertEqual(state["status"], "completed")
        # 第一个路由目标(render_positive)应被选中执行。
        self.assertEqual(
            state["route_decisions"]["agent_classifier"], "render_positive"
        )
        self.assertIn("render_positive", state["node_outputs"])
        self.assertNotIn("render_negative", state["node_outputs"])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--unit", action="store_true", help="Only run unit tests")
    parser.add_argument("--e2e", action="store_true", help="Only run E2E tests")
    args = parser.parse_args()

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    if args.unit:
        suite.addTests(loader.loadTestsFromTestCase(TestTopologicalSort))
        suite.addTests(loader.loadTestsFromTestCase(TestResolvePlaceholders))
        suite.addTests(loader.loadTestsFromTestCase(TestExecutorBuild))
        suite.addTests(loader.loadTestsFromTestCase(TestFrontendEdgeClassification))
        suite.addTests(loader.loadTestsFromTestCase(TestStreamExecution))
    elif args.e2e:
        suite.addTests(loader.loadTestsFromTestCase(TestExecutorE2E))
    else:
        suite.addTests(loader.loadTestsFromTestCase(TestTopologicalSort))
        suite.addTests(loader.loadTestsFromTestCase(TestResolvePlaceholders))
        suite.addTests(loader.loadTestsFromTestCase(TestExecutorBuild))
        suite.addTests(loader.loadTestsFromTestCase(TestFrontendEdgeClassification))
        suite.addTests(loader.loadTestsFromTestCase(TestStreamExecution))
        suite.addTests(loader.loadTestsFromTestCase(TestRouteExecution))
        suite.addTests(loader.loadTestsFromTestCase(TestExecutorE2E))

    runner = unittest.TextTestRunner(verbosity=2)
    runner.run(suite)
