import { Handle, Position } from '@xyflow/react';
import { Sparkles, Proportions, MessageSquareText } from 'lucide-react';
import { CaretRightIcon } from '@/components/icons'

type nodeData = {
  id: string,
  data: {
    title: string,
    description: string
  }
}

const headerInnerStyle = {
  gap: '8px'
};

// 1. 用户输入节点 (黄色 Header)
export const UserInputNode = ({ id, data }: nodeData) => {
  return (
    <div className="opal-node">
      <div className="opal-node-header" style={{ backgroundColor: '#f3ff9e' }}>
        <div className="flex-1 flex items-center" style={headerInnerStyle} title={id}>
          <MessageSquareText size={20} strokeWidth={2.0} />
          <div className="flex-1 text-ellipsis">{data.title}</div>
        </div>
        <button className="node-run-btn"><CaretRightIcon /></button>
      </div>
      <div className="opal-node-body">{data.description}</div>
      
      {/* 右侧输出锚点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ right: '0px' }}
      />
    </div>
  );
};

// 2. AI生成节点 (蓝色 Header)
export const GenerateNode = ({ id, data }: nodeData) => {
  return (
    <div className="opal-node">
      {/* 左侧输入锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ left: '0px' }}
      />
      
      <div className="opal-node-header" style={{ backgroundColor: '#c7d2fe' }}>
        <div className="flex-1 flex items-center" style={headerInnerStyle} title={id}>
          <Sparkles size={20} strokeWidth={2.0} />
          <div className="flex-1 text-ellipsis">{data.title}</div>
        </div>
        <button className="node-run-btn"><CaretRightIcon /></button>
      </div>
      <div className="opal-node-body">{data.description}</div>
      
      {/* 右侧输出锚点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ right: '0px' }}
      />
    </div>
  );
};

// 3. 输出节点 (绿色 Header)
export const OutputNode = ({ id, data }: nodeData) => {
  return (
    <div className="opal-node">
      {/* 左侧输入锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ left: '0px' }}
      />
      
      <div className="opal-node-header" style={{ backgroundColor: '#bbf7d0' }}>
        <div className="flex-1 flex items-center" style={headerInnerStyle} title={id}>
          <Proportions size={20} strokeWidth={2.0} />
          <div className="flex-1 text-ellipsis">{data.title}</div>
        </div>
        <button className="node-run-btn"><CaretRightIcon /></button>
      </div>
      <div className="opal-node-body">{data.description}</div>
      
      {/* 右侧输出锚点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ right: '0px' }}
      />
    </div>
  );
};