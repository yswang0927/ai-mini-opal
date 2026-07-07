# -*- coding: utf-8 -*-
"""
test_langchain_agent.py
========================
用 LangChain 把 Opie 系统提示词 + 8个工具接到一个真实 LLM 上做端到端测试。

使用方式:
    1. 把下面 "LLM 连接配置" 三个变量改成你自己的 base_url / api_key / model。
       (只要是兼容 OpenAI /v1/chat/completions 协议、支持 tool calling 的
       任意服务都可以 —— 比如你自建的网关、Azure OpenAI 兼容层等。)
    2. python3 test_langchain_agent.py            # 跑预置的单轮建图测试
    3. python3 test_langchain_agent.py --repl      # 进入交互式多轮对话模式

依赖:
    pip install langchain langchain-core langchain-openai pydantic --break-system-packages
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

from opal_graph import OpalGraphState
from opie_tools import build_opie_tools


# ===========================================================================
# LLM 连接配置 —— 在这里填写你自己的参数
# ===========================================================================

LLM_BASE_URL = os.environ.get("OPIE_LLM_BASE_URL", "https://api.deepseek.com")   # 例如: "https://api.your-gateway.com/v1"
LLM_API_KEY = os.environ.get("OPIE_LLM_API_KEY", "sk-2962d4c8755844e59524dc61ff8e8d26")     # 例如: "sk-xxxxxxxx"
LLM_MODEL = os.environ.get("OPIE_LLM_MODEL", "deepseek-v4-flash")         # 例如: "gpt-4o" / "qwen-max" / 自建模型名

# 也支持直接改这三行代替环境变量:
# LLM_BASE_URL = "https://api.your-gateway.com/v1"
# LLM_API_KEY = "sk-xxxxxxxx"
# LLM_MODEL = "gpt-4o"


PROMPT_PATH = Path(__file__).parent / "mini_opal_prompt_v2.md"


def load_system_prompt() -> str:
    if not PROMPT_PATH.exists():
        raise FileNotFoundError(
            f"未找到系统提示词文件 {PROMPT_PATH}。请确认 mini_opal_prompt_v2.md "
            f"与本脚本放在同一目录下。"
        )
    return PROMPT_PATH.read_text(encoding="utf-8")


def build_llm() -> ChatOpenAI:
    if not (LLM_BASE_URL and LLM_API_KEY and LLM_MODEL):
        print(
            "⚠️  尚未配置 LLM 连接参数。请设置环境变量 "
            "OPIE_LLM_BASE_URL / OPIE_LLM_API_KEY / OPIE_LLM_MODEL,"
            "或直接修改本文件顶部的三个变量后重新运行。",
            file=sys.stderr,
        )
        sys.exit(1)

    return ChatOpenAI(
        base_url=LLM_BASE_URL,
        api_key=LLM_API_KEY,
        model=LLM_MODEL,
        temperature=0.3,
    )


def build_agent_and_state():
    """返回 (agent, graph_state)。graph_state 是本次会话的图状态,
    测试结束后可以调用 graph_state.compile_to_opal_json() 拿到最终 JSON。"""
    graph_state = OpalGraphState()
    tools = build_opie_tools(graph_state)
    llm = build_llm()
    system_prompt = load_system_prompt()

    agent = create_agent(
        model=llm,
        tools=tools,
        system_prompt=system_prompt,
    )
    return agent, graph_state


def run_single_turn_demo() -> None:
    """预置的单轮测试:复现 BMI 计算器场景,验证工具调用链路是否走通。"""
    agent, graph_state = build_agent_and_state()

    user_message = "我要一个计算身高体重的BMI计算器"
    #user_message = "An app that takes a user-provided topic as input, conducts in-depth research on that topic, and then generates a snappy and compelling blog post about it."
    user_message = "帮我做一个客户投诉与建议分类处理工具。首先让用户输入他们的反馈内容。然后用大模型分析这段内容的意图：如果是严重投诉，就走到‘紧急处理’步骤，生成一封道歉信并给出退款方案；如果是普通产品建议，就走到‘需求池’步骤，自动将其整理成表格格式；最后不论哪种情况，都把结果展示在漂亮的 Dashboard 网页上。"
    print(f"\n>>> 用户: {user_message}\n")

    result = agent.invoke({"messages": [{"role": "user", "content": user_message}]})

    # create_agent 返回的 state 里 messages 是完整的消息序列(含中间的工具调用/结果)
    for msg in result["messages"]:
        role = getattr(msg, "type", getattr(msg, "role", "unknown"))
        if role == "ai" and getattr(msg, "tool_calls", None):
            for tc in msg.tool_calls:
                print(f"[工具调用] {tc['name']}({json.dumps(tc['args'], ensure_ascii=False)})")
        elif role == "tool":
            print(f"[工具结果] {msg.content}")
        elif role == "ai":
            print(f"\n<<< Opie: {msg.content}\n")

    print("=" * 60)
    print("最终编译出的 Opal JSON:")
    compiled = graph_state.compile_to_opal_json()
    print(json.dumps(compiled, indent=2, ensure_ascii=False))

    out_path = Path(__file__).parent / "generated_graph.json"
    out_path.write_text(json.dumps(compiled, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n已保存到 {out_path}")


def run_repl() -> None:
    """交互式多轮对话模式,方便手动测试编辑类指令(改prompt、加路由、删节点等)。"""
    agent, graph_state = build_agent_and_state()
    history: list = []  # 直接存放LangChain消息对象,不要压扁成dict

    print("进入交互模式,输入 'quit' 退出,输入 'json' 查看当前编译结果。\n")
    while True:
        try:
            user_input = input(">>> 你: ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if user_input.lower() in {"quit", "exit"}:
            break
        if user_input.lower() == "json":
            print(json.dumps(graph_state.compile_to_opal_json(), indent=2, ensure_ascii=False))
            continue
        if not user_input:
            continue

        history.append({"role": "user", "content": user_input})
        result = agent.invoke({"messages": history})

        # 修复(采纳代码审查意见):此前这里把消息压扁成 {"role","content"}
        # 字典,丢失了 tool_calls / tool_call_id 等结构化信息,而且过滤条件
        # `if content` 会直接丢弃"纯工具调用、content为空"的AI消息——
        # 一旦某轮触发了工具调用,下一轮历史里就会漏掉这条消息,模型看不到
        # 自己刚才做过什么。直接保留完整的消息对象列表,原样传给下一次 invoke。
        history = result["messages"]

        last_ai = next(
            (m for m in reversed(result["messages"]) if getattr(m, "type", "") == "ai" and m.content),
            None,
        )
        if last_ai:
            print(f"<<< Opie: {last_ai.content}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repl", action="store_true", help="进入交互式多轮对话模式")
    args = parser.parse_args()

    if args.repl:
        run_repl()
    else:
        run_single_turn_demo()