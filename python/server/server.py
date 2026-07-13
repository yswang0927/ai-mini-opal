# -*- coding: utf-8 -*-
"""
server.py
=========
FastAPI HTTP 服务,封装 Opie Agent 的多轮对话能力。
由 Electron 主进程启动,为前端 React 页面提供 HTTP API。

启动方式:
    python server.py                              # 默认 0.0.0.0:8765
    python server.py --port 9000                  # 自定义端口
    uvicorn server:app --host 0.0.0.0 --port 8765 --reload  # 开发热重载

接口:
    POST /chat          多轮对话(自动管理 session）
    GET  /graph/{sid}   获取当前 session 编译出的 Opal JSON
    DELETE /session/{sid} 销毁指定 session
    GET  /sessions      列出所有活跃 session
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

from opal_graph import OpalGraphState
from opie_tools import build_opie_tools

# -----------------------------
# LLM 配置
# -----------------------------

load_dotenv(Path(__file__).parent / ".env")

LLM_BASE_URL = os.environ.get("OPIE_LLM_BASE_URL", "")
LLM_API_KEY = os.environ.get("OPIE_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("OPIE_LLM_MODEL", "")

PROMPT_PATH = Path(__file__).parent / "mini_opal_prompt_v2.md"


def _load_system_prompt() -> str:
    if not PROMPT_PATH.exists():
        raise FileNotFoundError(
            f"未找到系统提示词文件 {PROMPT_PATH}。请确认 mini_opal_prompt_v2.md "
            f"与本脚本放在同一目录下。"
        )
    return PROMPT_PATH.read_text(encoding="utf-8")


def _build_llm() -> ChatOpenAI:
    if not (LLM_BASE_URL and LLM_API_KEY and LLM_MODEL):
        print(
            "⚠️  尚未配置 LLM 连接参数。请设置环境变量 "
            "OPIE_LLM_BASE_URL / OPIE_LLM_API_KEY / OPIE_LLM_MODEL,"
            "或在 .env 文件中配置。",
            file=sys.stderr,
        )
        sys.exit(1)

    return ChatOpenAI(
        base_url=LLM_BASE_URL,
        api_key=LLM_API_KEY,
        model=LLM_MODEL,
        temperature=0.7,
    )


_llm_instance: ChatOpenAI | None = None


def _get_llm() -> ChatOpenAI:
    global _llm_instance
    if _llm_instance is None:
        _llm_instance = _build_llm()
    return _llm_instance


def _build_agent_and_state():
    """创建一个新的 (agent, graph_state) 对,每个 session 独立持有一份。"""
    graph_state = OpalGraphState()
    tools = build_opie_tools(graph_state)
    system_prompt = _load_system_prompt()

    agent = create_agent(
        model=_get_llm(),
        tools=tools,
        system_prompt=system_prompt,
    )
    return agent, graph_state


def _rebuild_agent_with_state(graph_state: OpalGraphState):
    """基于已有的 graph_state 重建 agent（用于从 graph_raw 恢复场景）。"""
    tools = build_opie_tools(graph_state)
    system_prompt = _load_system_prompt()

    return create_agent(
        model=_get_llm(),
        tools=tools,
        system_prompt=system_prompt,
    )

# ------------------------------
# Session 管理
# ------------------------------

SESSION_TTL_SECONDS = 60 * 30  # 30 分钟无活动自动过期
SESSION_STORE_DIR = Path(__file__).parent / "session_store"
SESSION_STORE_DIR.mkdir(exist_ok=True)


def _session_file(session_id: str) -> Path:
    return SESSION_STORE_DIR / f"{session_id}.json"


def _save_session_to_disk(session_id: str, session: "Session") -> None:
    data = {
        "graph_raw": session.graph_state.to_raw(),
        "created_at": session.created_at,
        "last_active": session.last_active,
    }
    _session_file(session_id).write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8"
    )


def _load_session_from_disk(session_id: str) -> "Session | None":
    path = _session_file(session_id)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    graph_state = OpalGraphState.from_raw(data["graph_raw"])
    session = Session.__new__(Session)
    session.graph_state = graph_state
    session.agent = _rebuild_agent_with_state(graph_state)
    session.history = []
    session.created_at = data.get("created_at", time.time())
    session.last_active = time.time()
    session.lock = asyncio.Lock()
    return session


class Session:
    def __init__(self):
        self.agent, self.graph_state = _build_agent_and_state()
        self.history: list = []
        self.created_at: float = time.time()
        self.last_active: float = time.time()
        self.lock = asyncio.Lock()

    def is_expired(self) -> bool:
        return (time.time() - self.last_active) > SESSION_TTL_SECONDS

    def touch(self):
        self.last_active = time.time()


sessions: Dict[str, Session] = {}


async def cleanup_expired_sessions():
    while True:
        await asyncio.sleep(60)
        expired = [sid for sid, s in sessions.items() if s.is_expired()]
        for sid in expired:
            del sessions[sid]


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(cleanup_expired_sessions())
    yield
    task.cancel()


# --------------------------------
# FastAPI App
# --------------------------------

app = FastAPI(title="Opie Agent Server", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------
# Request / Response Models
# --------------------------------


class ChatRequest(BaseModel):
    session_id: str
    message: str


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    tool_calls: list[Dict[str, Any]] = []
    graph: Dict[str, Any] = {}


class GraphResponse(BaseModel):
    session_id: str
    graph: Dict[str, Any]


# ----------------------
# Endpoints
# ----------------------

@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """多轮对话接口。session_id 由前端传入,首次使用时自动创建会话。"""
    session_id = req.session_id

    if session_id in sessions:
        session = sessions[session_id]
    else:
        session = _load_session_from_disk(session_id)
        if session is None:
            session = Session()
        sessions[session_id] = session

    async with session.lock:
        session.touch()
        session.history.append({"role": "user", "content": req.message})

        result = await asyncio.to_thread(
            session.agent.invoke, {"messages": session.history}
        )
        session.history = result["messages"]

    tool_calls_log = []
    for msg in result["messages"]:
        role = getattr(msg, "type", getattr(msg, "role", "unknown"))
        if role == "ai" and getattr(msg, "tool_calls", None):
            for tc in msg.tool_calls:
                tool_calls_log.append({"name": tc["name"], "args": tc["args"]})

    last_ai = next(
        (m for m in reversed(result["messages"])
         if getattr(m, "type", "") == "ai" and m.content),
        None,
    )
    reply = last_ai.content if last_ai else ""

    _save_session_to_disk(session_id, session)

    return ChatResponse(
        session_id=session_id,
        reply=reply,
        tool_calls=tool_calls_log,
        graph=session.graph_state.compile_to_opal_json(),
    )


@app.get("/graph/{session_id}", response_model=GraphResponse)
async def get_graph(session_id: str):
    """获取指定 session 当前编译出的 Opal Graph JSON。"""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    graph = session.graph_state.compile_to_opal_json()
    return GraphResponse(session_id=session_id, graph=graph)


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """销毁指定 session，释放内存。"""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del sessions[session_id]
    return {"ok": True}


@app.get("/sessions")
async def list_sessions():
    """列出所有活跃 session（调试用）。"""
    return [
        {
            "session_id": sid,
            "created_at": s.created_at,
            "last_active": s.last_active,
            "node_count": len(s.graph_state.steps),
        }
        for sid, s in sessions.items()
        if not s.is_expired()
    ]


# ---------------------
# 直接运行入口
# ---------------------

if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Opie Agent HTTP Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    cli_args = parser.parse_args()

    uvicorn.run(app, host=cli_args.host, port=cli_args.port)
