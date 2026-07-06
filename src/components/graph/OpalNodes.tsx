import type { ReactNode } from 'react';

import { Handle, Position } from '@xyflow/react';
import { Sparkles, Proportions, MessageSquareText } from 'lucide-react';
import { CaretRightIcon } from '@/components/icons'

export type NodeData = {
  id: string;
  type: string;
  data: NodeDataType
}

export type NodeDataType = {
  id: string;
  type: string;
  metadata: {
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
  configuration?: {
    description?: {
      parts: Array<{ text: string }>;
      role: string;
    };
    text?: {
      parts: Array<{ text: string }>;
      role: string;
    };
    "config$prompt"?: {
      parts: Array<{ text: string }>;
      role: string;
    };
    "generation-mode"?: string;
    "config$ask-user"?: boolean;
    "config$list"?: boolean;
    "p-modality"?: string;
    "p-required"?: boolean;
    "p-render-mode"?: string;
    "system-instruction"?: {
      parts: Array<{ text: string }>;
      role: string;
    };
  };
};

// 所有节点类型字面量联合
export type NodeTypeKey = 'userInput' | 'opalGenerate' | 'opalOutput';

// 单个节点样式配置类型
type NodeConfig = {
  bgColor: string;
  icon: ReactNode;
};

export const NodeTypes: Record<NodeTypeKey, NodeConfig> = {
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

const BaseNode = ({nodeData, nodeType, hasInput=true, hasOutput=true}: {
  nodeData: NodeData,
  nodeType: NodeTypeKey,
  hasInput: boolean,
  hasOutput: boolean,
}) => {
  const rawData = nodeData.data;
  let desc = '';
  if ('userInput' === nodeData.type) {
    desc = rawData.configuration?.description?.parts[0].text || '';
  }
  else if ('opalGenerate' === nodeData.type) {
    desc = rawData.metadata.step_intent || rawData.configuration?.config$prompt?.parts[0].text || '';
  }
  else if ('opalOutput' === nodeData.type) {
    desc = rawData.metadata.step_intent || rawData.configuration?.text?.parts[0].text || '';
  }
  if (desc.length > 100) {
    desc = desc.substring(0, 100) + '...';
  }

  return (
    <div className="opal-node">
      <div className="opal-node-header" style={{ backgroundColor: NodeTypes[nodeType].bgColor }}>
        <div className="flex-1 flex items-center opal-node-header-title" title={nodeData.id}>
          <span>{ NodeTypes[nodeType].icon }</span>
          <div className="flex-1 text-ellipsis">{rawData.metadata.title}</div>
        </div>
        <button className="node-run-btn"><CaretRightIcon /></button>
      </div>
      
      <div className="opal-node-body">
        {desc ? desc : (<div className="missing">Select to edit in editor</div>)}
      </div>
      
      {/* 左侧输入锚点 */}
      {hasInput && (<Handle type="target" position={Position.Left} style={{ left: '0px' }} />)}

      {/* 右侧输出锚点 */}
      {hasOutput && (<Handle type="source" position={Position.Right} style={{ right: '0px' }} />)}
    </div>
  );
};

// 1. 用户输入节点 (黄色 Header)
export const UserInputNode = (data: NodeData) => {
  return (
    <BaseNode nodeData={data} nodeType="userInput" hasInput={false} hasOutput={true} />
  );
};

// 2. AI生成节点 (蓝色 Header)
export const GenerateNode = (data: NodeData) => {
  return (
    <BaseNode nodeData={data} nodeType="opalGenerate" hasInput={true} hasOutput={true} />
  );
};

// 3. 输出节点 (绿色 Header)
export const OutputNode = (data: NodeData) => {
  return (
    <BaseNode nodeData={data} nodeType="opalOutput" hasInput={true} hasOutput={true} />
  );
};
