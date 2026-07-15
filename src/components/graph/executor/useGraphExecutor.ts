import { useState, useCallback, useRef } from "react";
import type { OpalJson, OpalNode } from "@/types";
import { OpalNodeType } from "@/types";
import type { ExecutionState, InputRequest, NodeExecStatus, NodeExecInfo } from "./types";
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

/**
 * 提取 LLM 输出中的 HTML 内容。
 * 优先匹配文本中任意位置的 ```html ... ```(或无语言标注的 ```)代码块,
 * 例如:"好的,我已生成页面 ```html\n<html></html>\n``` 你可以查看"。
 * 若未找到代码块,则回退为去除首尾可能残缺的围栏标记。
 */
function stripHtmlFence(html: string): string {
  // 优先提取带 html 语言标注的代码块
  const htmlFence = html.match(/```html\s*\n?([\s\S]*?)\n?\s*```/i);
  if (htmlFence) {
    return htmlFence[1].trim();
  }
  // 其次尝试匹配无语言标注的代码块(内容看起来像 HTML 时)
  const plainFence = html.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (plainFence && /<[a-z!][\s\S]*>/i.test(plainFence[1])) {
    return plainFence[1].trim();
  }
  // 回退:去除首尾残缺的围栏标记
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
  for (const node of graphJson?.nodes || []) {
    statuses[node.id] = 'pending';
  }

  for (const id of completed) {
    statuses[id] = 'completed';
  }

  if (currentNodeId && statuses[currentNodeId] !== 'completed') {
    statuses[currentNodeId] = 'running';
  }

  return statuses;
}

/**
 * 增量更新节点执行日志:按首次出现顺序保留条目,若已存在则就地合并
 * (更新状态/输入/输出),否则追加到末尾。
 */
function upsertLog(
  log: NodeExecInfo[],
  entry: NodeExecInfo,
): NodeExecInfo[] {
  const idx = log.findIndex(l => l.nodeId === entry.nodeId);
  if (idx === -1) {
    return [...log, entry];
  }
  const next = log.slice();
  next[idx] = {
    ...next[idx],
    ...entry,
    // 保留已有的 input/output,避免被 undefined 覆盖
    input: entry.input ?? next[idx].input,
    output: entry.output ?? next[idx].output,
  };
  return next;
}

/** 把一条 SSE 事件应用到前端 ExecutionState 上,增量更新。 */
function applyStreamEvent(
  evt: ServerStreamEvent,
  graphJson: OpalJson | null,
  prev: ExecutionState,
): ExecutionState {

  const nodeMap = new Map((graphJson?.nodes || []).map(n => [n.id, n]));
  const titleOf = (id: string | null) => id ? (nodeMap.get(id)?.metadata?.title || id) : null;

  switch (evt.event) {
    case 'started':
      return { ...prev, status: 'running', error: null };

    case 'node_complete': {
      const nodeOutputs = { ...prev.nodeOutputs };
      if (evt.node_id) {
        nodeOutputs[evt.node_id] = evt.output || '';
      }

      const completed = evt.completed_nodes || Object.keys(nodeOutputs);
      const currentNodeId = evt.current_node || null;

      // 记录刚完成的节点(含输出),并把新的当前节点标记为 running
      let nodeExecLog = prev.nodeExecLog;
      if (evt.node_id) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: evt.node_id,
          title: titleOf(evt.node_id) || evt.node_id,
          status: 'completed',
          output: evt.output || undefined,
        });
      }
      if (currentNodeId) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: currentNodeId,
          title: titleOf(currentNodeId) || currentNodeId,
          status: 'running',
        });
      }

      return {
        ...prev,
        status: 'running',
        nodeOutputs,
        renderedHtml: extractRenderedHtml(graphJson, nodeOutputs),
        currentNodeId,
        currentNodeTitle: titleOf(currentNodeId),
        nodeStatuses: buildNodeStatuses(graphJson, completed, currentNodeId),
        nodeExecLog,
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
      for (const id of waiting) {
        statuses[id] = 'running';
      }

      // 等待输入的节点在日志中标记为 running,记录其提问内容
      let nodeExecLog = prev.nodeExecLog;
      for (const p of pendingInputs) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: p.nodeId,
          title: p.title || titleOf(p.nodeId) || p.nodeId,
          status: 'running',
          input: p.description || undefined,
        });
      }

      return {
        ...prev,
        status: 'waiting_input',
        pendingInputs,
        currentNodeId: waiting[0] || null,
        currentNodeTitle: titleOf(waiting[0] || null),
        nodeStatuses: statuses,
        nodeExecLog,
      };
    }

    case 'completed': {
      const nodeOutputs = evt.node_outputs || prev.nodeOutputs;
      const completed = evt.completed_nodes || Object.keys(nodeOutputs);

      // 用最终结果补全每个已完成节点的输出与状态
      let nodeExecLog = prev.nodeExecLog;
      for (const id of completed) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: id,
          title: titleOf(id) || id,
          status: 'completed',
          output: nodeOutputs[id] || undefined,
        });
      }

      return {
        ...prev,
        status: 'completed',
        pendingInputs: [],
        nodeOutputs,
        renderedHtml: extractRenderedHtml(graphJson, nodeOutputs),
        currentNodeId: null,
        currentNodeTitle: null,
        nodeStatuses: buildNodeStatuses(graphJson, completed, null),
        nodeExecLog,
      };
    }

    case 'error': {
      // 把出错节点(若有)标记为 error,便于控制台定位
      let nodeExecLog = prev.nodeExecLog;
      const errNodeId = evt.node_id || prev.currentNodeId;
      if (errNodeId) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: errNodeId,
          title: titleOf(errNodeId) || errNodeId,
          status: 'error',
          output: evt.error || undefined,
        });
      }
      return { ...prev, status: 'error', error: evt.error || '执行出错', nodeExecLog };
    }

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
