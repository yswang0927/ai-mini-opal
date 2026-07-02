import { useEffect, useCallback } from 'react';
import { 
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  ConnectionLineType,
  MarkerType
} from '@xyflow/react';

import '@xyflow/react/dist/style.css';
import './chatflow.css';

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
    strokeDasharray: '5,5',
  },
  markerEnd: {
    type: MarkerType.ArrowClosed, // 闭合实心箭头
    width: 16, 
    height: 16, 
    color: '#C5CBD3',  
  },
};
 
export default function ChatFlow() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (params: any) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

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

        console.log(graphNodes);
        console.log(graphEdges);

        setNodes(graphNodes);
        setEdges(graphEdges);

      });
  }, []);

  return (
    <div className="absolute inset-0" style={{ backgroundColor: '#f8fafc' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
      >
        {/* 背景网格点 */}
        <Background color="#C5CBD3" gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}