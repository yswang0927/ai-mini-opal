import { Handle, Position } from '@xyflow/react';
import { CaretRightIcon } from '@/utils/icons'
import { OpalNodeType } from '@/types';
import { NodeTypesStyle, type FlowNode } from './types';


const BaseNode = ({nodeData, nodeType, hasInput=true, hasOutput=true}: {
  nodeData: FlowNode,
  nodeType: OpalNodeType,
  hasInput: boolean,
  hasOutput: boolean,
}) => {

  const rawData = nodeData.data;
  const title = rawData.metadata.title || '';
  
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

  }
  else if (nodeType === OpalNodeType.AssetsFile) {
    
  }

  if (desc.length > 100) {
    desc = desc.substring(0, 100) + '...';
  }

  return (
    <div className="opal-node">
      <div className="opal-node-header" style={{ backgroundColor: NodeTypesStyle[nodeType].bgColor }}>
        <div className="flex-1 flex items-center opal-node-header-title" title={nodeData.id}>
          <span className="opal-node-header-icon">{ NodeTypesStyle[nodeType].icon }</span>
          <div className="flex-1 text-ellipsis">{title}</div>
        </div>
        {/*<button className="node-run-btn"><CaretRightIcon /></button>*/}
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