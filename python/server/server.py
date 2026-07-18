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
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

from opal_graph import OpalGraphState
from opie_tools import build_opie_tools
from opal_executor import OpalExecutor

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
        use_responses_api=False
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
# 统一响应
# --------------------------------

class ApiResponse(BaseModel):
    """统一响应结果"""

    code: int
    message: str
    data: Any = None

    @classmethod
    def success(cls, data: Any = None, message: str = "操作成功"):
        """
        成功返回
        """
        return cls(
            code=0,
            message=message,
            data=data
        )

    @classmethod
    def error(cls, message: str = "操作失败", code: int = 500):
        """
        失败返回
        """
        return cls(
            code=code,
            message=message,
            data=None
        )

#
# 所有接口的错误都归一为以下 JSON 结构,前端可据 code/message 统一处理:
#   {"code": error_code, "error": {"message": <描述>, "type": <异常类别>}}

def _error_response(status_code: int, message: str, err_type: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=ApiResponse.error(message=f"{message}({err_type})", code=status_code).model_dump()
    )


@app.exception_handler(HTTPException)
async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return _error_response(exc.status_code, str(exc.detail), "http_error")


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return _error_response(422, "请求参数校验失败", "validation_error")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # 兜底:未预期的服务端异常统一返回 500,避免泄漏堆栈到前端
    return _error_response(500, f"服务器内部错误: {str(exc)}", "internal_error")


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


# --- Executor Request/Response Models ---

class ExecuteStartRequest(BaseModel):
    graph_json: Dict[str, Any]
    thread_id: Optional[str] = None
    # 「运行到此节点」:仅执行该节点及其全部祖先,其余节点跳过。为空则整图执行。
    target_node: Optional[str] = None


class ExecuteResumeRequest(BaseModel):
    thread_id: str
    user_inputs: Dict[str, str]


class ExecuteResponse(BaseModel):
    thread_id: str
    status: str
    current_node: str = ""
    node_outputs: Dict[str, str] = {}
    completed_nodes: List[str] = []
    pending_nodes: List[str] = []
    waiting_nodes: List[str] = []
    interrupts: List[Dict[str, Any]] = []


# ----------------------
# Endpoints
# ----------------------

