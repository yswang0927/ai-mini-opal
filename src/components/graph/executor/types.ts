export type ExecutionStatus = 'idle' | 'ready' | 'waiting_input' | 'running' | 'completed' | 'error';

export type NodeExecStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'error';

export interface InputRequest {
  nodeId: string;
  title: string;
  description: string;
  modality: string;
  required: boolean;
}

export interface NodeExecInfo {
  nodeId: string;
  title: string;
  status: NodeExecStatus;
  input?: string;
  output?: string;
}

export interface RenderedOutput {
  title: string;
  type?: string;
  content?: string;
}

export interface ExecutionState {
  status: ExecutionStatus;
  pendingInputs: InputRequest[];
  nodeOutputs: Record<string, string>;
  renderedOutputs: RenderedOutput[] | null;
  error: string | null;
  currentNodeId: string | null;
  currentNodeTitle: string | null;
  graphTitle: string | null;
  graphDescription: string | null;
  nodeStatuses: Record<string, NodeExecStatus>;
  nodeExecLog: NodeExecInfo[];
}