import type { OpalJson } from "@/types";
import { SERVER_BASE_URL } from "@/utils/Api";

// Python 执行器服务基地址(与 ChatGraph.tsx 中的 /chat 接口保持一致)
export const EXECUTOR_BASE_URL = SERVER_BASE_URL;

/** 单个 input 节点的 interrupt 载荷,对应服务端 _make_input_handler 的 interrupt(...) */
export interface ServerInterrupt {
  node_id: string;
  title: string;
  question: string;
  modality: string;
  required: boolean;
}

/** /execute/start 与 /execute/resume 的统一响应结构 */
export interface ServerExecuteResponse {
  thread_id: string;
  status: string; // pending | waiting_input | running | completed | error
  current_node: string;
  node_outputs: Record<string, string>;
  completed_nodes: string[];
  pending_nodes: string[];
  waiting_nodes: string[];
  interrupts: ServerInterrupt[];
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${EXECUTOR_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    throw new Error(`${path} 请求失败 (${resp.status}): ${detail}`);
  }
  return resp.json() as Promise<T>;
}

/** 启动图执行,遇到 input 节点会返回 status=waiting_input。 */
export async function startExecution(
  graphJson: OpalJson,
  threadId?: string
): Promise<ServerExecuteResponse> {
  return postJson<ServerExecuteResponse>("/execute/start", {
    graph_json: graphJson,
    thread_id: threadId,
  });
}

/** 提交用户输入并继续执行,直到下一个 input 节点或全部完成。 */
export async function resumeExecution(
  threadId: string,
  userInputs: Record<string, string>
): Promise<ServerExecuteResponse> {
  return postJson<ServerExecuteResponse>("/execute/resume", {
    thread_id: threadId,
    user_inputs: userInputs,
  });
}

// ---------------------------------------------------------------------------
// SSE 流式执行
// ---------------------------------------------------------------------------

/** 服务端 SSE 推送的执行进度事件。 */
export interface ServerStreamEvent {
  event: 'started' | 'node_complete' | 'node_skipped' | 'waiting_input' | 'completed' | 'error';
  thread_id?: string;
  node_id?: string;
  node_type?: string;
  output?: string;
  interrupts?: ServerInterrupt[];
  waiting_nodes?: string[];
  completed_nodes?: string[];
  // 因路由未命中而被跳过的节点 id 列表(node_skipped / completed 事件携带)
  skipped_nodes?: string[];
  current_node?: string;
  node_outputs?: Record<string, string>;
  error?: string;
}

/**
 * 消费一个 POST + SSE 的响应流,逐事件回调。
 * EventSource 只支持 GET,而我们需要 POST graph_json,故手动用 fetch + ReadableStream 解析 SSE 分帧。
 */
async function consumeSse(
  path: string,
  body: unknown,
  onEvent: (evt: ServerStreamEvent) => void
): Promise<void> {
  const resp = await fetch(`${EXECUTOR_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => resp.statusText);
    throw new Error(`${path} 请求失败 (${resp.status}): ${detail}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flushFrame = (frame: string) => {
    // SSE 帧可能含多行,取所有 data: 行拼接
    const dataLines = frame
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim());
    if (dataLines.length === 0) return;
    const jsonStr = dataLines.join('\n');
    try {
      onEvent(JSON.parse(jsonStr) as ServerStreamEvent);
    } catch {
      // 忽略无法解析的帧(心跳/注释等)
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧以空行(\n\n)分隔
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      flushFrame(frame);
    }
  }
  // 处理末尾残帧
  if (buffer.trim()) flushFrame(buffer);
}

/**
 * 流式启动图执行,逐节点回调进度事件。
 * targetNode 非空时为「运行到此节点」:仅执行该节点及其祖先,其余节点跳过。
 */
export async function startExecutionStream(
  graphJson: OpalJson,
  onEvent: (evt: ServerStreamEvent) => void,
  threadId?: string,
  targetNode?: string
): Promise<void> {
  return consumeSse(
    '/execute/start_stream',
    { graph_json: graphJson, thread_id: threadId, target_node: targetNode },
    onEvent
  );
}

/** 流式提交用户输入并继续执行,逐节点回调进度事件。 */
export async function resumeExecutionStream(
  threadId: string,
  userInputs: Record<string, string>,
  onEvent: (evt: ServerStreamEvent) => void
): Promise<void> {
  return consumeSse('/execute/resume_stream', { thread_id: threadId, user_inputs: userInputs }, onEvent);
}

/** 销毁服务端 executor 实例,释放资源。 */
export async function deleteExecutor(threadId: string): Promise<void> {
  try {
    await fetch(`${EXECUTOR_BASE_URL}/execute/${threadId}`, { method: "DELETE" });
  } catch {
    // 清理失败不阻塞前端流程
  }
}
