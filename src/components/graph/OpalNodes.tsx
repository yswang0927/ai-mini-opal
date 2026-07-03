import { Handle, Position } from '@xyflow/react';
import { Sparkles, Proportions, MessageSquareText } from 'lucide-react';

// 基础节点容器样式
const nodeContainerStyle = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: '12px',
  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
  width: '280px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  overflow: 'hidden',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 12px',
  fontWeight: '600',
  fontSize: '16px',
  color: '#1C2127',
};

const headerInnerStyle = {
  display: 'flex', 
  alignItems: 'center', 
  gap: '8px'
};

const bodyStyle = {
  padding: '12px',
  fontSize: '14px',
  color: '#334155',
  lineHeight: '1.5',
  minHeight: '60px',
};

const handleStyle = {
  width: '12px',
  height: '12px',
  backgroundColor: '#fff',
  border: '2px solid #383E47',
};

// 1. 用户输入节点 (黄色 Header)
export const UserInputNode = ({ data }: { data: { title: string, description: string } }) => {
  return (
    <div style={nodeContainerStyle}>
      <div style={{ ...headerStyle, backgroundColor: '#f3ff9e' }}>
        <div style={headerInnerStyle}>
          <MessageSquareText size={20} strokeWidth={2.0} />
          <span>{data.title}</span>
        </div>
        <button className="node-run-btn">▶</button>
      </div>
      <div style={bodyStyle}>{data.description}</div>
      
      {/* 右侧输出锚点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ ...handleStyle, right: '0px' }}
      />
    </div>
  );
};

// 2. AI生成节点 (蓝色 Header)
export const GenerateNode = ({ data }: { data: { title: string, description: string } }) => {
  return (
    <div style={nodeContainerStyle}>
      {/* 左侧输入锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ ...handleStyle, left: '0px' }}
      />
      
      <div style={{ ...headerStyle, backgroundColor: '#c7d2fe' }}>
        <div style={headerInnerStyle}>
          <Sparkles size={20} strokeWidth={2.0} />
          <span>{data.title}</span>
        </div>
        <button className="node-run-btn">▶</button>
      </div>
      <div style={bodyStyle}>{data.description}</div>
      
      {/* 右侧输出锚点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ ...handleStyle, right: '0px' }}
      />
    </div>
  );
};

// 3. 输出节点 (绿色 Header)
export const OutputNode = ({ data }: { data: { title: string, description: string } }) => {
  return (
    <div style={nodeContainerStyle}>
      {/* 左侧输入锚点 */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ ...handleStyle, left: '0px' }}
      />
      
      <div style={{ ...headerStyle, backgroundColor: '#bbf7d0' }}>
        <div style={headerInnerStyle}>
          <Proportions size={20} strokeWidth={2.0} />
          <span>{data.title}</span>
        </div>
        <button className="node-run-btn">▶</button>
      </div>
      <div style={bodyStyle}>{data.description}</div>
      
      {/* 右侧输出锚点 */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ ...handleStyle, right: '0px' }}
      />
    </div>
  );
};