@app.post("/chat")
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
        # 记录追加前的历史长度,便于异常时回滚,避免本轮用户消息污染会话
        history_len_before = len(session.history)
        session.history.append({"role": "user", "content": req.message})

        try:
            result = await asyncio.to_thread(
                session.agent.invoke,
                {"messages": session.history}
            )
        except Exception as e:
            # LLM 服务不可用、超时、鉴权失败等:回滚本轮追加的用户消息,统一返回 502
            session.history = session.history[:history_len_before]
            raise HTTPException(
                status_code=502,
                detail=f"LLM 服务调用失败: {str(e)}",
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

    return ApiResponse.success(data=ChatResponse(
        session_id=session_id,
        reply=reply,
        tool_calls=tool_calls_log,
        graph=session.graph_state.compile_to_opal_json(),
    ))


@app.get("/graph/{session_id}")
async def get_graph(session_id: str):
    """获取指定 session 当前编译出的 Opal Graph JSON。"""
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    graph = session.graph_state.compile_to_opal_json()
    return ApiResponse.success(data=GraphResponse(session_id=session_id, graph=graph))


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """销毁指定 session，释放内存。"""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del sessions[session_id]
    return ApiResponse.success(data={"session_id": session_id})


@app.get("/sessions")
async def list_sessions():
    """列出所有活跃 session（调试用）。"""
    return ApiResponse.success(data=[
        {
            "session_id": sid,
            "created_at": s.created_at,
            "last_active": s.last_active,
            "node_count": len(s.graph_state.steps),
        }
        for sid, s in sessions.items()
        if not s.is_expired()
    ])


# ----------------------
# Executor Endpoints
# ----------------------

# 存储活跃的 executor 实例, key = thread_id
executors: Dict[str, OpalExecutor] = {}


@app.post("/execute/start", response_model=ExecuteResponse)
async def execute_start(req: ExecuteStartRequest):
    """
    启动图执行。传入编译后的 graph_json, 返回执行状态。
    遇到 input 节点会暂停(status=waiting_input),前端需要收集用户输入后调用 /execute/resume。
    """
    import uuid

    thread_id = req.thread_id or str(uuid.uuid4())

    try:
        executor = OpalExecutor(graph_json=req.graph_json, llm=_get_llm())
        executors[thread_id] = executor

        state = await asyncio.to_thread(executor.start, thread_id)
        return ApiResponse.success(data=ExecuteResponse(thread_id=thread_id, **_sanitize_state(state)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start execution: {str(e)}")


@app.post("/execute/resume", response_model=ExecuteResponse)
async def execute_resume(req: ExecuteResumeRequest):
    """
    提供用户输入后继续执行。
    每次可提供一个或多个 input 节点的值。执行会继续直到下一个 input 节点或全部完成。
    """
    executor = executors.get(req.thread_id)
    if not executor:
        raise HTTPException(status_code=404, detail=f"Executor not found for thread_id={req.thread_id}")

    try:
        state = await asyncio.to_thread(executor.resume, req.user_inputs, req.thread_id)
        return ApiResponse.success(data=ExecuteResponse(thread_id=req.thread_id, **_sanitize_state(state)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Execution error: {str(e)}")


def _sse_frame(payload: Dict[str, Any]) -> str:
    """把一个事件 dict 编码为一帧 SSE 数据。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _drain_stream(gen):
    """
    在线程中逐个取出同步生成器的事件并编码为 SSE 帧。

    OpalExecutor 的 stream_* 是同步生成器(内部会阻塞在 LLM 调用上),
    这里用 asyncio.to_thread 逐个 next() 取值,避免阻塞事件循环。
    """
    sentinel = object()

    def _next():
        try:
            return next(gen)
        except StopIteration:
            return sentinel

    while True:
        event = await asyncio.to_thread(_next)
        if event is sentinel:
            break
        yield _sse_frame(event)


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",  # 关闭 nginx 等中间层缓冲,保证逐帧下发
}


@app.post("/execute/start_stream")
async def execute_start_stream(req: ExecuteStartRequest):
    """
    流式启动图执行(SSE)。逐节点推送执行进度事件,遇到 input 节点推送 waiting_input。
    事件类型: node_complete | waiting_input | completed | error。
    """
    import uuid

    thread_id = req.thread_id or str(uuid.uuid4())
    try:
        executor = OpalExecutor(graph_json=req.graph_json, llm=_get_llm())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start execution: {str(e)}")
    executors[thread_id] = executor

    async def event_source():
        # 首帧下发 thread_id,前端 resume 时需要
        yield _sse_frame({"event": "started", "thread_id": thread_id})
        async for frame in _drain_stream(executor.stream_start(thread_id, req.target_node)):
            yield frame

    return StreamingResponse(
        event_source(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@app.post("/execute/resume_stream")
async def execute_resume_stream(req: ExecuteResumeRequest):
    """
    流式恢复执行(SSE)。提交用户输入后逐节点推送进度,直到下一个 input 或全部完成。
    """
    executor = executors.get(req.thread_id)
    if not executor:
        raise HTTPException(status_code=404, detail=f"Executor not found for thread_id={req.thread_id}")

    async def event_source():
        async for frame in _drain_stream(executor.stream_resume(req.user_inputs, req.thread_id)):
            yield frame

    return StreamingResponse(
        event_source(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@app.get("/execute/status/{thread_id}", response_model=ExecuteResponse)
async def execute_status(thread_id: str):
    """查询指定 thread 的执行状态。"""
    executor = executors.get(thread_id)
    if not executor:
        raise HTTPException(status_code=404, detail=f"Executor not found for thread_id={thread_id}")

    state = executor.get_status(thread_id)
    return ExecuteResponse(thread_id=thread_id, **_sanitize_state(state))


@app.get("/execute/outputs/{thread_id}")
async def execute_outputs(thread_id: str):
    """获取指定 thread 所有节点的输出内容。"""
    executor = executors.get(thread_id)
    if not executor:
        raise HTTPException(status_code=404, detail=f"Executor not found for thread_id={thread_id}")

    outputs = executor.get_outputs(thread_id)
    return {"thread_id": thread_id, "outputs": outputs}


@app.delete("/execute/{thread_id}")
async def execute_delete(thread_id: str):
    """销毁指定 thread 的执行器,释放资源。"""
    if thread_id not in executors:
        raise HTTPException(status_code=404, detail=f"Executor not found for thread_id={thread_id}")
    del executors[thread_id]
    return {"ok": True, "thread_id": thread_id}


def _sanitize_state(state: Dict[str, Any]) -> Dict[str, Any]:
    """确保 state 中所有字段符合 ExecuteResponse schema。"""
    return {
        "status": state.get("status", "pending"),
        "current_node": state.get("current_node", ""),
        "node_outputs": state.get("node_outputs", {}),
        "completed_nodes": state.get("completed_nodes", []),
        "pending_nodes": state.get("pending_nodes", []),
        "waiting_nodes": state.get("waiting_nodes", []),
        "interrupts": state.get("interrupts", []),
    }


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
