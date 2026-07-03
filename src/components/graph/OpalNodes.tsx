import { Handle, Position } from '@xyflow/react';
import { Sparkles, Proportions, MessageSquareText } from 'lucide-react';

// 基础节点容器样式
const headerInnerStyle = {
  display: 'flex', 
  alignItems: 'center', 
  gap: '8px'
};

// 1. 用户输入节点 (黄色 Header)
export const UserInputNode = ({ data }: { data: { title: string, description: string } }) => {
  return (
    <div className="opal-node">
      <div className="opal-node-header" style={{ backgroundColor: '#f3ff9e' }}>
        <div style={headerInnerStyle}>
          <MessageSquareText size={20} strokeWidth={2.0} />
          <span>{data.title}</span>
        </div>
        <button className="node-run-btn">▶</button>
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
export const GenerateNode = ({ data }: { data: { title: string, description: string } }) => {
  return (
    <div className="opal-node">
      {/* 左侧输入锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ left: '0px' }}
      />
      
      <div className="opal-node-header" style={{ backgroundColor: '#c7d2fe' }}>
        <div style={headerInnerStyle}>
          <Sparkles size={20} strokeWidth={2.0} />
          <span>{data.title}</span>
        </div>
        <button className="node-run-btn">▶</button>
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
export const OutputNode = ({ data }: { data: { title: string, description: string } }) => {
  return (
    <div className="opal-node">
      {/* 左侧输入锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ left: '0px' }}
      />
      
      <div className="opal-node-header" style={{ backgroundColor: '#bbf7d0' }}>
        <div style={headerInnerStyle}>
          <Proportions size={20} strokeWidth={2.0} />
          <span>{data.title}</span>
        </div>
        <button className="node-run-btn">▶</button>
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