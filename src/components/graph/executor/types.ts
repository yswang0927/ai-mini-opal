export interface OpalNode {
  id: string;
  type: string;
  metadata: any;
  configuration: any;
}

export interface OpalEdge {
  from: string;
  to: string;
  out: string;
  in: string;
}

export interface OpalGraphJson {
  metadata: any;
  title: string;
  description: string;
  nodes: OpalNode[];
  edges: OpalEdge[];
}

export type ExecutionStatus = 'idle' | 'ready' | 'waiting_input' | 'running' | 'completed' | 'error';

export interface InputRequest {
  nodeId: string;
  title: string;
  description: string;
  modality: string;
  required: boolean;
}

export interface ExecutionState {
  status: ExecutionStatus;
  pendingInputs: InputRequest[];
  nodeOutputs: Record<string, string>;
  renderedHtml: string | null;
  error: string | null;
  currentNodeId: string | null;
  currentNodeTitle: string | null;
  graphTitle: string | null;
  graphDescription: string | null;
}