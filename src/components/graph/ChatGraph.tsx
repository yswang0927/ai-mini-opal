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
  getBezierPath,
  type ConnectionLineComponentProps,
  type OnConnectStartParams,
  type Node,
  type Edge,
  type Connection,
} from '@xyflow/react';

import {
  Sparkles,
  Proportions,
  MessageSquareText,
  SquarePlus,
  ArrowUp,
  Undo2,
  Redo2
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { 
  PopoverNext, 
  Menu, 
  MenuItem, 
} from "@blueprintjs/core";

import type { OpalJson, OpalNode, OpalEdge } from '@/types';
import { OpalNodeType } from '@/types';
import { SERVER_BASE_URL } from "@/utils/Api";
import { useL10n } from "@/l10n";
import DotsSpinner from '@/components/DotsSpinner';
import TextArea from '@/components/TextArea';
import { LayoutDagIcon, Undo, Redo, Spinner } from '@/utils/icons';
import { useEditorContext } from '@/pages/editor/EditorContext';

import { UserInputNode, GenerateNode, OutputNode, AssetsTextNode, AssetsFileNode } from './OpalNodes';
import { type FlowNode } from './types';
import autoLayout from './AutoLayout';
import {NodezatorConnectionLine, __NODEZATOR_ACTIVE_SNAP_TARGET__} from "./NodezatorConnectionLine";

import '@xyflow/react/dist/style.css';
import './style.css';


// 注册自定义节点映射
const customNodeTypes: Record<OpalNodeType, any> = {
  [OpalNodeType.UserInputs]: UserInputNode,
  [OpalNodeType.AgentGenerate]: GenerateNode,
  [OpalNodeType.RenderOutputs]: OutputNode,
  [OpalNodeType.AssetsText]: AssetsTextNode,
  [OpalNodeType.AssetsFile]: AssetsFileNode,
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
// 边执行完成样式：绿色实线(去掉虚线),表示该条数据流已产出
const edgeCompletedOptions = {
  animated: false,
  style: {
    ...defaultEdgeOptions.style,
    stroke: '#16a34a',
    strokeDasharray: undefined,
  },
  markerEnd: {...defaultEdgeOptions.markerEnd, color: '#16a34a'},
};

// 自定义连接线组件
const CustomConnectionLine: React.FC<ConnectionLineComponentProps> = ({
  fromX, fromY, fromPosition, toX, toY, toPosition,
}) => {
  // 实时计算贝塞尔曲线路径
  const [edgePath] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  });

  const ORANGE_COLOR = '#F97316'; // 橘黄色 (Tailwind orange-500)

  return (
    <g>
      {/* 1. 橘黄色连接线 */}
      <path fill="none" stroke={ORANGE_COLOR} strokeWidth={2} d={edgePath} />

      {/* 2. 起点实心小圆点 */}
      <circle cx={fromX} cy={fromY} fill={ORANGE_COLOR} r={5} />

      {/* 3. 终点实心小圆点（紧随鼠标指针） */}
      <circle cx={toX} cy={toY} fill={ORANGE_COLOR} r={5} />
    </g>
  );
};

const NODE_WIDTH = 300;

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};

interface ChatGraphProps {
  graphId?: string;
}

