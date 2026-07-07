import React, { useEffect, useCallback, useRef } from 'react';
import { 
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  ConnectionLineType,
  MarkerType,
  Controls,
  type Node,
  type Edge,
} from '@xyflow/react';

import { 
  Sparkles, 
  Proportions, 
  MessageSquareText, 
  SquarePlus, 
  SendHorizontal 
} from 'lucide-react';

import '@xyflow/react/dist/style.css';
import './style.css';

import { LayoutDagIcon } from '@/components/icons';
import { useEditorContext } from '@/components/editor/EditorContext';
import { 
  UserInputNode, 
  GenerateNode, 
  OutputNode
} from './OpalNodes';
import { type NodeTypeKey, type NodeDataType, type NodeRawDataType } from './types';

import autoLayout from './AutoLayout';
 
// 注册自定义节点映射
const nodeTypes: Record<NodeTypeKey, any> = {
  userInput: UserInputNode,
  opalGenerate: GenerateNode,
  opalOutput: OutputNode,
};

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

const NODE_WIDTH = 300;

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};
 
export default function ChatGraph() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { setSelectedNode } = useEditorContext();

  const graphDOMRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<any>(null);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, [setSelectedNode]);

  const onConnect = useCallback(
    (params: any) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const doLayout = useCallback(async () => {
    if (!reactFlowRef.current) return;
    const rf = reactFlowRef.current;
    const result = await autoLayout(rf.getNodes(), rf.getEdges(), "RIGHT");
    setNodes(result.nodes);
    setEdges(result.edges);
    rf.fitView();
  }, [reactFlowRef]);

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
    const newNode: Node = {
      id: nodeId,
      type: type,
      position: position,
      data: {}
    };

    if (type === 'userInput') {
      newNode.data = {
        id: nodeId,
        type: "embed://a2/a2.bgl.json#module:user-inputs",
        metadata: {
          "title": "User Input"
        }
      };
    }
    else if (type === 'opalGenerate') {
      newNode.data = {
        id: nodeId,
        type: "embed://a2/generate.bgl.json#module:main",
        metadata: {
          "title": "Generate"
        }
      };
    }
    else if (type === 'opalOutput') {
      newNode.data = {
        id: nodeId,
        type: "embed://a2/a2.bgl.json#module:render-outputs",
        metadata: {
          "title": "Output"
        }
      };
    }

    setNodes((nds) => nds.concat(newNode));
  };

  const addNode = useCallback((type: string) => {
    if (!reactFlowRef.current) return;
    
    // 计算画布中间位置
    const canvasWidth = graphDOMRef.current?.clientWidth || 800;
    const canvasHeight = graphDOMRef.current?.clientHeight || 600;
    
    // 将屏幕中间位置转换为画布坐标
    const position = reactFlowRef.current.screenToFlowPosition({
      x: (canvasWidth / 2 - NODE_WIDTH / 2 + nodeRandomOffset()),
      y: (canvasHeight / 2 + nodeRandomOffset())
    });

    appendNewNode(type, position);
  }, [setNodes]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/reactflow/type');
    if (!type || !reactFlowRef.current) {
      return;
    }

    const position = reactFlowRef.current.screenToFlowPosition({
      x: (event.clientX - NODE_WIDTH / 2),
      y: (event.clientY - 20),
    });

    appendNewNode(type, position);
  }, [setNodes]);

  const onGraphChange = () => {
    // 监听图变化事件，获取当前图的节点和边数据，调用后台接口保存
  };

  useEffect(()=>{
    // 请求测试数据
    fetch('./generated_graph.json', {
      headers: {
        'Content-Type': 'application/json'
      }
    })
      .then(rsp => rsp.json())
      .then(data => {
        const graphNodes = data.nodes.map((node: NodeRawDataType): Node => {
          const newNode: Node = {
            id: node.id,
            type: 'opalGenerate',
            position: { x: node.metadata.visual?.x || 0, y: node.metadata.visual?.y || 0 },
            data: node
          };
          const nodeType = node.type || '';
          if (nodeType.includes('embed://a2/generate.bgl.json')) {
            newNode.type = 'opalGenerate';
          } 
          else if (nodeType.includes('module:render-outputs')) {
            newNode.type = 'opalOutput';
          }
          else if (nodeType.includes('module:user-inputs')) {
            newNode.type = 'userInput';
          }
          return newNode;
        });

        const graphEdges = data.edges.map((edge: any): Edge => {
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
          doLayout();
        }, 30);
      });
  }, []);

  return (
    <div className="absolute inset-0" style={{ backgroundColor: '#f8fafc', overflow: 'hidden' }} ref={graphDOMRef}>
      <div className="graph-nodes-panel">
          <div className="graph-nodes">
            <button data-node-type="userInput" draggable onDragStart={(e) => onDragStart(e, 'userInput')} onClick={() => addNode('userInput')}><MessageSquareText size={20} strokeWidth={1.5}/><span>User Input</span></button>
            <button data-node-type="opalGenerate" draggable onDragStart={(e) => onDragStart(e, 'opalGenerate')} onClick={() => addNode('opalGenerate')}><Sparkles size={20} strokeWidth={1.5}/><span>Generate</span></button>
            <button data-node-type="opalOutput" draggable onDragStart={(e) => onDragStart(e, 'opalOutput')} onClick={() => addNode('opalOutput')}><Proportions size={20} strokeWidth={1.5}/><span>Output</span></button>
            <div className="divider"></div>
            <button><SquarePlus size={20} strokeWidth={1.5}/><span>Add Assets</span></button>
            <div className="divider"></div>
            <button onClick={() => doLayout()}><LayoutDagIcon /><span>Layout</span></button>
          </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelectedNode(null)}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onInit={(instance) => reactFlowRef.current = instance}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        nodeDragThreshold={5}
        snapToGrid={true}
        snapGrid={[10, 10]}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        {/* 背景网格点 */}
        <Background color="#C5CBD3" gap={20} size={1} />
        <Controls />
      </ReactFlow>

      { nodes.length === 0 && (
      <div className="absolute inset-0 flex items-center justify-center graph-empty-state">
        <div className="empty-state-top">
          Add a step to get started.
        </div>
        <div>
          <h3>Let's build your app!</h3>
          <h4>Take a look at our <a href="#">demo video</a></h4>
        </div>
        <div className="empty-state-bottom">
          ... or type what your want to build
        </div>
      </div>)}

      <div className="graph-chatbox">
        <div className="graph-chatbox-input flex items-center">
          <textarea rows={1} placeholder="Describe what you want to build"></textarea>
          <button className="graph-chatbox-submit"><SendHorizontal size={24} strokeWidth={1.5} /></button>
        </div>
      </div>

    </div>
  );
}
