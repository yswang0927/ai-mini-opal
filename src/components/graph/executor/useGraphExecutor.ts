import { useState, useCallback, useRef } from "react";
import type { OpalJson, OpalNode } from "@/types";
import { OpalNodeType } from "@/types";
import type { ExecutionState, InputRequest, NodeExecStatus } from "./types";
import {
  startExecutionStream,
  resumeExecutionStream,
  deleteExecutor,
  type ServerStreamEvent,
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

/** 根据 completed_nodes / current_node 重建节点状态映射。 */
function buildNodeStatuses(
  graphJson: OpalJson | null,
  completed: string[],
  currentNodeId: string | null,
): Record<string, NodeExecStatus> {
  const statuses: Record<string, NodeExecStatus> = {};
  for (const node of graphJson?.nodes || []) statuses[node.id] = 'pending';
  for (const id of completed) statuses[id] = 'completed';
  if (currentNodeId && statuses[currentNodeId] !== 'completed') {
    statuses[currentNodeId] = 'running';
  }
  return statuses;
}

/** 把一条 SSE 事件应用到前端 ExecutionState 上,增量更新。 */
function applyStreamEvent(
  evt: ServerStreamEvent,
  graphJson: OpalJson | null,
  prev: ExecutionState,
): ExecutionState {
  const nodeMap = new Map((graphJson?.nodes || []).map(n => [n.id, n]));
  const titleOf = (id: string | null) =>
    id ? (nodeMap.get(id)?.metadata?.title || id) : null;

  switch (evt.event) {
    case 'started':
      return { ...prev, status: 'running', error: null };

    case 'node_complete': {
      const nodeOutputs = { ...prev.nodeOutputs };
      if (evt.node_id) nodeOutputs[evt.node_id] = evt.output || '';
      const completed = evt.completed_nodes || Object.keys(nodeOutputs);
      const currentNodeId = evt.current_node || null;
      return {
        ...prev,
        status: 'running',
        nodeOutputs,
        renderedHtml: extractRenderedHtml(graphJson, nodeOutputs),
        currentNodeId,
        currentNodeTitle: titleOf(currentNodeId),
        nodeStatuses: buildNodeStatuses(graphJson, completed, currentNodeId),
      };
    }

    case 'waiting_input': {
      const pendingInputs: InputRequest[] = (evt.interrupts || []).map(intr => ({
        nodeId: intr.node_id,
        title: intr.title,
        description: intr.question,
        modality: intr.modality || 'Text',
        required: intr.required !== false,
      }));
      const completed = evt.completed_nodes || Object.keys(prev.nodeOutputs);
      // 正在等待输入的节点标记为 running
      const waiting = evt.waiting_nodes || pendingInputs.map(p => p.nodeId);
      const statuses = buildNodeStatuses(graphJson, completed, null);
      for (const id of waiting) statuses[id] = 'running';
      return {
        ...prev,
        status: 'waiting_input',
        pendingInputs,
        currentNodeId: waiting[0] || null,
        currentNodeTitle: titleOf(waiting[0] || null),
        nodeStatuses: statuses,
      };
    }

    case 'completed': {
      const nodeOutputs = evt.node_outputs || prev.nodeOutputs;
      const completed = evt.completed_nodes || Object.keys(nodeOutputs);
      return {
        ...prev,
        status: 'completed',
        pendingInputs: [],
        nodeOutputs,
        renderedHtml: extractRenderedHtml(graphJson, nodeOutputs),
        currentNodeId: null,
        currentNodeTitle: null,
        nodeStatuses: buildNodeStatuses(graphJson, completed, null),
      };
    }

    case 'error':
      return { ...prev, status: 'error', error: evt.error || '执行出错' };

    default:
      return prev;
  }
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
      await startExecutionStream(graphJson, evt => {
        if (evt.event === 'started' && evt.thread_id) {
          threadIdRef.current = evt.thread_id;
        }
        setExecState(prev => applyStreamEvent(evt, graphRef.current, prev));
      });
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
      await resumeExecutionStream(threadId, inputs, evt => {
        setExecState(prev => applyStreamEvent(evt, graphRef.current, prev));
      });
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
