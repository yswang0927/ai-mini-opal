import type { ReactNode } from 'react';
import { Sparkles, Proportions, MessageSquareText } from 'lucide-react';

// 所有节点类型字面量联合
export type NodeTypeKey = 'userInput' | 'opalGenerate' | 'opalOutput';

type NodeStyleConfig = {
  bgColor: string;
  icon: ReactNode;
};

export const NodeTypes: Record<NodeTypeKey, NodeStyleConfig> = {
  "userInput": {
    "bgColor": "#f3ff9e",
    "icon": <MessageSquareText size={20} strokeWidth={2.0} />
  },
  "opalGenerate": {
    "bgColor": "#c7d2fe",
    "icon": <Sparkles size={20} strokeWidth={2.0} />
  },
  "opalOutput": {
    "bgColor": "#bbf7d0",
    "icon": <Proportions size={20} strokeWidth={2.0} />
  }
};

export type NodeRawMetadataType = {
  title: string;
  visual?: {
    x: number;
    y: number;
  };
  userModified?: boolean;
  step_intent?: string;
  expected_output?: Array<{
    type: string;
    description: string;
    list: boolean;
  }>;
};

export type RawConfigNodeType = {
  parts: Array<{ text: string }>;
  role: string;
};

export type NodeRawConfigurationType = {
  description?: RawConfigNodeType;
  text?: RawConfigNodeType;
  "config$prompt"?: RawConfigNodeType;
  "generation-mode"?: string;
  "config$ask-user"?: boolean;
  "config$list"?: boolean;
  "p-modality"?: string;
  "p-required"?: boolean;
  "p-render-mode"?: string;
  "system-instruction"?: RawConfigNodeType;

  // 索引签名：允许 string 类型变量作为下标访问
  [key: string]: any;
};

export type NodeRawDataType = {
  id: string;
  type: string;
  metadata: NodeRawMetadataType;
  configuration?: NodeRawConfigurationType;
};

export type NodeDataType = {
  id: string;
  type: NodeTypeKey;
  data: NodeRawDataType;
}