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

import '@xyflow/react/dist/style.css';
import './style.css';

import { LayoutDagIcon, Undo, Redo } from '@/components/icons';
import { useEditorContext } from '@/components/editor/EditorContext';
import { 
  UserInputNode, 
  GenerateNode, 
  OutputNode
} from './OpalNodes';
import { type NodeTypeKey, type NodeRawDataType } from './types';

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
// 边高亮样式：黑色、粗线
const edgeHighlightOptions = {
  style: {...defaultEdgeOptions.style, stroke: '#000000'},
  markerEnd: {...defaultEdgeOptions.markerEnd, color: '#000000'}
};


const NODE_WIDTH = 300;

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};
 
export default function ChatGraph() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { setSelectedNode } = useEditorContext();

  // Undo/Redo 状态
  const [history, setHistory] = useState<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const isPaused = useRef(false);
  const lastSavedNodesRef = useRef<string>('');
  const lastSavedEdgesRef = useRef<string>('');
    // 防抖函数，用于延迟保存历史记录（处理节点拖拽等连续变化）
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const nodesSnapshotRef = useRef<string>('');
  const edgesSnapshotRef = useRef<string>('');

  const graphDOMRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<any>(null);

  // 保存当前状态到历史记录
  const saveToHistory = useCallback((currentNodes?: Node[], currentEdges?: Edge[]) => {
    if (isPaused.current) return;
    
    const nodesToSave = currentNodes || nodes;
    const edgesToSave = currentEdges || edges;
    
    // 深拷贝以避免引用问题，并忽略临时的选中/高亮状态
    const normalizedNodes = nodesToSave.map(node => ({
      ...node,
      selected: false,
      style: undefined,
      zIndex: undefined
    }));
    const normalizedEdges = edgesToSave.map(edge => ({
      ...edge,
      selected: false,
      style: undefined,
      markerEnd: undefined,
      zIndex: undefined
    }));
    
    const nodesStr = JSON.stringify(normalizedNodes);
    const edgesStr = JSON.stringify(normalizedEdges);
    
    // 避免保存重复的状态
    if (nodesStr === lastSavedNodesRef.current && edgesStr === lastSavedEdgesRef.current) {
      return;
    }
    
    lastSavedNodesRef.current = nodesStr;
    lastSavedEdgesRef.current = edgesStr;
    
    setHistory(prevHistory => {
      const newHistory = prevHistory.slice(0, historyIndex + 1);
      newHistory.push({ 
        nodes: JSON.parse(nodesStr), 
        edges: JSON.parse(edgesStr) 
      });
      
      // 限制历史记录数量为 50
      if (newHistory.length > 50) {
        newHistory.shift();
        return newHistory;
      }
      return newHistory;
    });
    
    setHistoryIndex(prevIndex => {
      const newIndex = prevIndex + 1;
      return newIndex > 49 ? 49 : newIndex;
    });
  }, [nodes, edges, historyIndex]);

  // Undo 操作
  const undo = useCallback(() => {
    if (historyIndex > 0) {
      isPaused.current = true;
      const newIndex = historyIndex - 1;
      const historyItem = history[newIndex];
      
      if (historyItem) {
        setNodes(historyItem.nodes);
        setEdges(historyItem.edges);
        setHistoryIndex(newIndex);
        
        // 更新最后保存的引用
        lastSavedNodesRef.current = JSON.stringify(historyItem.nodes.map(n => ({
          ...n, selected: false, style: undefined, zIndex: undefined
        })));
        lastSavedEdgesRef.current = JSON.stringify(historyItem.edges.map(e => ({
          ...e, selected: false, style: undefined, markerEnd: undefined, zIndex: undefined
        })));
      }
      
      setTimeout(() => {
        isPaused.current = false;
      }, 50);
    }
  }, [historyIndex, history, setNodes, setEdges]);

  // Redo 操作
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      isPaused.current = true;
      const newIndex = historyIndex + 1;
      const historyItem = history[newIndex];
      
      if (historyItem) {
        setNodes(historyItem.nodes);
        setEdges(historyItem.edges);
        setHistoryIndex(newIndex);
        
        // 更新最后保存的引用
        lastSavedNodesRef.current = JSON.stringify(historyItem.nodes.map(n => ({
          ...n, selected: false, style: undefined, zIndex: undefined
        })));
        lastSavedEdgesRef.current = JSON.stringify(historyItem.edges.map(e => ({
          ...e, selected: false, style: undefined, markerEnd: undefined, zIndex: undefined
        })));
      }
      
      setTimeout(() => {
        isPaused.current = false;
      }, 50);
    }
  }, [historyIndex, history, setNodes, setEdges]);

  // 监听键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Z 或 Cmd+Z 用于 Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // Ctrl+Shift+Z 或 Cmd+Shift+Z 或 Ctrl+Y 用于 Redo
      if (((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey) || 
          ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
        e.preventDefault();
        redo();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [undo, redo]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    
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

   const onConnect = useCallback(
    (params: any) => {
      setEdges((eds) => {
        const newEdges = addEdge(params, eds);
        // 立即保存新状态
        setTimeout(() => saveToHistory(), 0);
        return newEdges;
      });
    },
    [setEdges, saveToHistory]
  );

  const doLayout = useCallback(async () => {
    if (!reactFlowRef.current) return;
    const rf = reactFlowRef.current;
    const result = await autoLayout(rf.getNodes(), rf.getEdges(), "RIGHT");
    setNodes(result.nodes);
    setEdges(result.edges);
    rf.fitView();
    setTimeout(() => saveToHistory(result.nodes, result.edges), 50);
  }, [reactFlowRef, saveToHistory]);

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow/type', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const appendNewNode = useCallback((type: string, position: { x: number, y: number }) => {
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

    if (type === 'userInput') {
      rawType = "embed://a2/a2.bgl.json#module:user-inputs";
      rawTitle = "User Input";
      configuration = {
        description: {
          role: "user",
          parts: [
            {
              text: ""
            }
          ]
        }
      };
    }
    else if (type === 'opalGenerate') {
      rawType = "embed://a2/generate.bgl.json#module:main";
      rawTitle = "Generate";
      configuration = {
        "config$prompt": {
          role: "user",
          parts: [
            {
              text: ""
            }
          ]
        },
        "generation-mode": "agent",
        "system-instruction": {
          role: "user",
          parts: [
            {
              text: ""
            }
          ]
        }
      };
    }
    else if (type === 'opalOutput') {
      rawType = "embed://a2/a2.bgl.json#module:render-outputs";
      rawTitle = "Output";
      configuration = {
        text: {
          parts: [
            {
              text: ""
            }
          ],
          role: "user"
        },
        "system-instruction": {
          role: "user",
          parts: [
            {
              text: ""
            }
          ]
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
      // 保存历史记录
      setTimeout(() => saveToHistory(newNodes), 0);
      return newNodes;
    });

  }, [setNodes, saveToHistory]);

  const addNode = useCallback((type: string) => {
    if (!reactFlowRef.current) return;
    
    // 计算画布中间位置
    const canvasWidth = graphDOMRef.current?.clientWidth || 800;
    const canvasHeight = graphDOMRef.current?.clientHeight || 600;
    
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

    appendNewNode(type, position);
  }, [appendNewNode]);

  const onGraphChange = () => {
    // 监听图变化事件，获取当前图的节点和边数据，调用后台接口保存
  };

  // 包装 onNodesChange 和 onEdgesChange，确保节点和边变化时保存历史记录
  const handleNodesChange = useCallback((changes: any) => {
    // 检查是否是删除操作
    const isDelete = changes.some((c: any) => c.type === 'remove');
    
    // 调用原始的 onNodesChange
    onNodesChange(changes);
    
    // 如果是删除操作，立即保存历史记录
    if (isDelete) {
      setTimeout(() => saveToHistory(), 0);
    }
  }, [onNodesChange, saveToHistory]);

  const handleEdgesChange = useCallback((changes: any) => {
    // 检查是否是删除操作
    const isDelete = changes.some((c: any) => c.type === 'remove');
    
    // 调用原始的 onEdgesChange
    onEdgesChange(changes);
    
    // 如果是删除操作，立即保存历史记录
    if (isDelete) {
      setTimeout(() => saveToHistory(), 0);
    }
  }, [onEdgesChange, saveToHistory]);
  
  // 监听节点和边的变化，自动保存历史记录
  useEffect(() => {
    if (historyIndex === -1) return; // 还没有初始化
    
    // 为节点和边创建快照，忽略临时状态
    const currentNodesSnapshot = JSON.stringify(nodes.map(n => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data
    })));
    
    const currentEdgesSnapshot = JSON.stringify(edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target
    })));
    
    // 检查是否有实质性变化
    const hasChanges = currentNodesSnapshot !== nodesSnapshotRef.current || 
                      currentEdgesSnapshot !== edgesSnapshotRef.current;
    
    if (!hasChanges) return;
    
    // 更新快照
    nodesSnapshotRef.current = currentNodesSnapshot;
    edgesSnapshotRef.current = currentEdgesSnapshot;
    
    // 如果是暂停状态，不保存历史记录
    if (isPaused.current) return;
    
    // 清除之前的定时器
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    
    // 设置新的防抖定时器
    debounceTimer.current = setTimeout(() => {
      saveToHistory();
    }, 300);
    
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [nodes, edges, historyIndex, saveToHistory]);

  // test fetch data demo
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
          // 布局完成后，将初始状态保存到历史记录
          setTimeout(() => {
            isPaused.current = true;
            saveToHistory(graphNodes, graphEdges);
            setTimeout(() => {
              isPaused.current = false;
            }, 50);
          }, 100);
        }, 30);
      });
  }, []);

  return (
    <div className="absolute inset-0" style={{ backgroundColor: '#f8fafc', overflow: 'hidden' }} ref={graphDOMRef}>
      <div className="graph-nodes-panel">
          <div className="graph-nodes">
            {/*<div className="flex undo-redo">
              <button onClick={undo} disabled={historyIndex <= 0}><Undo2 size={20} strokeWidth={1.5}/></button>
              <button onClick={redo} disabled={historyIndex >= history.length - 1}><Redo2 size={20} strokeWidth={1.5}/></button>
            </div>
            <div className="divider"></div>
            */}
            <button data-node-type="userInput" draggable onDragStart={(e) => onDragStart(e, 'userInput')} onClick={() => addNode('userInput')}><MessageSquareText size={20} strokeWidth={1.5}/><span>User Input</span></button>
            <button data-node-type="opalGenerate" draggable onDragStart={(e) => onDragStart(e, 'opalGenerate')} onClick={() => addNode('opalGenerate')}><Sparkles size={20} strokeWidth={1.5}/><span>Generate</span></button>
            <button data-node-type="opalOutput" draggable onDragStart={(e) => onDragStart(e, 'opalOutput')} onClick={() => addNode('opalOutput')}><Proportions size={20} strokeWidth={1.5}/><span>Output</span></button>
            <div className="divider"></div>
            <button><SquarePlus size={20} strokeWidth={1.5}/><span>Add Assets</span></button>
            {/*<div className="divider"></div>
            <button onClick={() => doLayout()}><LayoutDagIcon /><span>Layout</span></button>
            */}
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
        <Controls position="bottom-right">
          <ControlButton onClick={() => doLayout()} title="自动布局"><LayoutDagIcon /></ControlButton>
          <ControlButton onClick={undo} disabled={historyIndex <= 0} title="撤销"><Undo /></ControlButton>
          <ControlButton onClick={redo} disabled={historyIndex >= history.length - 1} title="重做"><Redo /></ControlButton>
        </Controls>
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
