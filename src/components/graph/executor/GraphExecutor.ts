import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { OpalGraphJson, OpalNode, OpalEdge, InputRequest, ExecutionState, NodeExecStatus, NodeExecInfo } from "./types";
import { resolvePromptTemplate } from "./promptTemplate";
import { getLLM, RENDER_OUTPUT_SYSTEM_PROMPT } from "./llm";

function topologicalSort(nodes: OpalNode[], edges: OpalEdge[]): string[] {
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};

  for (const node of nodes) {
    inDegree[node.id] = 0;
    adj[node.id] = [];
  }
  for (const edge of edges) {
    adj[edge.from].push(edge.to);
    inDegree[edge.to] = (inDegree[edge.to] || 0) + 1;
  }

  const queue: string[] = [];
  for (const id of Object.keys(inDegree)) {
    if (inDegree[id] === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const next of adj[current]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }
  return sorted;
}

function getNodeCategory(node: OpalNode): 'input' | 'generate' | 'output' {
  const type = node.type || '';
  if (type.includes('module:user-inputs')) return 'input';
  if (type.includes('generate.bgl.json')) return 'generate';
  if (type.includes('module:render-outputs')) return 'output';
  return 'generate';
}

export class GraphExecutor {
  private graphJson: OpalGraphJson;
  private nodeMap: Map<string, OpalNode>;
  private executionOrder: string[];
  private nodeOutputs: Record<string, string> = {};
  private nodeStatuses: Record<string, NodeExecStatus> = {};
  private nodeExecLog: NodeExecInfo[] = [];
  private inputResolver: ((inputs: Record<string, string>) => void) | null = null;
  private graphTitle: string | null;
  private graphDescription: string | null;

  constructor(graphJson: OpalGraphJson) {
    this.graphJson = graphJson;
    this.nodeMap = new Map(graphJson.nodes.map(n => [n.id, n]));
    this.executionOrder = topologicalSort(graphJson.nodes, graphJson.edges);
    this.graphTitle = graphJson.title || null;
    this.graphDescription = graphJson.description || null;
    for (const nodeId of this.executionOrder) {
      this.nodeStatuses[nodeId] = 'pending';
    }
  }

  private buildState(overrides: Partial<ExecutionState>): ExecutionState {
    return {
      status: 'running',
      pendingInputs: [],
      nodeOutputs: { ...this.nodeOutputs },
      renderedHtml: null,
      error: null,
      currentNodeId: null,
      currentNodeTitle: null,
      graphTitle: this.graphTitle,
      graphDescription: this.graphDescription,
      nodeStatuses: { ...this.nodeStatuses },
      nodeExecLog: [...this.nodeExecLog],
      ...overrides,
    };
  }

  async run(onStateChange: (state: ExecutionState) => void): Promise<void> {
    onStateChange(this.buildState({
      status: 'running',
      currentNodeId: this.executionOrder[0] || null,
      currentNodeTitle: this.nodeMap.get(this.executionOrder[0])?.metadata?.title || null,
    }));

    try {
      for (const nodeId of this.executionOrder) {
        const node = this.nodeMap.get(nodeId)!;
        const category = getNodeCategory(node);

        this.nodeStatuses[nodeId] = 'running';
        onStateChange(this.buildState({
          currentNodeId: nodeId,
          currentNodeTitle: node.metadata?.title || nodeId,
        }));

        if (category === 'input') {
          await this.executeInputNode(node, onStateChange);
        } else if (category === 'generate') {
          await this.executeGenerateNode(node);
        } else {
          await this.executeOutputNode(node);
        }

        this.nodeStatuses[nodeId] = 'completed';
        onStateChange(this.buildState({
          currentNodeId: nodeId,
          currentNodeTitle: node.metadata?.title || nodeId,
        }));
      }

      this.emitCompleted(onStateChange);
    } catch (e: any) {
      if (this.executionOrder.length) {
        const lastId = this.executionOrder.find(id => this.nodeStatuses[id] === 'running');
        if (lastId) this.nodeStatuses[lastId] = 'error';
      }
      onStateChange(this.buildState({
        status: 'error',
        error: e.message || String(e),
        currentNodeId: null,
        currentNodeTitle: null,
      }));
    }
  }

