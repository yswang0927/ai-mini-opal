import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import Quill from 'quill';
import { ExecutorPanel } from '@/components/graph/executor';
import type { NodeExecInfo } from '@/components/graph/executor';
import { NodeTypesStyle } from '@/components/graph/types';
import { type OpalNode, OpalNodeType } from '@/types';
import { useL10n } from "@/l10n";
import { debounce } from '@/utils';

import { useEditorContext } from './EditorContext';
import { TagBlot, TagModule, quillContentToText } from './QuillCustomBlots';

import "quill/dist/quill.core.css";


Quill.register('formats/tag', TagBlot);
Quill.register('modules/tag', TagModule);


/**
 * 步骤节点数据详情
 * {id, type, metadata, configuration}
 */
const StepDetailView = ({stepData}: { stepData: OpalNode }) => {
    const { t } = useL10n();
    const { updateNode } = useReactFlow();

    const quillDomRef = useRef<HTMLDivElement>(null);
    const quillRef = useRef<Quill | null>(null);

    const [title, setTitle] = useState('');

    const titleChangeTrigger = useMemo(() => {
        return debounce((newTitle: string) => {
            // 更新节点配置
            const newData = { ...stepData, metadata: { ...stepData.metadata, title: newTitle } };
            updateNode(stepData.id, {data: newData});
        }, 300);
    }, [stepData, updateNode]);

    const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newTitle = e.target.value;
        setTitle(newTitle);
        titleChangeTrigger(newTitle);
    };

    const typeName = stepData.type;
    const nodeTypeStyle = NodeTypesStyle[typeName];

    useEffect(() => {
        // 组件卸载时，必须取消尚未执行的防抖，防止内存泄漏或闭包报错
        return () => {
            titleChangeTrigger.cancel();
        };
    }, [titleChangeTrigger]);

    useEffect(() => {
        if (!quillDomRef.current || quillRef.current) return;

        const quill = quillRef.current = new Quill(quillDomRef.current, {
            placeholder: t('在此输入您的提示，使用 @ 来包含其他内容。'),
            theme: 'snow',
            modules: {
                toolbar: false,
                // 激活我们的自定义模块
                tag: true
            },
        });

        const handleTextChange = debounce((_delta: any, _oldDelta: any, source: string) => {
            // 只有真正的用户输入才需要保存：
            if (source !== 'user') {
                return;
            }

            const text = quillContentToText(quill);
            let targetKey = '';
            if (OpalNodeType.UserInputs === typeName) {
                targetKey = 'description';
            }
            else if (OpalNodeType.AgentGenerate === typeName) {
                targetKey = 'config$prompt';
            }
            else if (OpalNodeType.RenderOutputs === typeName) {
                targetKey = 'text';
            }

            // 如果匹配到了对应的类型，进行统一的安全赋值
            if (targetKey) {
                stepData.configuration ??= {};
                stepData.configuration[targetKey] ??= {content:"", role:"user"};
                stepData.configuration[targetKey].content = text;

                // 更新节点配置
                updateNode(stepData.id, {data: stepData});
            }

        }, 300);

        quill.on(Quill.events.TEXT_CHANGE, handleTextChange);

        return () => {
            quill.off(Quill.events.TEXT_CHANGE, handleTextChange);
            handleTextChange.cancel();
            quillRef.current = null;
        };
    }, []);

    // 切换到不同 step 时才重置内容，避免覆盖用户正在编辑的内容
    useEffect(() => {
        const quill = quillRef.current;
        if (!quill) {
            return;
        }
        
        setTitle(stepData.metadata.title || '');

        let desc = '';
        if (OpalNodeType.UserInputs === typeName) {
            desc = stepData.configuration?.description?.content || '';
        }
        else if (OpalNodeType.AgentGenerate === typeName) {
            desc = stepData.configuration?.config$prompt?.content || '';
        }
        else if (OpalNodeType.RenderOutputs === typeName) {
            desc = stepData.configuration?.text?.content || '';
        }

        quill.setText(desc, Quill.sources.API);
        quill.history.clear(); // 避免 Ctrl+Z 撤回到上一个 step 的内容
    }, [stepData]);

    return (
        <div className="flex h-full flex-col opal-node-detail">
            <div className="flex items-center gap-md opal-node-detail-header" 
                data-nodetype={stepData.type} style={{ backgroundColor: nodeTypeStyle.bgColor }}>
                <span style={{lineHeight:"1"}}>{ nodeTypeStyle.icon }</span> 
                <div className="flex-1">
                    <input type="text" className="step-title-input" autoComplete="off" required value={title} onChange={handleTitleChange} />
                </div>
            </div>
            <div className="relative flex-1 opal-node-detail-body">
                <div className="absolute inset-0"><div ref={quillDomRef}></div></div>
            </div>
        </div>
    );
};

