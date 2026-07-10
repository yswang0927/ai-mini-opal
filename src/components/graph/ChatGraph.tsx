import React, { useEffect, useCallback, useRef, useState } from 'react';
import { 
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  ConnectionLineType,
  MarkerType,
  Controls,
  ControlButton,
  type Node,
  type Edge,
} from '@xyflow/react';

import { 
  Sparkles, 
  Proportions, 
  MessageSquareText, 
  SquarePlus, 
  SendHorizontal,
  Undo2,
  Redo2
} from 'lucide-react';

import type { OpalJson, OpalNode, OpalEdge } from '@/types';
import { OpalNodeType } from '@/types';
import { useL10n } from "@/l10n";
import { LayoutDagIcon, Undo, Redo } from '@/utils/icons';
import { useEditorContext } from '@/pages/editor/EditorContext';

import { UserInputNode, GenerateNode, OutputNode } from './OpalNodes';
import { type FlowNode } from './types';
import autoLayout from './AutoLayout';

import '@xyflow/react/dist/style.css';
import './style.css';


// 注册自定义节点映射
const customNodeTypes: Record<OpalNodeType, any> = {
  [OpalNodeType.UserInputs]: UserInputNode,
  [OpalNodeType.AgentGenerate]: GenerateNode,
  [OpalNodeType.RenderOutputs]: OutputNode,
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
    type: MarkerType.ArrowClosed,
    width: 16, 
    height: 16, 
    color: '#C5CBD3',  
  },
};
// 边高亮样式：黑色、粗线
const edgeHighlightOptions = {
  style: {...defaultEdgeOptions.style, stroke: '#000000'},
  markerEnd: {...defaultEdgeOptions.markerEnd, color: '#000000'}
};

const NODE_WIDTH = 300;

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};

interface ChatGraphProps {
  graphData?: OpalJson;
  onGraphChange?: (data: OpalJson) => void;
}

