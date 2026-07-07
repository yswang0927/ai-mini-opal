import { useState, useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import Quill from 'quill';
import { useEditorContext } from './EditorContext';
import { 
    NodeTypes, 
    type NodeDataType, 
    type NodeRawConfigurationType, 
    type NodeTypeKey 
} from '@/components/graph/types';

import "quill/dist/quill.core.css";

import { TagBlot, TagModule, quillContentToText } from './QuillCustomBlots';

Quill.register('formats/tag', TagBlot);
Quill.register('modules/tag', TagModule);


/**
 * 步骤节点详情
 * {id, type, data: {id, metadata, configuration}}
 */
const StepDetail = ({stepData}: {
    stepData: NodeDataType
}) => {
    const { updateNode } = useReactFlow();
    console.log('>> stepData: ', stepData);
    const quillDomRef = useRef<HTMLDivElement>(null);
    const quillRef = useRef<Quill | null>(null);

    const typeName = stepData.type as NodeTypeKey;
    const nodeType = NodeTypes[typeName];
    const rawData = stepData.data;

    let desc = '';
    if ('userInput' === typeName) {
        desc = rawData.configuration?.description?.parts[0].text || '';
    }
    else if ('opalGenerate' === typeName) {
        desc = rawData.configuration?.config$prompt?.parts[0].text || '';
    }
    else if ('opalOutput' === typeName) {
        desc = rawData.configuration?.text?.parts[0].text || '';
    }

    useEffect(() => {
        if (!quillDomRef.current || quillRef.current) return;

        const quill = quillRef.current = new Quill(quillDomRef.current, {
            placeholder: 'Type your prompt here. Use @ to include other content.',
            theme: 'snow',
            modules: {
                toolbar: false,
                // 激活我们的自定义模块
                tag: true
            },
        });

        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const handleTextChange = (_delta: any, _oldDelta: any, source: string) => {
            // 只有真正的用户输入才需要保存：
            if (source !== 'user') {
                return;
            }

            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                const text = quillContentToText(quill);
                let targetKey = '';
                if ('userInput' === typeName) {
                    targetKey = 'description';
                }
                else if ('opalGenerate' === typeName) {
                    targetKey = 'config$prompt';
                }
                else if ('opalOutput' === typeName) {
                    targetKey = 'text';
                }

                // 2. 如果匹配到了对应的类型，进行统一的安全赋值
                if (targetKey) {
                    rawData.configuration ??= {};
                    rawData.configuration[targetKey] ??= {};
                    rawData.configuration[targetKey].parts ??= [{}];
                    rawData.configuration[targetKey].parts[0] ??= {};
                    // 将修改后的 desc 赋值回去
                    rawData.configuration[targetKey].parts[0].text = text;
                }
                // TODO 更新节点配置
                //updateNode(stepData.id, rawData);
            }, 200);
        };

        quill.on(Quill.events.TEXT_CHANGE, handleTextChange);

        return () => {
            quill.off(Quill.events.TEXT_CHANGE, handleTextChange);
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            quillRef.current = null;
        };
    }, []);

    // 切换到不同 step 时才重置内容，避免覆盖用户正在编辑的内容
    useEffect(() => {
        const quill = quillRef.current;
        if (!quill) {
            return;
        }
        quill.setText(desc, Quill.sources.API);
        quill.history.clear(); // 避免 Ctrl+Z 撤回到上一个 step 的内容
    }, [stepData.id]);

    return (
        <div className="flex h-full flex-col opal-node-detail">
            <div className="flex items-center opal-node-detail-header" 
                data-nodetype={stepData.type} 
                style={{ gap: '8px', backgroundColor: nodeType.bgColor}}>
                <span style={{lineHeight:"1"}}>{ nodeType?.icon }</span> 
                <div>{stepData.data.metadata.title}</div>
            </div>
            <div className="relative flex-1 opal-node-detail-body">
                <div className="absolute inset-0"><div ref={quillDomRef}></div></div>
            </div>
        </div>
    );
};

export default function Sidebar() {
    const [selectedTab, setSelectedTab] = useState('');
    const { selectedNode } = useEditorContext();

    useEffect(() => {
        setSelectedTab(selectedNode !== null ? 'Step' : '');
    }, [selectedNode]);

    return (
        <div className="editor-side">
            <div className="editor-side-header">
                <div className="editor-side-nav">
                    <button className={selectedTab === 'Preview' ? 'selected' : ''} onClick={() => setSelectedTab('Preview')}>Preview</button>
                    <button className={selectedTab === 'Console' ? 'selected' : ''} onClick={() => setSelectedTab('Console')}>Console</button>
                    <button className={selectedTab === 'Step' ? 'selected' : ''} onClick={() => setSelectedTab('Step')}>Step</button>
                    <button className={selectedTab === 'Theme' ? 'selected' : ''} onClick={() => setSelectedTab('Theme')}>Theme</button>
                </div>
            </div>

            <div className="editor-side-body">
                {!selectedNode && (<div className="empty-state">Your app will appear here once it's built</div>)}
                { selectedNode && (<StepDetail stepData={selectedNode} />)}
            </div>
        </div>
    );
}