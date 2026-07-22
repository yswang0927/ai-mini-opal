import type { ReactNode } from 'react';
import { Sparkles, Proportions, MessageSquareText, FileText, Upload } from 'lucide-react';
import { type Node } from '@xyflow/react';
import { type OpalNode, OpalNodeType } from '@/types';

type NodeStyle = {
  bgColor: string;
  icon: ReactNode;
};

export const NodeTypesStyle: Record<OpalNodeType, NodeStyle> = {
  [OpalNodeType.UserInputs]: {
    "bgColor": "#f3ff9e",
    "icon": <MessageSquareText size={20} strokeWidth={2.0} />
  },
  [OpalNodeType.AgentGenerate]: {
    "bgColor": "#c7d2fe",
    "icon": <Sparkles size={20} strokeWidth={2.0} />
  },
  [OpalNodeType.RenderOutputs]: {
    "bgColor": "#bbf7d0",
    "icon": <Proportions size={20} strokeWidth={2.0} />
  },
  [OpalNodeType.AssetsText]: {
    "bgColor": "#f6c9ad",
    "icon": <FileText size={20} strokeWidth={2.0} />
  },
  [OpalNodeType.AssetsFile]: {
    "bgColor": "#f6c9ad",
    "icon": <Upload size={20} strokeWidth={2.0} />
  }
};

export interface FlowNode extends Node {
  type: OpalNodeType;
  data: OpalNode;
}

export interface NodeHandleType {
  nodeId: string;
  handleId?: string;
  handleType?: string
}

