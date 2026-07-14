import type { OpalJson } from "@/types";

// Python 执行器服务基地址(与 ChatGraph.tsx 中的 /chat 接口保持一致)
export const EXECUTOR_BASE_URL = "http://127.0.0.1:18765";

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

/** 销毁服务端 executor 实例,释放资源。 */
export async function deleteExecutor(threadId: string): Promise<void> {
  try {
    await fetch(`${EXECUTOR_BASE_URL}/execute/${threadId}`, { method: "DELETE" });
  } catch {
    // 清理失败不阻塞前端流程
  }
}