  resumeWithInput(inputs: Record<string, string>): void {
    if (this.inputResolver) {
      this.inputResolver(inputs);
      this.inputResolver = null;
    }
  }

  private async executeInputNode(
    node: OpalNode,
    onStateChange: (state: ExecutionState) => void
  ): Promise<void> {
    const config = node.configuration || {};
    const description = config.description?.parts?.[0]?.text || node.metadata?.title || "请输入";
    const title = node.metadata?.title || node.id;

    const inputRequest: InputRequest = {
      nodeId: node.id,
      title,
      description,
      modality: config["p-modality"] || "Text",
      required: config["p-required"] !== false,
    };

    onStateChange(this.buildState({
      status: 'waiting_input',
      pendingInputs: [inputRequest],
      currentNodeId: node.id,
      currentNodeTitle: title,
    }));

    const inputs = await new Promise<Record<string, string>>((resolve) => {
      this.inputResolver = resolve;
    });

    const userInput = inputs[node.id] || "";
    this.nodeOutputs[node.id] = userInput;

    this.nodeExecLog.push({
      nodeId: node.id,
      title,
      status: 'completed',
      input: description,
      output: userInput,
    });
  }

  private async executeGenerateNode(node: OpalNode): Promise<void> {
    const config = node.configuration || {};
    const promptTemplate = config["config$prompt"]?.parts?.[0]?.text || "";
    const systemTemplate = config["system-instruction"]?.parts?.[0]?.text || "";

    const resolvedPrompt = resolvePromptTemplate(promptTemplate, this.nodeOutputs);
    const resolvedSystem = systemTemplate
      ? resolvePromptTemplate(systemTemplate, this.nodeOutputs)
      : "You are a helpful assistant. Respond concisely.";

    const llm = getLLM();
    const messages = [
      new SystemMessage(resolvedSystem),
      new HumanMessage(resolvedPrompt),
    ];

    const response = await llm.invoke(messages);
    const output = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    this.nodeOutputs[node.id] = output;

    this.nodeExecLog.push({
      nodeId: node.id,
      title: node.metadata?.title || node.id,
      status: 'completed',
      input: resolvedPrompt,
      output: output.length > 2000 ? output.substring(0, 2000) + '...' : output,
    });
  }

  private async executeOutputNode(node: OpalNode): Promise<void> {
    const config = node.configuration || {};
    const textTemplate = config.text?.parts?.[0]?.text || "";
    const resolvedText = resolvePromptTemplate(textTemplate, this.nodeOutputs);

    const llm = getLLM();
    const systemPrompt = RENDER_OUTPUT_SYSTEM_PROMPT;

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(resolvedText),
    ];

    const response = await llm.invoke(messages);
    const html = typeof response.content === 'string'
      ? response.content
      : String(response.content);

    const cleanedHtml = html.replace(/^```html\n?/, '').replace(/\n?```$/, '');
    this.nodeOutputs[node.id] = cleanedHtml;

    this.nodeExecLog.push({
      nodeId: node.id,
      title: node.metadata?.title || node.id,
      status: 'completed',
      input: resolvedText.length > 500 ? resolvedText.substring(0, 500) + '...' : resolvedText,
      output: '[HTML rendered]',
    });
  }

  private emitCompleted(onStateChange: (state: ExecutionState) => void) {
    let renderedHtml: string | null = null;
    for (const node of this.graphJson.nodes) {
      if (getNodeCategory(node) === 'output' && this.nodeOutputs[node.id]) {
        renderedHtml = this.nodeOutputs[node.id];
        break;
      }
    }

    onStateChange(this.buildState({
      status: 'completed',
      renderedHtml,
      currentNodeId: null,
      currentNodeTitle: null,
    }));
  }
}
