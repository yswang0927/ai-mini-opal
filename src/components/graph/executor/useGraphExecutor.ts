import { useState, useCallback, useRef } from "react";
import type { OpalJson, OpalNode } from "@/types";
import { OpalNodeType } from "@/types";
import type { ExecutionState, InputRequest, NodeExecStatus, NodeExecInfo, RenderedOutput } from "./types";
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
  renderedOutputs: null,
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
  let content = html.trim();

  // 1. 预处理：如果 LLM 输出中断导致末尾缺失 ```，我们手动补齐以确保正则匹配
  const fenceCount = (content.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0 && content.startsWith('```')) {
    content += '\n```';
  }

  // 2. 优先提取带 html 语言标注的代码块
  const htmlFence = content.match(/```html\s*\n?([\s\S]*?)\n?\s*```/i);
  if (htmlFence) {
    return htmlFence[1].trim();
  }

  // 3. 兼容没有标注语言，但成对出现的代码块（内容包含 HTML 特征）
  const plainFence = content.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (plainFence && /<[a-z!][\s\S]*>/i.test(plainFence[1])) {
    return plainFence[1].trim();
  }

  // 4. 回退：直接截取从 <html> 开始到 </html>（或结尾）的内容
  // 匹配起点必定是 <html，故统一补上 doctype 以保证 iframe 在标准模式下渲染
  const htmlTagMatch = content.match(/<html[\s\S]*?(?:<\/html>|$)/i);
  if (htmlTagMatch) {
    return '<!DOCTYPE html>\n' + htmlTagMatch[0].trim();
  }

  // 5. 终极回退：去除首尾可能残缺的围栏标记，直接返回干净的文本
  return content
    .replace(/^\s*```(?:html)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/**
 * 计算某节点的「输入」:其数据依赖(前置)节点的输出拼接。
 * 数据边规则与后端一致(opal_executor.py): out 为空串或 "context" 视为数据/依赖边,
 * 其余非空 out 是条件路由边,不计入数据输入。
 * 若无数据父节点、或父节点尚无输出,返回 null(交由 upsertLog 保留原有 input,
 * 例如 user-input 节点在 waiting_input 阶段记录的提问内容)。
 */
function computeNodeInput(
  graphJson: OpalJson | null,
  nodeId: string,
  outputs: Record<string, string>,
): string | null {
  if (!graphJson?.edges) return null;
  const nodeMap = new Map((graphJson.nodes || []).map(n => [n.id, n]));

  const parents: string[] = [];
  for (const edge of graphJson.edges) {
    if (edge.to !== nodeId) continue;
    const out = (edge.out || '').trim();
    // 只保留数据/依赖边;路由边(out 携带非空且非 "context" 标记)跳过
    if (out === '' || out === 'context') {
      if (!parents.includes(edge.from)) parents.push(edge.from);
    }
  }
  if (parents.length === 0) return null;

  const parts: string[] = [];
  for (const pid of parents) {
    const val = outputs[pid];
    if (val === undefined || val === '') continue;
    const title = nodeMap.get(pid)?.metadata?.title || pid;
    parts.push(`• ${title}\n${val}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** 从服务端 node_outputs 中提取输出节点的输出内容 */
function extractRenderedOutputs(graphJson: OpalJson | null, outputs: Record<string, string>): RenderedOutput[] | null {
  if (!graphJson?.nodes) return null;
  const renderedOutputs: RenderedOutput[] = [];
  for (const node of graphJson.nodes) {
    if (isRenderNode(node) && outputs[node.id]) {
      renderedOutputs.push({
        title: node.metadata.title,
        type: 'html', // 目前只支持html一个输出
        content: stripHtmlFence(outputs[node.id])
      });
    }
  }
  return renderedOutputs;
}

/** 根据 completed_nodes / skipped_nodes / current_node 重建节点状态映射。 */
function buildNodeStatuses(
  graphJson: OpalJson | null,
  completed: string[],
  currentNodeId: string | null,
  skipped: string[] = [],
): Record<string, NodeExecStatus> {
  const statuses: Record<string, NodeExecStatus> = {};
  for (const node of graphJson?.nodes || []) {
    statuses[node.id] = 'pending';
  }

  for (const id of completed) {
    statuses[id] = 'completed';
  }

  // 被路由跳过的节点标记为 skipped(不覆盖已完成的节点)
  for (const id of skipped) {
    if (statuses[id] !== 'completed') {
      statuses[id] = 'skipped';
    }
  }

  if (currentNodeId && statuses[currentNodeId] !== 'completed' && statuses[currentNodeId] !== 'skipped') {
    statuses[currentNodeId] = 'running';
  }

  return statuses;
}

/** 从上一轮状态映射中收集已被标记为 skipped 的节点 id,用于跨事件保留跳过状态。 */
function prevSkipped(prev: ExecutionState): string[] {
  return Object.entries(prev.nodeStatuses)
    .filter(([, s]) => s === 'skipped')
    .map(([id]) => id);
}

/** 合并事件携带的 skipped_nodes 与此前已知的跳过节点,去重。 */
function mergeSkipped(evt: ServerStreamEvent, prev: ExecutionState): string[] {
  return Array.from(new Set([...prevSkipped(prev), ...(evt.skipped_nodes || [])]));
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
      const skipped = mergeSkipped(evt, prev);

      // 记录刚完成的节点(含输入=前置依赖输出、输出),并把新的当前节点标记为 running
      let nodeExecLog = prev.nodeExecLog;
      if (evt.node_id) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: evt.node_id,
          title: titleOf(evt.node_id) || evt.node_id,
          status: 'completed',
          input: computeNodeInput(graphJson, evt.node_id, nodeOutputs) || undefined,
          output: evt.output || undefined,
        });
      }
      if (currentNodeId) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: currentNodeId,
          title: titleOf(currentNodeId) || currentNodeId,
          status: 'running',
          input: computeNodeInput(graphJson, currentNodeId, nodeOutputs) || undefined,
        });
      }

      return {
        ...prev,
        status: 'running',
        nodeOutputs,
        renderedOutputs: extractRenderedOutputs(graphJson, nodeOutputs),
        currentNodeId,
        currentNodeTitle: titleOf(currentNodeId),
        nodeStatuses: buildNodeStatuses(graphJson, completed, currentNodeId, skipped),
        nodeExecLog,
      };
    }

    case 'node_skipped': {
      // 因路由未命中被跳过的节点:置为 skipped,不产生输出。
      const skipped = mergeSkipped(evt, prev);
      const completed = evt.completed_nodes || Object.keys(prev.nodeOutputs);
      const currentNodeId = evt.current_node || null;

      let nodeExecLog = prev.nodeExecLog;
      if (evt.node_id) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: evt.node_id,
          title: titleOf(evt.node_id) || evt.node_id,
          status: 'skipped',
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
        currentNodeId,
        currentNodeTitle: titleOf(currentNodeId),
        nodeStatuses: buildNodeStatuses(graphJson, completed, currentNodeId, skipped),
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
      const skipped = mergeSkipped(evt, prev);
      // 正在等待输入的节点标记为 running
      const waiting = evt.waiting_nodes || pendingInputs.map(p => p.nodeId);
      const statuses = buildNodeStatuses(graphJson, completed, null, skipped);
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
      const skipped = mergeSkipped(evt, prev);

      // 用最终结果补全每个已完成节点的输出与状态
      let nodeExecLog = prev.nodeExecLog;
      for (const id of completed) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: id,
          title: titleOf(id) || id,
          status: 'completed',
          input: computeNodeInput(graphJson, id, nodeOutputs) || undefined,
          output: nodeOutputs[id] || undefined,
        });
      }
      // 补全被跳过节点的日志状态
      for (const id of skipped) {
        nodeExecLog = upsertLog(nodeExecLog, {
          nodeId: id,
          title: titleOf(id) || id,
          status: 'skipped',
        });
      }

      return {
        ...prev,
        status: 'completed',
        pendingInputs: [],
        nodeOutputs,
        renderedOutputs: extractRenderedOutputs(graphJson, nodeOutputs),
        currentNodeId: null,
        currentNodeTitle: null,
        nodeStatuses: buildNodeStatuses(graphJson, completed, null, skipped),
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

  const start = useCallback(async (targetNode?: string) => {
    const graphJson = graphRef.current;
    if (!graphJson) return;

    setExecState(prev => ({ ...prev, status: 'running', error: null }));

    try {
      await startExecutionStream(graphJson, evt => {
        if (evt.event === 'started' && evt.thread_id) {
          threadIdRef.current = evt.thread_id;
        }
        setExecState(prev => applyStreamEvent(evt, graphRef.current, prev));
      }, undefined, targetNode);

    } catch (e: any) {
      setExecState(prev => ({
        ...prev,
        status: 'error',
        error: e?.message || String(e),
      }));
    }
  }, []);

  /**
   * 「运行到此节点」:从头执行到目标节点(含其祖先)后停止,其余节点标记为 skipped。
   * 会清空上一轮执行状态并另起一个新的 thread,再以 targetNode 为作用域重新执行。
   */
  const runToNode = useCallback(async (targetNode: string) => {
    const graphJson = graphRef.current;
    if (!graphJson || !targetNode) return;

    // 结束上一轮 executor,避免服务端实例泄漏
    if (threadIdRef.current) {
      deleteExecutor(threadIdRef.current);
      threadIdRef.current = null;
    }

    // 保留图信息,清空节点状态/日志/输出,重置为一次干净的执行
    setExecState({
      ...initialState,
      status: 'running',
      graphTitle: graphJson.title || null,
      graphDescription: graphJson.description || null,
    });

    await start(targetNode);
  }, [start]);

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

  return { execState, loadGraph, start, runToNode, submitInput, reset };
}
