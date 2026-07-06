import { useCallback } from 'react';

import { 
  useReactFlow,
  type Node,
} from '@xyflow/react';

import { 
  Sparkles, 
  Proportions, 
  MessageSquareText, 
  SquarePlus
} from 'lucide-react';

import { LayoutDagIcon } from '@/components/icons';
import autoLayout from './AutoLayout';

const NODE_WIDTH = 280;

const nodeRandomOffset = () => {
  return Math.round(Math.random() * 100) * (Math.random() > 0.5 ? 1 : -1);
};

export default function GraphToolbar() {
    const { getNodes, getEdges, setNodes, setEdges, fitView, screenToFlowPosition, getNodesBounds } = useReactFlow();

    const doLayout = useCallback(async () => {
        const {nodes, edges} = await autoLayout(getNodes(), getEdges(), "RIGHT");
        setNodes(nodes);
        setEdges(edges);
        fitView();
    }, [getNodes, getEdges, setNodes, setEdges, fitView]);

    const onDragStart = (event: React.DragEvent, nodeType: string) => {
        event.dataTransfer.setData('application/reactflow/type', nodeType);
        event.dataTransfer.effectAllowed = 'move';
    };

    const appendNewNode = (type: string, position: { x: number, y: number }) => {
        const nodeId = `${type}-${Date.now()}`;
        const newNode: Node = {
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
        // 计算画布中间位置
        const rect = getNodesBounds(getNodes());
        const canvasWidth = rect.width || 800;
        const canvasHeight = rect.height || 600;
        
        // 将屏幕中间位置转换为画布坐标
        const position = screenToFlowPosition({
            x: (canvasWidth / 2 - NODE_WIDTH / 2 + nodeRandomOffset()),
            y: (canvasHeight / 2 + nodeRandomOffset())
        });

        appendNewNode(type, position);
    }, [getNodes, screenToFlowPosition, getNodesBounds]);

    return (
        <div className="graph-nodes">
            <button data-node-type="userInput" draggable onDragStart={(e) => onDragStart(e, 'userInput')} onClick={() => addNode('userInput')}><MessageSquareText size={20} strokeWidth={1.5}/><span>User Input</span></button>
            <button data-node-type="opalGenerate" draggable onDragStart={(e) => onDragStart(e, 'opalGenerate')} onClick={() => addNode('opalGenerate')}><Sparkles size={20} strokeWidth={1.5}/><span>Generate</span></button>
            <button data-node-type="opalOutput" draggable onDragStart={(e) => onDragStart(e, 'opalOutput')} onClick={() => addNode('opalOutput')}><Proportions size={20} strokeWidth={1.5}/><span>Output</span></button>
            <div className="divider"></div>
            <button><SquarePlus size={20} strokeWidth={1.5}/><span>Add Assets</span></button>
            <div className="divider"></div>
            <button onClick={() => doLayout()}><LayoutDagIcon /><span>Layout</span></button>
          </div>
    );
};
