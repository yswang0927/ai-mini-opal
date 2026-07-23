import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  addEdge,
  Background,
  type Connection,
  type ConnectionLineComponentProps,
  ConnectionLineType,
  ControlButton,
  Controls,
  type Edge,
  getBezierPath,
  MarkerType,
  type Node,
  type OnConnectStartParams,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';

import {ArrowUp, CircleQuestionMark, MessageSquareText, Proportions, Sparkles, SquarePlus} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Card, Classes, Menu, MenuItem, Overlay2, PopoverNext} from "@blueprintjs/core";

import {type OpalEdge, type OpalNode, OpalNodeRefType, OpalNodeType} from '@/types';
import {SERVER_BASE_URL} from "@/utils/Api";
import {uuid, debounce} from "@/utils";
import {useL10n} from "@/l10n";
import DotsSpinner from '@/components/DotsSpinner';
import TextArea from '@/components/TextArea';
import {LayoutDagIcon, Spinner} from '@/utils/icons';
import {useEditorContext} from '@/pages/editor/EditorContext';

import {AssetsFileNode, AssetsTextNode, GenerateNode, OutputNode, UserInputNode} from './OpalNodes';
import {type FlowNode, type NodeHandleType} from './types';
import autoLayout from './AutoLayout';
import {__NODEZATOR_ACTIVE_SNAP_TARGET__, NodezatorConnectionLine} from "./NodezatorConnectionLine";

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
const CHANGE_DELAY = 100;
const FIT_VIEW_OPTIONS = {duration: 260, padding: 0.2};

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};

const isEdgeExists = (edge: Edge, eds: Edge[]) => {
  if (edge === null) {
    return true;
  }
  if (eds === null || eds.length === 0) {
    return false;
  }
  return !!eds.find((e: Edge)=> (e.source === edge.source && e.target === edge.target));
};

interface ChatGraphProps {
  graphId?: string;
}

