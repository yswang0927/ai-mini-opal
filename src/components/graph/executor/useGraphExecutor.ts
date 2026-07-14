import { useState, useCallback, useRef } from "react";
import type { OpalJson, OpalNode } from "@/types";
import { OpalNodeType } from "@/types";
import type { ExecutionState, InputRequest, NodeExecStatus } from "./types";
import {
  startExecution,
  resumeExecution,
  deleteExecutor,
  type ServerExecuteResponse,
} from "./serverApi";

const initialState: ExecutionState = {
  status: 'idle',
  pendingInputs: [],
  nodeOutputs: {},
  renderedHtml: null,
  error: null,
  currentNodeId: null,
  currentNodeTitle: null,
  graphTitle: null,
  graphDescription: null,
  nodeStatuses: {},
  nodeExecLog: [],
};

function isRenderNode(node: OpalNode): boolean {
  return node.type === OpalNodeType.RenderOutputs;
}

/** 去除 LLM 输出可能包裹的 ```html ... ``` 代码围栏。 */
function stripHtmlFence(html: string): string {
  return html
    .replace(/^\s*```html\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** 从服务端 node_outputs 中提取第一个 render 节点产出的 HTML。 */
function extractRenderedHtml(graphJson: OpalJson | null, outputs: Record<string, string>): string | null {
  if (!graphJson?.nodes) return null;
  for (const node of graphJson.nodes) {
    if (isRenderNode(node) && outputs[node.id]) {
      return stripHtmlFence(outputs[node.id]);
    }
  }
  return null;
}

/** 将服务端各节点状态列表整合为 nodeId -> NodeExecStatus 映射。 */
function buildNodeStatuses(resp: ServerExecuteResponse): Record<string, NodeExecStatus> {
  const statuses: Record<string, NodeExecStatus> = {};
  for (const id of resp.pending_nodes) statuses[id] = 'pending';
  for (const id of resp.waiting_nodes) statuses[id] = 'running';
  for (const id of resp.completed_nodes) statuses[id] = 'completed';
  if (resp.status === 'running' && resp.current_node) {
    statuses[resp.current_node] = 'running';
  }
  return statuses;
}

/** 将服务端响应映射为前端 ExecutionState。 */
function mapResponseToState(
  resp: ServerExecuteResponse,
  graphJson: OpalJson | null,
  prev: ExecutionState,
): ExecutionState {
  const nodeMap = new Map((graphJson?.nodes || []).map(n => [n.id, n]));

  const pendingInputs: InputRequest[] = (resp.interrupts || []).map(intr => ({
    nodeId: intr.node_id,
    title: intr.title,
    description: intr.question,
    modality: intr.modality || 'Text',
    required: intr.required !== false,
  }));

  // 归一化状态: 服务端 pending 视为 running(尚未产出任何输出的中间态)
  let status = resp.status as ExecutionState['status'];
  if (status === ('pending' as any)) status = 'running';

  const currentNodeId = resp.current_node || null;
  const currentNodeTitle = currentNodeId
    ? (nodeMap.get(currentNodeId)?.metadata?.title || currentNodeId)
    : null;

  return {
    ...prev,
    status,
    pendingInputs,
    nodeOutputs: resp.node_outputs || {},
    renderedHtml: extractRenderedHtml(graphJson, resp.node_outputs || {}),
    error: status === 'error' ? (resp.current_node || '执行出错') : null,
    currentNodeId,
    currentNodeTitle,
    nodeStatuses: buildNodeStatuses(resp),
  };
}

export function useGraphExecutor() {
  const [execState, setExecState] = useState<ExecutionState>(initialState);
  const graphRef = useRef<OpalJson | null>(null);
  const threadIdRef = useRef<string | null>(null);

  const loadGraph = useCallback((graphJson: OpalJson | null) => {
    graphRef.current = graphJson;
    if (!graphJson) {
      return;
    }
    setExecState({
      ...initialState,
      status: 'ready',
      graphTitle: graphJson.title || null,
      graphDescription: graphJson.description || null,
    });
  }, []);

  const start = useCallback(async () => {
    const graphJson = graphRef.current;
    if (!graphJson) return;

    setExecState(prev => ({ ...prev, status: 'running', error: null }));
    try {
      const resp = await startExecution(graphJson);
      threadIdRef.current = resp.thread_id;
      setExecState(prev => mapResponseToState(resp, graphJson, prev));
    } catch (e: any) {
      setExecState(prev => ({
        ...prev,
        status: 'error',
        error: e?.message || String(e),
      }));
    }
  }, []);

  const submitInput = useCallback(async (inputs: Record<string, string>) => {
    const threadId = threadIdRef.current;
    if (!threadId) return;

    setExecState(prev => ({ ...prev, status: 'running', pendingInputs: [], error: null }));
    try {
      const resp = await resumeExecution(threadId, inputs);
      setExecState(prev => mapResponseToState(resp, graphRef.current, prev));
    } catch (e: any) {
      setExecState(prev => ({
        ...prev,
        status: 'error',
        error: e?.message || String(e),
      }));
    }
  }, []);

  const reset = useCallback(() => {
    if (threadIdRef.current) {
      deleteExecutor(threadIdRef.current);
      threadIdRef.current = null;
    }
    graphRef.current = null;
    setExecState(initialState);
  }, []);

  return { execState, loadGraph, start, submitInput, reset };
}