const ConsoleView = ({ execLog, currentNodeId }: {
    execLog: NodeExecInfo[];
    currentNodeId: string | null;
}) => {
    const { t } = useL10n();
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [execLog.length]);

    if (execLog.length === 0 && !currentNodeId) {
        return (
            <div className="console-empty">
                <p>{t('运行预览后，节点执行日志将显示在这里')}</p>
            </div>
        );
    }

    return (
        <div className="console-view" ref={scrollRef}>
            {execLog.map((item, idx) => (
                <div key={`${item.nodeId}-${idx}`} className={`console-item console-item-${item.status}`}>
                    <div className="console-item-header">
                        <span className="console-item-status" data-status={item.status} />
                        <span className="console-item-title">{item.title}</span>
                    </div>
                    {item.input && (
                        <div className="console-item-section">
                            <span className="console-item-label">Input</span>
                            <pre className="console-item-content">{item.input}</pre>
                        </div>
                    )}
                    {item.output && (
                        <div className="console-item-section">
                            <span className="console-item-label">Output</span>
                            <pre className="console-item-content">{item.output}</pre>
                        </div>
                    )}
                </div>
            ))}
            {currentNodeId && !execLog.find(l => l.nodeId === currentNodeId) && (
                <div className="console-item console-item-running">
                    <div className="console-item-header">
                        <span className="console-item-status" data-status="running" />
                        <span className="console-item-title">{t('执行中...')}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default function Sidebar() {
    const { t } = useL10n();
    const [selectedTab, setSelectedTab] = useState('');
    const { selectedNode, execState, loadGraph, startExecution, submitInput, resetExecutor } = useEditorContext();

    useEffect(() => {
        setSelectedTab(selectedNode !== null ? 'Step' : '');
    }, [selectedNode]);

    const doRunPreview = useCallback(async () => {
        resetExecutor();
        /*try {
            const rsp = await fetch('./generated_graph.json');
            const graphJson: OpalGraphJson = await rsp.json();
            loadGraph(graphJson);
        } catch (e: any) {
            console.error('Failed to load graph:', e);
        }*/
    }, [loadGraph, resetExecutor]);

    const handlePreviewTab = useCallback(() => {
        setSelectedTab('Preview');
        if (execState.status === 'idle') {
            doRunPreview();
        }
    }, [doRunPreview, execState.status]);

    return (
        <div className="editor-side">
            <div className="editor-side-header">
                <div className="editor-side-nav">
                    <button className={selectedTab === 'Preview' ? 'selected' : ''} onClick={handlePreviewTab}>{t('预览应用')}</button>
                    <button className={selectedTab === 'Console' ? 'selected' : ''} onClick={() => setSelectedTab('Console')}>{t('控制台')}</button>
                    <button className={selectedTab === 'Step' ? 'selected' : ''} onClick={() => setSelectedTab('Step')}>{t('节点')}</button>
                    <button className={selectedTab === 'Theme' ? 'selected' : ''} onClick={() => setSelectedTab('Theme')}>{t('主题')}</button>
                </div>
            </div>

            <div className="relative editor-side-body">
                {selectedTab === 'Preview' && (
                    <ExecutorPanel
                        execState={execState}
                        onSubmitInput={submitInput}
                        onStart={startExecution}
                        onRestart={doRunPreview}
                    />
                )}
                {selectedTab === 'Console' && (
                    <ConsoleView
                        execLog={execState.nodeExecLog}
                        currentNodeId={execState.currentNodeId}
                    />
                )}
                {selectedTab === 'Step' && !selectedNode && (
                    <div className="empty-state">{t('请选择一个节点编辑')}</div>
                )}
                {selectedTab === 'Step' && selectedNode && (
                    <StepDetailView key={selectedNode.id} stepData={selectedNode} />
                )}
                {selectedTab !== 'Preview' && selectedTab !== 'Step' && selectedTab !== 'Console' && (
                    <div className="empty-state">{t('您的应用在构建完成后将在这里显示')}</div>
                )}
            </div>
        </div>
    );
}