export default function ChatGraph({ graphId }: ChatGraphProps) {
  const { t } = useL10n();
  const graphDomRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<any>(null);
  const emptyStateDomRef = useRef<HTMLDivElement|null>(null);
  const resizeIframeRef = useRef<HTMLIFrameElement|null>(null);

  const [inDragDropMode, setInDragDropMode] = useState<boolean>(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // 用 Ref 缓存当前的连线起点数据
  const connectingSourceRef = useRef<NodeHandleType | null>(null);
  const isGraphInitializedRef = useRef<boolean>(false);

  const [chatInput, setChatInput] = useState<string>('');
  const [chatting, setChatting] = useState<boolean>(false);
  const [chatHistory, setChatHistory] = useState<Array<{role: string, content: string}>>([]);
  const chatListDomRef = useRef(null);
  const [chatListCollapsed, setChatListCollapsed] = useState<boolean>(true);
  const [showHelp, setShowHelp] = useState<boolean>(false);

  const { setSelectedNode, opalPayload, setOpalData, execState } = useEditorContext();

  const opalData = opalPayload.data;

  const onGraphChanged = useCallback((nextNodes?: Node[], nextEdges?: Edge[]) => {
    const rf = reactFlowRef.current;
    if (!opalData || !rf) return;

    // 如果传入了最新的节点/边，就用传入的；否则从实例里拉取
    const currentNodes:Node[] = nextNodes || rf.getNodes();
    const currentEdges:Edge[] = nextEdges || rf.getEdges();

    const normalNodeTypes = new Set<string>([OpalNodeType.UserInputs, OpalNodeType.AgentGenerate, OpalNodeType.RenderOutputs]);
    const assetsNodeTypes = new Set<string>([OpalNodeType.AssetsText, OpalNodeType.AssetsFile]);

    const normalNodes:Node[] = currentNodes.filter((item:Node) => normalNodeTypes.has(item.type || ""));
    const assetNodes = new Map(currentNodes.filter((item:Node) => assetsNodeTypes.has(item.type || "")).map((aNode: Node) => [aNode.id, aNode.data]));
    const normalEdges:Edge[] = currentEdges.filter((edge: Edge) => !assetNodes.has(edge.source));

    const opalNodes: OpalNode[] = normalNodes.map((fNode: Node): OpalNode => {
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

    const opalEdges: OpalEdge[] = normalEdges.map((edge: Edge): OpalEdge => {
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

    setOpalData({ ...opalData, nodes: opalNodes, edges: opalEdges, assets: Object.fromEntries(assetNodes) }, true);
  }, [opalData, setOpalData]);

  const doLayout = async () => {
    const rf = reactFlowRef.current;
    if (!rf) return;
    const result = await autoLayout(rf.getNodes(), rf.getEdges(), "RIGHT");
    rf.setNodes(result.nodes);
    rf.setEdges(result.edges);

    setTimeout(() => {
      rf.fitView(FIT_VIEW_OPTIONS);
      onGraphChanged(result.nodes, result.edges);
    }, CHANGE_DELAY);
  };

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
  }, [setSelectedNode]);

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
  }, []);

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
  }, [setSelectedNode]);

  const onConnect = useCallback((conn: Connection) => {
    const rf = reactFlowRef.current;
    if (!rf) return;
    // 不允许连接自己
    if (conn.source === conn.target) {
      return;
    }

    setEdges((eds) => addEdge(conn, eds));

    setTimeout(() => {
      onGraphChanged();
    }, CHANGE_DELAY);
  }, [onGraphChanged]);

  const appendNewNode = (type: OpalNodeType, position: { x: number, y: number }, initData?: any) => {
    const rf = reactFlowRef.current;
    if (!rf) return;

    const nodeId = `${type}-${uuid()}`;
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
    else if (type === OpalNodeType.AssetsText) {
      rawType = OpalNodeType.AssetsText;
      rawTitle = t("静态文本");
      configuration = {
        text: {
          content: "",
          role: "user"
        }
      };
    }
    else if (type === OpalNodeType.AssetsFile) {
      rawType = OpalNodeType.AssetsFile;
      rawTitle = initData.title;
      configuration = {
        file: initData.file
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

    setNodes((nds) => [...nds, newNode]);

    setTimeout(() => {
      onGraphChanged();
    }, CHANGE_DELAY);

  };

  const addNewNode = (type: OpalNodeType, initData?: any) => {
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

    appendNewNode(type, position, initData);
  };

  const onDragStart = useCallback((event: React.DragEvent, nodeType: OpalNodeType) => {
    event.dataTransfer.setData('application/reactflow/type', nodeType);
    event.dataTransfer.effectAllowed = 'move';
    setInDragDropMode(true);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setInDragDropMode(false);
    const type = event.dataTransfer.getData('application/reactflow/type');
    const rf = reactFlowRef.current;
    if (!type || !rf) {
      return;
    }

    // 先转换为画布坐标，然后再调整偏移量
    const flowPosition = rf.screenToFlowPosition({
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
    }, CHANGE_DELAY);
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

  // 当用户刚从某个 Handle 按住鼠标往外拉线时触发
  const handleConnectStart = useCallback((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    const targetElement = event.target as HTMLElement;
    if (!targetElement) return;

    const nodeId = targetElement.getAttribute('data-nodeid') || '';
    const handleId = targetElement.getAttribute('data-id') || targetElement.getAttribute('id') || '';
    const handleType = targetElement.classList.contains('source') ? 'source'
            : (targetElement.classList.contains('target') ? 'target' : '');
    if (nodeId) {
      connectingSourceRef.current = {
        nodeId: nodeId,
        handleId: handleId,
        handleType: handleType
      };
    }
  }, []);

  // 精准接管连线生命周期终点事件
  const handleConnectEnd = useCallback((_event: MouseEvent | TouchEvent) => {
    const rf = reactFlowRef.current;
    if (!rf) return;

    const source = connectingSourceRef.current;
    const snapTarget = __NODEZATOR_ACTIVE_SNAP_TARGET__;

    console.log('>> 动态吸附连线：target: ', snapTarget);
    // 如果松手的一瞬间，小手处于相撞变橘黄状态，且我们记录到了源头
    if (snapTarget && source && source.nodeId) {
      // 不允许连接自己
      if (source.nodeId === snapTarget.nodeId) {
        return;
      }

      let eSource: NodeHandleType | null = null;
      let eTarget: NodeHandleType | null = null;
      for (const item of [source, snapTarget]) {
        if (item.handleType === 'source') {
          eSource = item;
        } else if (item.handleType === 'target') {
          eTarget = item;
        }
      }

      if (eSource === null || eTarget === null) {
        return;
      }

      const newEdge: Edge = {
        id: `edge-${eSource.nodeId}-${eTarget.nodeId}`,
        source: eSource.nodeId,
        target: eTarget.nodeId,
        sourceHandle: null,
        targetHandle: null,
        data: { out: 'context', in: `p-z-${eSource.nodeId}` }
      };

      if (isEdgeExists(newEdge, rf.getEdges())) {
        console.log('>> 连接已存在忽略动态吸附连线');
        return;
      }

      setEdges((eds) => addEdge(newEdge, eds));

      // 在目标节点中动态插入对source节点的引用
      const sNode = rf.getNode(source.nodeId);
      const tNode = rf.getNode(snapTarget.nodeId);
      if (sNode && tNode) {
        const sRawData: OpalNode = sNode.data;
        const tRawData: OpalNode = tNode.data;

        let refType = OpalNodeRefType.In;
        if (sRawData.type === OpalNodeType.AssetsText || sRawData.type === OpalNodeType.AssetsFile) {
          refType = OpalNodeRefType.Asset;
        }
        const refData = `\n {${JSON.stringify({"type": refType, "path": sNode.id, "title": sRawData.metadata.title})}}`;

        if (tNode.type === OpalNodeType.AgentGenerate) {
          const newConfig = {...tRawData.configuration};
          let content = newConfig['config$prompt']?.content || '';
          content += refData;
          newConfig['config$prompt'] = {content: content, role: 'user'};
          rf.updateNodeData(snapTarget.nodeId, {...tRawData, configuration: newConfig});
        }
        else if (tNode.type === OpalNodeType.RenderOutputs) {
          const newConfig = {...tRawData.configuration};
          let content = newConfig['text']?.content || '';
          content += refData;
          newConfig['text'] = {content: content, role: 'user'};
          rf.updateNodeData(snapTarget.nodeId, {...tRawData, configuration: newConfig});
        }
      }

      setTimeout(() => {
        onGraphChanged();
      }, CHANGE_DELAY);
    }

    // 无论连线成功与否，落幕时彻底清空起点缓存，防止污染下次连线
    connectingSourceRef.current = null;
  }, [onGraphChanged]);

  const addAssetFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const files = input.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      const getPath = window.electronAPI?.getPathForFile;
      const initData = {
        title: file.name,
        file: {
          url: getPath ? getPath(file) : file.name,
          mimeType: file.type,
          role: "user"
        }
      };
      addNewNode(OpalNodeType.AssetsFile, initData);
    };
    input.click();
  };

  // 传入的 graphData 上图
  useEffect(() => {
    // silent = true 表示画布内部操作引发的修改，不需要重新 setNodes
    // 但组件首次挂载时必须初始化，无论 silent 状态
    if (opalPayload.silent && isGraphInitializedRef.current) {
      return;
    }

    console.log('>>> init graph data', opalData);
    
    if (!opalData || !opalData.nodes) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const flowNodes = (opalData.nodes || []).map((gNode: OpalNode): FlowNode => {
      return {
        id: gNode.id,
        type: gNode.type,
        position: {x: gNode.metadata.visual?.x || 0, y: gNode.metadata.visual?.y || 0},
        data: gNode
      };
    });

    const flowEdges = (opalData.edges || []).map((gEdge: OpalEdge): Edge => {
      return {
        id: `edge-${gEdge.from}-${gEdge.to}`,
        source: gEdge.from,
        target: gEdge.to,
        // 保留 out/in 语义,供保存时(onGraphChanged)回写,避免往返丢失。
        data: { out: gEdge.out, in: gEdge.in }
      };
    });

    // 将静态资源转换为资源节点
    const opalAssets = opalData.assets;
    if (opalAssets) {
      for (let assetId in opalAssets) {
        const assetData = opalAssets[assetId];
        const assetNode: FlowNode = {
          id: assetId,
          type: assetData.type,
          position: {x: assetData.metadata.visual?.x || 0, y: assetData.metadata.visual?.y || 0},
          data: assetData
        };
        flowNodes.push(assetNode);
      }

      // 从节点中寻找哪些节点内容中引用了静态资源，动态创建它们之间的边
      opalData.nodes.forEach((pNode: OpalNode) => {
        let content = "";
        if (pNode.type === OpalNodeType.AgentGenerate) {
          content = pNode.configuration.config$prompt?.content || '';
        }
        else if (pNode.type === OpalNodeType.RenderOutputs) {
          content = pNode.configuration.text?.content || '';
        }
        else if (pNode.type === OpalNodeType.UserInputs) {
          content = pNode.configuration.description?.content || '';
        }

        let foundAssets: string[] = [];
        const regex = /\{\{(.*?)\}\}/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          const varRefValue = match[0]; // {{type:asset, path:<asset_id>}}
          try {
            const refData = JSON.parse(varRefValue.substring(1, varRefValue.length-1));
            if ('asset' === refData.type && opalAssets[refData.path||'']) {
              foundAssets.push(refData.path);
            }
          } catch(e) {}
        }

        if (foundAssets.length > 0) {
          foundAssets.forEach((assetId:string) => {
            const newEdge: Edge = {
              id: `edge-${assetId}-${pNode.id}`,
              source: assetId,
              target: pNode.id,
              data: { out: 'context', in: `p-z-${assetId}` }
            };
            if (!isEdgeExists(newEdge, flowEdges)) {
              flowEdges.push(newEdge);
            }
          });
        }
      });
    }

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
        setChatHistory((prev) => [...prev, {role: 'error', content: error?.message || String(error)}]);
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
  }, [execState]);

  useEffect(() => {
    const container = graphDomRef.current;
    if (!container) return;

    // 创建 ResizeObserver 监听容器尺寸改变
    const trigger = debounce(() => {
      const rf = reactFlowRef.current;
      rf && rf.fitView(FIT_VIEW_OPTIONS);
    }, 200);

    const resizeObserver = new ResizeObserver(trigger);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      trigger.cancel();
    };
  }, []);

  return (
      <div ref={graphDomRef} className="absolute inset-0" style={{ overflow: 'hidden' }}
        onMouseDown={() => setChatListCollapsed(true)}
      >
        <div className="graph-nodes-panel">
          <div className="relative graph-nodes">
            <button className="first" data-nodetype={OpalNodeType.UserInputs} draggable
                    onDragStart={(e) => onDragStart(e, OpalNodeType.UserInputs)}
                    onDragEnd={() => setInDragDropMode(false)}
                    onClick={() => addNewNode(OpalNodeType.UserInputs)}>
              <span className="btn-icon"><MessageSquareText size={20} strokeWidth={1.5}/></span><span>{t('用户输入')}</span>
            </button>
            <button data-nodetype={OpalNodeType.AgentGenerate} draggable
                    onDragStart={(e) => onDragStart(e, OpalNodeType.AgentGenerate)}
                    onDragEnd={() => setInDragDropMode(false)}
                    onClick={() => addNewNode(OpalNodeType.AgentGenerate)}>
              <span className="btn-icon"><Sparkles size={20} strokeWidth={1.5}/></span><span>{t('AI生成')}</span>
            </button>
            <button data-nodetype={OpalNodeType.RenderOutputs} draggable
                    onDragStart={(e) => onDragStart(e, OpalNodeType.RenderOutputs)}
                    onDragEnd={() => setInDragDropMode(false)}
                    onClick={() => addNewNode(OpalNodeType.RenderOutputs)}>
              <span className="btn-icon"><Proportions size={20} strokeWidth={1.5}/></span><span>{t('输出')}</span>
            </button>
            <div className="divider"></div>
            <PopoverNext placement="bottom-start"
              content={
                <Menu>
                  <MenuItem icon="export" text={t('上传文件')} onClick={() => addAssetFile()} />
                  <MenuItem icon="label" text={t('文本内容')} onClick={() => addNewNode(OpalNodeType.AssetsText)} />
                </Menu>
              }
            >
              <button className="last"><span className="btn-icon"><SquarePlus size={20} strokeWidth={1.5}/></span><span>{t('添加资产')}</span></button>
            </PopoverNext>

            <div className="absolute help-tip">
              <button onClick={()=>setShowHelp(true)}><span className="btn-icon"><CircleQuestionMark size={16} strokeWidth={1.5}/></span>{t('帮助')}</button>
            </div>
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
          connectionRadius={20}
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

        { (nodes.length === 0 && !inDragDropMode) && (
          <div ref={emptyStateDomRef} className="absolute inset-0 flex items-center justify-center graph-empty-state">
            <div className="empty-state-top">
              <div>{t('添加一个步骤开始')}</div>
              <div className="empty-icon">
                <svg width="30" height="40" fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="-50 0 16 24">
                  <path fill="currentColor" d="M -44.161 21.19 C -44.376 21.536 -44.677 21.426 -44.769 21.264 C -45.115 20.665 -45.508 20.066 -45.693 19.398 C -46.247 17.623 -46.178 15.826 -45.808 14.028 C -45.185 10.963 -43.799 8.244 -42.067 5.663 C -41.882 5.386 -41.721 5.109 -41.536 4.81 C -41.536 4.787 -41.559 4.741 -41.605 4.672 C -42.113 4.81 -42.644 4.948 -43.152 5.063 C -43.43 5.109 -43.753 5.109 -44.03 5.017 C -44.192 4.971 -44.423 4.718 -44.423 4.556 C -44.423 4.349 -44.261 4.095 -44.122 3.911 C -44.007 3.796 -43.799 3.773 -43.614 3.727 C -42.229 3.381 -40.843 2.989 -39.434 2.666 C -38.233 2.39 -37.841 2.782 -37.91 3.957 C -37.979 5.179 -38.003 6.4 -38.049 7.598 C -38.072 7.967 -38.026 8.372 -38.187 8.774 C -38.632 9.22 -39.157 8.336 -39.504 4.602 C -40.959 6.216 -41.928 7.967 -42.829 9.765 C -43.73 11.562 -44.33 13.452 -44.654 15.457 C -44.977 17.531 -44.853 18.977 -44.161 21.19 Z"></path>
                </svg>
              </div>
            </div>
            <div>
              <h3>{t('用自然语言构建你的App')}</h3>
              {/*<h4>{t('查看我们的')} <a href="#">{t('演示视频')}</a></h4>*/}
            </div>
            <div className="empty-state-bottom">
              <div>... <span>{t('或输入你想构建的内容')}</span></div>
              <div className="empty-icon">
                <svg width="30" height="40" fill="none" xmlns="http://www.w3.org/2000/svg" viewBox="-50 0 16 24">
                  <path fill="currentColor" d="M -44.161 21.19 C -44.376 21.536 -44.677 21.426 -44.769 21.264 C -45.115 20.665 -45.508 20.066 -45.693 19.398 C -46.247 17.623 -46.178 15.826 -45.808 14.028 C -45.185 10.963 -43.799 8.244 -42.067 5.663 C -41.882 5.386 -41.721 5.109 -41.536 4.81 C -41.536 4.787 -41.559 4.741 -41.605 4.672 C -42.113 4.81 -42.644 4.948 -43.152 5.063 C -43.43 5.109 -43.753 5.109 -44.03 5.017 C -44.192 4.971 -44.423 4.718 -44.423 4.556 C -44.423 4.349 -44.261 4.095 -44.122 3.911 C -44.007 3.796 -43.799 3.773 -43.614 3.727 C -42.229 3.381 -40.843 2.989 -39.434 2.666 C -38.233 2.39 -37.841 2.782 -37.91 3.957 C -37.979 5.179 -38.003 6.4 -38.049 7.598 C -38.072 7.967 -38.026 8.372 -38.187 8.774 C -38.632 9.22 -39.157 8.336 -39.504 4.602 C -40.959 6.216 -41.928 7.967 -42.829 9.765 C -43.73 11.562 -44.33 13.452 -44.654 15.457 C -44.977 17.531 -44.853 18.977 -44.161 21.19 Z"></path>
                </svg>
              </div>
            </div>
          </div>
        )}

        <div className="graph-chatbox" onMouseDown={(e)=>e.stopPropagation()}>
          <div className="relative graph-chatbox-wrapper">
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

        <Overlay2
          isOpen={showHelp}
          onClose={() => setShowHelp(false)}
          className={Classes.OVERLAY_SCROLL_CONTAINER}
          hasBackdrop={true}
        >
          <Card className="opal-help-content" elevation={3}>
            <h3>{t('步骤节点帮助信息')}</h3>
            <div>
              <ul>
                <li>
                  <div className="flex items-center gap-md opal-help-title"><MessageSquareText size={20} strokeWidth={1.5}/><b>{t('用户输入')}</b></div>
                  <div className="opal-help-desc">{t("此步骤用于收集用户输入。系统会向用户显示提示信息。您可以使用高级选项来指定用户应提供的输入类型，例如文本或图像。")}</div>
                </li>
                <li>
                  <div className="flex items-center gap-md opal-help-title"><Sparkles size={20} strokeWidth={1.5}/><b>{t('AI生成')}</b></div>
                  <div className="opal-help-desc">{t("您可以选择要使用的AI模型，然后指定要发送给该模型的提示。通过在之前的步骤中收集用户输入，您可以在向AI模型发送提示以生成新内容（例如文本回复、视频或图像）时参考用户的输入，具体取决于您选择的AI模型。")}</div>
                </li>
                <li>
                  <div className="flex items-center gap-md opal-help-title"><Proportions size={20} strokeWidth={1.5}/><b>{t('输出')}</b></div>
                  <div className="opal-help-desc">{t("输出步骤允许您控制在收集和生成所需数据后所显示的内容。您可以选择应用程序的输出方式，例如创建由 AI 模型决定布局的动态网页。一个应用中可以使用多个输出步骤。")}</div>
                </li>
                <li>
                  <div className="flex items-center gap-md opal-help-title"><SquarePlus size={20} strokeWidth={1.5}/><b>{t('添加资产')}</b></div>
                  <div className="opal-help-desc">{t("除了步骤之外，您可以使用静态资源作为参考，例如提供示例或AI需求的资源。例如，您可以上传一张参考图片，并要求AI仅生成与您上传的参考图片风格一致的图片。或者，您可以添加一份文档，并要求AI生成符合参考文档结构的内容。")}</div>
                </li>
              </ul>
            </div>
          </Card>
        </Overlay2>
      </div>
  );
}
