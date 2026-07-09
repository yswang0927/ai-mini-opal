import { Handle, Position } from '@xyflow/react';
import { CaretRightIcon } from '@/utils/icons'
import { NodeTypes, type NodeDataType, type NodeTypeKey } from './types';


const BaseNode = ({nodeData, nodeType, hasInput=true, hasOutput=true}: {
  nodeData: NodeDataType,
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
          <span className="opal-node-header-icon">{ NodeTypes[nodeType].icon }</span>
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
export const UserInputNode = (data: NodeDataType) => {
  return (
    <BaseNode nodeData={data} nodeType="userInput" hasInput={false} hasOutput={true} />
  );
};

// 2. AI生成节点 (蓝色 Header)
export const GenerateNode = (data: NodeDataType) => {
  return (
    <BaseNode nodeData={data} nodeType="opalGenerate" hasInput={true} hasOutput={true} />
  );
};

// 3. 输出节点 (绿色 Header)
export const OutputNode = (data: NodeDataType) => {
  return (
    <BaseNode nodeData={data} nodeType="opalOutput" hasInput={true} hasOutput={true} />
  );
};
