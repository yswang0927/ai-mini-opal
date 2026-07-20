import { Handle, Position } from '@xyflow/react';
import { Check, TriangleAlert, SkipForward } from 'lucide-react';
import { CaretRightIcon, Spinner } from '@/utils/icons'
import { OpalNodeType } from '@/types';
import { useEditorContext } from '@/pages/editor/EditorContext';
import { NodeTypesStyle, type FlowNode } from './types';

import { NodezatorHandle } from "./NodezatorHandle";

const BaseNode = ({nodeData, nodeType, hasInput=true, hasOutput=true}: {
  nodeData: FlowNode,
  nodeType: OpalNodeType,
  hasInput: boolean,
  hasOutput: boolean,
}) => {
  const { execState, runToNode } = useEditorContext();
  const rawData = nodeData.data;
  const nodeId = nodeData.id;
  const title = rawData.metadata.title || '';

  // 本节点的运行状态
  const runState = execState.nodeStatuses[nodeId] ?? '';
  const isRunning = execState.status === 'running';
  
  let desc = '';
  if (nodeType === OpalNodeType.UserInputs) {
    desc = rawData.configuration?.description?.content || '';
  }
  else if (nodeType === OpalNodeType.AgentGenerate) {
    desc = rawData.metadata.step_intent || rawData.configuration?.config$prompt?.content || '';
  }
  else if (nodeType === OpalNodeType.RenderOutputs) {
    desc = rawData.metadata.step_intent || rawData.configuration?.text?.content || '';
  }
  else if (nodeType === OpalNodeType.AssetsText) {
    desc = rawData.configuration?.text?.content || '';
  }
  else if (nodeType === OpalNodeType.AssetsFile) {
    desc = `File: ${rawData.configuration?.file?.url || ''}`;
  }

  if (desc.length > 100) {
    desc = desc.substring(0, 100) + '...';
  }

  const handleRunHere = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) return;
    runToNode(nodeId);
  };

  return (
    <div className={`opal-node${runState === 'running' ? ' glow-border' : ''}`} data-runstate={runState}>
      <div className="opal-node-header" style={{ backgroundColor: NodeTypesStyle[nodeType].bgColor }}>
        <div className="flex-1 flex items-center opal-node-header-title" title={nodeData.id}>
          <span className="opal-node-header-icon">{ NodeTypesStyle[nodeType].icon }</span>
          <div className="flex-1 text-ellipsis">{title}</div>
        </div>
        <div className="flex items-center nodrag">
          {(execState.status === 'idle' || execState.status === 'ready') && (<button className="node-run-btn" title="点击运行到此节点" onClick={handleRunHere} disabled={isRunning}><CaretRightIcon /></button>)}
          {runState === 'running' && (<span className="node-run-state running"><Spinner /></span>)}
          {runState === 'completed' && (<span className="node-run-state completed"><Check size={16} strokeWidth={1.5} /></span>)}
          {runState === 'skipped' && (<span className="node-run-state skipped" title="已跳过(路由未选中)"><SkipForward size={16} strokeWidth={1.5} /></span>)}
          {runState === 'error' && (<span className="node-run-state error"><TriangleAlert size={16} strokeWidth={1.5} /></span>)}
        </div>
      </div>

      <div className="opal-node-body">
        {desc ? desc : (<div className="missing">Select to edit in editor</div>)}
      </div>
      
      {/* 左侧输入锚点 */}
      {hasInput && (<NodezatorHandle type="target" position={Position.Left} style={{ left: '0px' }} /> )}

      {/* 右侧输出锚点 */}
      {hasOutput && (<NodezatorHandle type="source" position={Position.Right} style={{ right: '0px' }} />)}
    </div>
  );
};

// 1. 用户输入节点 (黄色 Header)
export const UserInputNode = (data: FlowNode) => {
  return (
    <BaseNode nodeData={data} nodeType={OpalNodeType.UserInputs} hasInput={false} hasOutput={true} />
  );
};

// 2. AI生成节点 (蓝色 Header)
export const GenerateNode = (data: FlowNode) => {
  return (
    <BaseNode nodeData={data} nodeType={OpalNodeType.AgentGenerate} hasInput={true} hasOutput={true} />
  );
};

// 3. 输出节点 (绿色 Header)
export const OutputNode = (data: FlowNode) => {
  return (
    <BaseNode nodeData={data} nodeType={OpalNodeType.RenderOutputs} hasInput={true} hasOutput={true} />
  );
};

// 4. 资产Text节点
export const AssetsTextNode = (data: FlowNode) => {
  return (
    <BaseNode nodeData={data} nodeType={OpalNodeType.AssetsText} hasInput={false} hasOutput={true} />
  );
};
// 5. 资产File点
export const AssetsFileNode = (data: FlowNode) => {
  return (
    <BaseNode nodeData={data} nodeType={OpalNodeType.AssetsFile} hasInput={false} hasOutput={true} />
  );
};