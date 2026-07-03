import { useEffect, useCallback, useRef } from 'react';
import { 
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  ConnectionLineType,
  MarkerType
} from '@xyflow/react';
import { Sparkles, Proportions, MessageSquareText, SquarePlus, SendHorizontal } from 'lucide-react';

import '@xyflow/react/dist/style.css';
import './chatgraph.css';

import { UserInputNode, GenerateNode, OutputNode } from './OpalNodes';
 
// 注册自定义节点映射
const nodeTypes = {
  userInput: UserInputNode,
  opalGenerate: GenerateNode,
  opalOutput: OutputNode,
};

// 初始化节点数据（完美对照图片内容）
const initialNodes = [
  {
    id: 'project-name',
    type: 'userInput',
    position: { x: 50, y: 50 },
    data: {
      title: 'Project Name',
      description: 'Enter the full title of your proposed project.',
    },
  },
  {
    id: 'project-budget',
    type: 'userInput',
    position: { x: 50, y: 230 },
    data: {
      title: 'Project Budget',
      description: 'Specify the total estimated budget in numerical format.',
    },
  },
  {
    id: 'project-evaluation',
    type: 'opalGenerate',
    position: { x: 420, y: 130 },
    data: {
      title: 'Project Evaluation And ...',
      description: 'Analyze the project name and budget. If the budget is greater than 1,000,000, generate a detailed risk assessment report.',
    },
  },
  {
    id: 'generate-approval',
    type: 'opalOutput',
    position: { x: 780, y: 130 },
    data: {
      title: 'Generate Approval Out...',
      description: 'Take the generated risk assessment report or approval certificate and render it into an HTML document.',
    },
  },
];

// 初始化连接线
const initialEdges = [
  { id: 'e1', source: 'project-name', target: 'project-evaluation' },
  { id: 'e2', source: 'project-budget', target: 'project-evaluation' },
  { id: 'e3', source: 'project-evaluation', target: 'generate-approval' },
];

// 全局边线默认样式：灰色、虚线、平滑贝塞尔曲线
const defaultEdgeOptions = {
  type: ConnectionLineType.Bezier,
  animated: false,
  style: {
    stroke: '#C5CBD3',
    strokeWidth: 2,
    //strokeDasharray: '5,5',
  },
  markerEnd: {
    type: MarkerType.ArrowClosed, // 闭合实心箭头
    width: 16, 
    height: 16, 
    color: '#C5CBD3',  
  },
};

const NODE_WIDTH = 280;

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};
 
export default function ChatGraph() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<any>(null);

  const onConnect = useCallback(
    (params: any) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow/type', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const appendNewNode = (type: string, position: { x: number, y: number }) => {
    const nodeId = `${type}-${Date.now()}`;
    const newNode = {
      id: nodeId,
      type,
      position,
      data: {
        title: type === 'userInput' ? 'New Input' : type === 'opalGenerate' ? 'New Generate' : 'New Output',
        description: 'Select to edit in editor',
      },
    };
    setNodes((nds) => nds.concat(newNode));
  };

  const addNode = useCallback((type: string) => {
    if (!reactFlowInstance.current) return;
    
    // 计算画布中间位置
    const canvasWidth = reactFlowWrapper.current?.clientWidth || 800;
    const canvasHeight = reactFlowWrapper.current?.clientHeight || 600;
    
    // 将屏幕中间位置转换为画布坐标
    const position = reactFlowInstance.current.screenToFlowPosition({
      x: (canvasWidth / 2 - NODE_WIDTH / 2 + nodeRandomOffset()),
      y: (canvasHeight / 2 + nodeRandomOffset())
    });

    appendNewNode(type, position);
  }, [setNodes]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/reactflow/type');
    if (!type || !reactFlowInstance.current) {
      return;
    }

    const position = reactFlowInstance.current.screenToFlowPosition({
      x: event.clientX - NODE_WIDTH / 2,
      y: event.clientY - 20,
    });

    appendNewNode(type, position);
  }, [setNodes]);

  useEffect(()=>{
    fetch('./generated_graph.json', {
      headers: {
        'Content-Type': 'application/json'
      }
    })
      .then(rsp => rsp.json())
      .then(data => {
        const graphNodes = data.nodes.map((node: any) => {
          const newNode = {
            id: node.id,
            key: node.id,
            type: 'opalGenerate',
            position: { x: node.metadata.visual.x, y: node.metadata.visual.y },
            data: {
              title: node.metadata.title,
              description: ''
            }
          };
          let desc = '';
          const nodeType = node.type || '';
          if (nodeType.includes('embed://a2/generate.bgl.json')) {
            desc = node.metadata.step_intent;
            newNode.type = 'opalGenerate';
          } 
          else if (nodeType.includes('module:render-outputs')) {
            desc = node.metadata.step_intent || node.configuration.description.parts[0].text;
            newNode.type = 'opalOutput';
          }
          else if (nodeType.includes('module:user-inputs')) {
            desc = node.configuration.description.parts[0].text;
            newNode.type = 'userInput';
          }
          const maxLen = 150;
          if (desc.length > maxLen) {
            desc = desc.substring(0, maxLen) + '...';
          }
          newNode.data.description = desc;
          return newNode;
        });

        const graphEdges = data.edges.map((edge: any) => {
          return {
            id: `${edge.from}-${edge.to}`,
            source: edge.from,
            target: edge.to
          };
        });

        setNodes(graphNodes);
        setEdges(graphEdges);
        
        // 加载完成后调用 fitView
        setTimeout(() => {
          reactFlowInstance.current?.fitView({ padding: 0.2 });
        }, 30);
      });
  }, []);

  return (
    <div className="absolute inset-0" style={{ backgroundColor: '#f8fafc', overflow: 'hidden' }} ref={reactFlowWrapper}>
      <div className="graph-nodes-panel">
          <div className="graph-nodes">
            <button data-node-type="userInput" draggable onDragStart={(e) => onDragStart(e, 'userInput')} onClick={() => addNode('userInput')}><MessageSquareText size={20} strokeWidth={1.5}/><span>User Input</span></button>
            <button data-node-type="opalGenerate" draggable onDragStart={(e) => onDragStart(e, 'opalGenerate')} onClick={() => addNode('opalGenerate')}><Sparkles size={20} strokeWidth={1.5}/><span>Generate</span></button>
            <button data-node-type="opalOutput" draggable onDragStart={(e) => onDragStart(e, 'opalOutput')} onClick={() => addNode('opalOutput')}><Proportions size={20} strokeWidth={1.5}/><span>Output</span></button>
            <div className="divider"></div>
            <button><SquarePlus size={20} strokeWidth={1.5}/><span>Add Assets</span></button>
          </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onInit={(instance) => reactFlowInstance.current = instance}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        {/* 背景网格点 */}
        <Background color="#C5CBD3" gap={20} size={1} />
      </ReactFlow>

      <div className="graph-chatbox">
        <div className="graph-chatbox-input flex items-center">
          <textarea rows={1} placeholder="Describe what you want to build"></textarea>
          <button className="graph-chatbox-submit"><SendHorizontal size={24} strokeWidth={1.5} /></button>
        </div>
      </div>

    </div>
  );
}