export default function ChatGraph({ graphId }: ChatGraphProps) {
  const { t } = useL10n();
  const graphDomRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<any>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // 用一个极其稳定的 Ref 缓存当前的连线起点数据
  const connectingSourceRef = useRef<{ nodeId: string; handleId: string | null } | null>(null);
  const isGraphInitializedRef = useRef<boolean>(false);
  const [chatInput, setChatInput] = useState<string>('');
  const [chatting, setChatting] = useState<boolean>(false);
  const [chatHistory, setChatHistory] = useState<Array<{role: string, content: string}>>([]);
  const chatListDomRef = useRef(null);
  const [chatListCollapsed, setChatListCollapsed] = useState<boolean>(true);
  const { setSelectedNode, opalPayload, setOpalData, execState } = useEditorContext();

  const opalData = opalPayload.data;

  const onGraphChanged = useCallback((nextNodes?: Node[], nextEdges?: Edge[]) => {
    const rf = reactFlowRef.current;
    if (!opalData || !rf) return;

    // 如果传入了最新的节点/边，就用传入的；否则从实例里拉取
    const currentNodes = nextNodes || rf.getNodes();
    const currentEdges = nextEdges || rf.getEdges();

    const opalNodes: OpalNode[] = currentNodes.map((fNode: any): OpalNode => {
      const position = fNode.position;
      const rawData = { ...(fNode.data as OpalNode) };
      if (rawData.metadata) {
        rawData.metadata = {
          ...rawData.metadata,
          visual: { x: Math.round(position.x), y: Math.round(position.y) }
        };
      }
      return rawData;
    });

    const opalEdges: OpalEdge[] = currentEdges.map((edge: Edge): OpalEdge => {
      const from = edge.source;
      const to = edge.target;
      const data = (edge.data || {}) as { out?: string; in?: string };
      // 保留边原始的 out/in(加载时存入 edge.data),避免编辑保存后被清空。
      // 本编辑器的连线都是数据/依赖边,规范形式为 out="context"、in="p-z-<from>";
      // 新建连线或历史遗留的空值都归一化为该默认值。
      const outVal = (data.out || '').trim();
      const inVal = (data.in || '').trim();
      return {
        from,
        to,
        out: outVal || 'context',
        in: inVal || `p-z-${from}`
      };
    });

    setOpalData({ ...opalData, nodes: opalNodes, edges: opalEdges }, true);
  }, [opalData, setOpalData]);

  const doLayout = useCallback(async () => {
    if (!reactFlowRef.current) return;
    const rf = reactFlowRef.current;
    const result = await autoLayout(rf.getNodes(), rf.getEdges(), "RIGHT");
    rf.setNodes(result.nodes);
    rf.setEdges(result.edges);
    rf.fitView();

    onGraphChanged(result.nodes, result.edges);
  }, [onGraphChanged]);

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

    setChatListCollapsed(true);
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

    setChatListCollapsed(true);

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

  const onConnect = useCallback((conn: Connection) => {
    setEdges((eds) => {
      const newEdges = addEdge(conn, eds);
      // 拿到了绝对最新的连线数据 newEdges，以及当前的 nodes
      onGraphChanged(nodes, newEdges);
      return newEdges;
    });
  }, [setEdges, nodes, onGraphChanged]);

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
      // 在这里，拿到了绝对最新的 newNodes，以及当前的 edges
      onGraphChanged(newNodes, edges);
      return newNodes;
    });

  }, [setNodes, edges, onGraphChanged]);

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

  const onNodeDragStop = useCallback(() => {
    onGraphChanged();
  }, [onGraphChanged]);

  const onDelete = useCallback(() => {
    setTimeout(() => {
      onGraphChanged();
    }, 10);
  }, [onGraphChanged]);

  // 包装 onNodesChange 和 onEdgesChange，确保节点和边变化时保存历史记录
  const handleNodesChange = useCallback((changes: any) => {
    // 调用原始的 onNodesChange
    onNodesChange(changes);
  }, [onNodesChange]);

  const handleEdgesChange = useCallback((changes: any) => {
    // 调用原始的 onEdgesChange
    onEdgesChange(changes);
  }, [onEdgesChange]);

  // 1. 当用户刚从某个 Handle 按住鼠标往外拉线时触发
  const handleConnectStart = useCallback((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    const targetElement = event.target as HTMLElement;
    if (!targetElement) return;

    const nodeId = targetElement.getAttribute('data-nodeid') || '';
    const handleId = targetElement.getAttribute('data-id') || targetElement.getAttribute('id') || '';
    if (nodeId) {
      connectingSourceRef.current = {
        nodeId: nodeId,
        handleId: handleId
      };
    }
  }, []);

  // 2. 精准接管 React Flow 连线生命周期终点事件
  const handleConnectEnd = useCallback((_event: MouseEvent | TouchEvent) => {
    const snapTarget = __NODEZATOR_ACTIVE_SNAP_TARGET__;
    const source = connectingSourceRef.current;

    // 如果松手的一瞬间，小手处于相撞变橘黄状态，且我们记录到了源头
    if (snapTarget && source && source.nodeId) {
      setEdges((eds) => {
        return addEdge(
          {
            source: source.nodeId,
            sourceHandle: null,
            target: snapTarget.nodeId,
            targetHandle: null
          },
          eds
        );
      });

      // 顺滑存盘，绕过 React Flow 的批处理延迟
      setTimeout(() => {
        onGraphChanged();
      }, 30);
    }

    // 无论连线成功与否，落幕时彻底清空起点缓存，防止污染下次连线
    connectingSourceRef.current = null;
  }, [setEdges, onGraphChanged]);

  // 传入的 graphData 上图
  useEffect(() => {
    // silent = true 表示画布内部操作引发的修改，不需要重新 setNodes
    // 但组件首次挂载时必须初始化，无论 silent 状态
    if (opalPayload.silent && isGraphInitializedRef.current) {
      return;
    }

    console.log('>>> init graph data', opalData);
    if (!opalData) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const flowNodes = (opalData.nodes || []).map((gNode: OpalNode): FlowNode => {
      const newNode: FlowNode = {
        id: gNode.id,
        type: gNode.type,
        position: {x: gNode.metadata.visual?.x || 0, y: gNode.metadata.visual?.y || 0},
        data: gNode
      };
      return newNode;
    });

    const flowEdges = (opalData.edges || []).map((edge: any): Edge => {
      return {
        id: edge.id || `${edge.from}-${edge.to}`,
        source: edge.from || edge.source,
        target: edge.to || edge.target,
        // 保留 out/in 语义,供保存时(onGraphChanged)回写,避免往返丢失。
        data: { out: edge.out, in: edge.in }
      };
    });

    setNodes(flowNodes);
    setEdges(flowEdges);

    // 首次初始化(此前 isGraphInitializedRef 尚为 false)才触发自动布局
    const isFirstInit = !isGraphInitializedRef.current;
    isGraphInitializedRef.current = true;

    // 加载完成后调用 fitView
    let layoutTimer = null;
    if (isFirstInit && flowNodes.length > 0) {
      layoutTimer = setTimeout(() => {
        doLayout();
      }, 30);
    }

    return () => {
      if (layoutTimer) clearTimeout(layoutTimer);
    };

  }, [opalPayload, setNodes, setEdges]);

  const handleChatSubmit = () => {
    const userInput = chatInput.trim();
    if (chatting || userInput === '') {
      return;
    }

    setChatListCollapsed(false);
    setChatting(true);
    setChatInput('');
    setChatHistory((prev) => [...prev, { role: 'user', content: userInput }]);

    fetch(`${SERVER_BASE_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        session_id: graphId, 
        message: userInput,
        graphData: opalData 
      })
    })
      .then(response => response.json())
      .then(jsonData => {
        // {session_id:string, reply:string, graph:OpalJson}
        console.log('Chat response:', jsonData);
        setChatInput('');
        setChatting(false);
        if (jsonData.code === 0) {
          const rawData = jsonData.data;
          setOpalData(rawData.graph);
          setChatHistory((prev) => [...prev, {role: 'assistant', content: rawData.reply}]);
        } else {
          setChatHistory((prev) => [...prev, {role: 'error', content: jsonData.message}]);
        }
      })
      .catch(error => {
        setChatting(false);
        setChatInput(userInput);
        console.error('Error during chat request:', error);
      });
  };

  useEffect(() => {
    if (chatListDomRef.current) {
      const chatListDiv = chatListDomRef.current as HTMLDivElement;
      setTimeout(() => {
        chatListDiv.scrollTop = chatListDiv.scrollHeight;
      }, 100);
    }
  }, [chatHistory]);

  useEffect(() => {
    // 监听节点的执行状态, 将已完成节点的前置边都变为实线
    // 如果状态发生重置, 则重置所有边的样式为默认样式
    const statuses = execState.nodeStatuses;

    // idle/ready 视为「未执行/已重置」:所有边恢复默认虚线样式
    if (execState.status === 'idle' || execState.status === 'ready' || Object.keys(statuses).length === 0) {
      setEdges((prevEdges) =>
        prevEdges.map((edge) => ({
          ...edge,
          animated: false,
          style: defaultEdgeOptions.style,
          markerEnd: defaultEdgeOptions.markerEnd,
        }))
      );
      return;
    }

    // 边的「后继节点」(target)已完成 => 该条前置边变实线;否则维持默认样式
    setEdges((prevEdges) =>
      prevEdges.map((edge) => {
        const done = statuses[edge.target] === 'completed';
        return {
          ...edge,
          animated: edgeCompletedOptions.animated,
          style: done ? edgeCompletedOptions.style : defaultEdgeOptions.style,
          markerEnd: done ? edgeCompletedOptions.markerEnd : defaultEdgeOptions.markerEnd,
        };
      })
    );
  }, [execState, setEdges]);

  return (
      <div className="absolute inset-0"
        style={{ overflow: 'hidden' }}
        ref={graphDomRef}
        onMouseDown={() => setChatListCollapsed(true)}
      >
        <div className="graph-nodes-panel">
          <div className="graph-nodes">
            <button data-nodetype={OpalNodeType.UserInputs} draggable onDragStart={(e) => onDragStart(e, OpalNodeType.UserInputs)} onClick={() => addNode(OpalNodeType.UserInputs)}><span className="btn-icon"><MessageSquareText size={20} strokeWidth={1.5}/></span><span>{t('用户输入')}</span></button>
            <button data-nodetype={OpalNodeType.AgentGenerate} draggable onDragStart={(e) => onDragStart(e, OpalNodeType.AgentGenerate)} onClick={() => addNode(OpalNodeType.AgentGenerate)}><span className="btn-icon"><Sparkles size={20} strokeWidth={1.5}/></span><span>{t('AI生成')}</span></button>
            <button data-nodetype={OpalNodeType.RenderOutputs} draggable onDragStart={(e) => onDragStart(e, OpalNodeType.RenderOutputs)} onClick={() => addNode(OpalNodeType.RenderOutputs)}><span className="btn-icon"><Proportions size={20} strokeWidth={1.5}/></span><span>{t('输出')}</span></button>
            {/*<div className="divider"></div>
            <PopoverNext placement="bottom-start" arrow={false}
              content={
                <Menu>
                  <MenuItem icon="export" text={t('上传文件')} />
                  <MenuItem icon="label" text={t('文本内容')} />
                </Menu>
              }
            >
              <button><span className="btn-icon"><SquarePlus size={20} strokeWidth={1.5}/></span><span>{t('添加资产')}</span></button>
            </PopoverNext>
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
          onConnectStart={handleConnectStart}
          onConnectEnd={handleConnectEnd}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onNodeDragStop={onNodeDragStop}
          onDelete={onDelete}
          onInit={(instance) => reactFlowRef.current = instance }
          nodeTypes={customNodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          connectionLineComponent={NodezatorConnectionLine}
          nodeDragThreshold={5}
          connectionRadius={40}
          snapToGrid={true}
          snapGrid={[10, 10]}
          autoPanOnNodeFocus={true}
          minZoom={0.1}
          deleteKeyCode={['Backspace', 'Delete']}
          fitView
        >
          {/* 背景网格点 */}
          <Background bgColor="var(--color-bg-primary)" color="var(--color-bg-tertiary)" gap={20} size={1} />
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
              {/*<h4>{t('查看我们的')} <a href="#">{t('演示视频')}</a></h4>*/}
            </div>
            <div className="empty-state-bottom">
              ... <span>{t('或输入你想构建的内容')}</span>
            </div>
          </div>
        )}

        <div className="graph-chatbox" onMouseDown={(e)=>e.stopPropagation()}>
          <div className={`graph-chat-messages ${chatListCollapsed?'':'expanded'} ${chatHistory.length > 0 ? 'has-msgs' : ''}`}>
            <div className="graph-chat-msg-toggle" onMouseOver={() => setChatListCollapsed(false)}></div>
            <div className="graph-chat-msg-list" ref={chatListDomRef}>
              {chatHistory.map((msg, index) => (
                  <div key={index} className={`graph-chat-msg ${msg.role}`}>
                    <div className="graph-chat-msg-content">
                      { (msg.role === 'user' ||  msg.role === 'error')
                          ? <span style={{whiteSpace:'pre-wrap'}}>{msg.content}</span>
                          : <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                      }
                    </div>
                  </div>
              ))}

              {chatting && (
                <div className="graph-chat-msg assistant thinking">
                  <div className="graph-chat-msg-content">{t('生成中')}<DotsSpinner/></div>
                </div>
              )}
            </div>
          </div>

          <div className="graph-chatbox-input flex items-center">
            <TextArea rows={1} autoHeight={true} maxHeight={200}
              placeholder={nodes.length === 0 ? t('描述你想构建的内容') : t('可以编辑这些步骤')}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault();
                  handleChatSubmit();
                }
              }}
            />
            <button type="button" className="graph-chatbox-submit" 
              onClick={handleChatSubmit} 
              disabled={(chatting || chatInput.trim() === '')} 
              title={t("发送消息") + ' Ctrl+Enter'}
            >
              {chatting ? <span className="chatting-spinner"><Spinner /></span> : <ArrowUp size={20} strokeWidth={1.5} />}
            </button>
          </div>

        </div>

      </div>
  );
}