export default function ChatGraph({ graphData, onGraphChange }: ChatGraphProps) {
  const { t } = useL10n();
  const graphDomRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<any>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { setSelectedNode, execState } = useEditorContext();
  

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data || null);
    
    // 高亮与该节点相关的边
    setEdges((prevEdges) => 
      prevEdges.map((edge) => {
        // 检查边是否与该节点相关
        const isRelated = edge.source === node.id || edge.target === node.id;
        if (isRelated) {
          return {
            ...edge,
            zIndex: 10,
            style: edgeHighlightOptions.style,
            markerEnd: edgeHighlightOptions.markerEnd
          };
        }
        
        // 其他边恢复默认样式
        return {
          ...edge,
          zIndex: 0,
          selected: false,
          style: defaultEdgeOptions.style,
          markerEnd: defaultEdgeOptions.markerEnd
        };
      })
    );
  }, [setSelectedNode, setEdges]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    // 恢复所有边的默认样式
    setEdges((prevEdges) => 
      prevEdges.map((edge) => ({
        ...edge,
        zIndex: 0,
        selected: false,
        style: defaultEdgeOptions.style,
        markerEnd: defaultEdgeOptions.markerEnd
      }))
    );
  }, [setSelectedNode, setEdges]);

  const onEdgeClick = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.stopPropagation();
    // 切换边的选中状态并更新样式
    setEdges((prevEdges) => 
      prevEdges.map((e) => {
        if (e.id === edge.id) {
          return {
            ...e,
            selected: true,
            zIndex: 10,
            style: edgeHighlightOptions.style,
            markerEnd: edgeHighlightOptions.markerEnd
          };
        }
        return {
          ...e,
          selected: false,
          zIndex: 0,
          style: defaultEdgeOptions.style,
          markerEnd: defaultEdgeOptions.markerEnd
        };
      })
    );
  }, [setEdges]);

  const onConnect = useCallback((params: any) => {
      setEdges((eds) => {
        const newEdges = addEdge(params, eds);
        return newEdges;
      });
    },
    [setEdges]
  );

  const doLayout = useCallback(async () => {
    if (!reactFlowRef.current) {
      return;
    }
    const rf = reactFlowRef.current;
    const result = await autoLayout(rf.getNodes(), rf.getEdges(), "RIGHT");
    setNodes(result.nodes);
    setEdges(result.edges);
    rf.fitView();
  }, [setNodes, setEdges]);

  const appendNewNode = useCallback((type: OpalNodeType, position: { x: number, y: number }) => {
    const nodeId = `${type}-${Date.now()}`;
    const newNode: Node = {
      id: nodeId,
      type: type,
      position: position,
      data: {}
    };
    
    let rawType = '';
    let rawTitle = '';
    let configuration = {};

    if (type === OpalNodeType.UserInputs) {
      rawType = OpalNodeType.UserInputs;
      rawTitle = t("用户输入");
      configuration = {
        description: {
          role: "user",
          content: ""
        }
      };
    }
    else if (type === OpalNodeType.AgentGenerate) {
      rawType = OpalNodeType.AgentGenerate;
      rawTitle = t("AI生成");
      configuration = {
        "config$prompt": {
          role: "user",
          content: ""
        },
        "generation-mode": "agent",
        "system-instruction": {
          role: "user",
          content: ""
        }
      };
    }
    else if (type === OpalNodeType.RenderOutputs) {
      rawType = OpalNodeType.RenderOutputs;
      rawTitle = t("输出");
      configuration = {
        text: {
          content: "",
          role: "user"
        },
        "system-instruction": {
          role: "user",
          content: ""
        }
      };
    }

    newNode.data = {
      id: nodeId,
      type: rawType,
      metadata: {
        title: rawTitle,
        visual: {
          x: position.x,
          y: position.y
        }
      },
      configuration: configuration
    };

    setNodes((nds) => {
      const newNodes = [...nds, newNode];
      return newNodes;
    });

  }, [setNodes]);

  const addNode = useCallback((type: OpalNodeType) => {
    if (!reactFlowRef.current) return;
    
    // 计算画布中间位置
    const canvasWidth = graphDomRef.current?.clientWidth || 800;
    const canvasHeight = graphDomRef.current?.clientHeight || 600;
    
    // 先转换为画布坐标
    const centerPosition = reactFlowRef.current.screenToFlowPosition({
      x: canvasWidth / 2,
      y: canvasHeight / 2
    });
    
    // 然后在画布坐标上应用偏移量
    const position = {
      x: centerPosition.x - NODE_WIDTH / 2 + nodeRandomOffset(),
      y: centerPosition.y + nodeRandomOffset()
    };

    appendNewNode(type, position);
  }, [appendNewNode]);


  const onDragStart = (event: React.DragEvent, nodeType: OpalNodeType) => {
    event.dataTransfer.setData('application/reactflow/type', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/reactflow/type');
    if (!type || !reactFlowRef.current) {
      return;
    }

    // 先转换为画布坐标，然后再调整偏移量
    const flowPosition = reactFlowRef.current.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    
    // 在画布坐标上应用偏移量
    const position = {
      x: flowPosition.x - NODE_WIDTH / 2,
      y: flowPosition.y - 20
    };

    appendNewNode(type as OpalNodeType, position);
  }, [appendNewNode]);

  // 包装 onNodesChange 和 onEdgesChange，确保节点和边变化时保存历史记录
  const handleNodesChange = useCallback((changes: any) => {
    // 调用原始的 onNodesChange
    onNodesChange(changes);
  }, [onNodesChange]);

  const handleEdgesChange = useCallback((changes: any) => {
    // 调用原始的 onEdgesChange
    onEdgesChange(changes);
  }, [onEdgesChange]);

  // 传入的 graphData 上图
  useEffect(() => {
    console.log('>>> init graph data', graphData);
    if (graphData) {
      const flowNodes = (graphData.nodes || []).map((gNode: OpalNode): FlowNode => {
        const newNode: FlowNode = {
          id: gNode.id,
          type: gNode.type,
          position: { x: gNode.metadata.visual?.x || 0, y: gNode.metadata.visual?.y || 0 },
          data: gNode
        };
        return newNode;
      });

      const flowEdges = (graphData.edges || []).map((edge: any): Edge => {
        return {
          id: edge.id || `${edge.from}-${edge.to}`,
          source: edge.from || edge.source,
          target: edge.to || edge.target
        };
      });

      setNodes(flowNodes);
      setEdges(flowEdges);

      // 加载完成后调用 fitView
      if (flowNodes.length > 0) {
        setTimeout(() => {
          doLayout();
        }, 30);
      }
    }
  }, [graphData, setNodes, setEdges, doLayout]);

  // 监听图的变化, 回调自动保存
  useEffect(() => {
    if (onGraphChange) {
      const opalNodes: OpalNode[] = nodes.map((fNode): OpalNode => {
        const position = fNode.position;
        const rawData = fNode.data as OpalNode;
        if (rawData.metadata) {
          rawData.metadata.visual = {
            x: position.x,
            y: position.y
          };
        }
        return rawData;
      });
      
      const opalEdges: OpalEdge[] = edges.map((edge): OpalEdge => {
        return {
          from: edge.source,
          to: edge.target,
          out: '',
          in: ''
        };
      });
      
      if (graphData) {
        graphData.nodes = opalNodes;
        graphData.edges = opalEdges;
        onGraphChange(graphData);
      } else {
        onGraphChange({
          title: '',
          description: '',
          nodes: opalNodes,
          edges: opalEdges
        });
      }
    }
  }, [nodes, edges, onGraphChange]);

  return (
    <div className="absolute inset-0" style={{ backgroundColor: '#f8fafc', overflow: 'hidden' }} ref={graphDomRef}>
      <div className="graph-nodes-panel">
          <div className="graph-nodes">
            <button data-nodetype={OpalNodeType.UserInputs} draggable onDragStart={(e) => onDragStart(e, OpalNodeType.UserInputs)} onClick={() => addNode(OpalNodeType.UserInputs)}><MessageSquareText size={20} strokeWidth={1.5}/><span>{t('用户输入')}</span></button>
            <button data-nodetype={OpalNodeType.AgentGenerate} draggable onDragStart={(e) => onDragStart(e, OpalNodeType.AgentGenerate)} onClick={() => addNode(OpalNodeType.AgentGenerate)}><Sparkles size={20} strokeWidth={1.5}/><span>{t('AI生成')}</span></button>
            <button data-nodetype={OpalNodeType.RenderOutputs} draggable onDragStart={(e) => onDragStart(e, OpalNodeType.RenderOutputs)} onClick={() => addNode(OpalNodeType.RenderOutputs)}><Proportions size={20} strokeWidth={1.5}/><span>{t('AI输出')}</span></button>
            <div className="divider"></div>
            <button><SquarePlus size={20} strokeWidth={1.5}/><span>{t('添加资产')}</span></button>
          </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onInit={(instance) => reactFlowRef.current = instance}
        nodeTypes={customNodeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        nodeDragThreshold={5}
        snapToGrid={true}
        snapGrid={[10, 10]}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        {/* 背景网格点 */}
        <Background color="#C5CBD3" gap={20} size={1} />
        <Controls position="bottom-right">
          <ControlButton onClick={() => doLayout()} title={t('自动布局')}><LayoutDagIcon /></ControlButton>
        </Controls>
      </ReactFlow>

      { nodes.length === 0 && (
      <div className="absolute inset-0 flex items-center justify-center graph-empty-state">
        <div className="empty-state-top">
          {t('添加一个步骤开始')}
        </div>
        <div>
          <h3>{t('构建你的应用')}</h3>
          <h4>{t('查看我们的')} <a href="#">{t('演示视频')}</a></h4>
        </div>
        <div className="empty-state-bottom">
          ... <span>{t('或输入你想构建的内容')}</span>
        </div>
      </div>)}

      <div className="graph-chatbox">
        <div className="graph-chatbox-input flex items-center">
          <textarea rows={1} placeholder={t('描述你想构建的内容')}></textarea>
          <button className="graph-chatbox-submit"><SendHorizontal size={24} strokeWidth={1.5} /></button>
        </div>
      </div>

    </div>
  );
}
