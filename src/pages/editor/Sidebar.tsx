import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import Quill from 'quill';
import { Mention, MentionBlot } from "quill-mention";
import { ExecutorPanel } from '@/components/graph/executor';
import type { NodeExecInfo } from '@/components/graph/executor';
import { NodeTypesStyle } from '@/components/graph/types';
import { type OpalNode, OpalNodeType } from '@/types';
import { useL10n } from "@/l10n";
import { debounce } from '@/utils';

import { useEditorContext } from './EditorContext';
import { OpalRefTagBlot, OpalRefTagModule, OpalRefTagMentionBlot, quillContentToText } from './QuillCustomBlots';

import "quill/dist/quill.core.css";
import "quill-mention/dist/quill.mention.css";


Quill.register('blots/opalRefTag', OpalRefTagBlot);
Quill.register('modules/opalRefTag', OpalRefTagModule);
Quill.register({ "blots/mention": MentionBlot, "modules/mention": Mention });
Quill.register(OpalRefTagMentionBlot);


/**
 * 步骤节点数据详情
 * {id, type, metadata, configuration}
 */
const StepDetailView = ({stepData}: { stepData: OpalNode }) => {
    const { t } = useL10n();
    const { updateNode } = useReactFlow();
    const { opalData } = useEditorContext();

    const quillDomRef = useRef<HTMLDivElement>(null);
    const quillRef = useRef<Quill | null>(null);
    const [title, setTitle] = useState('');

    const handleTitleChange = () => {
        // 更新节点配置
        if (title.trim()) {
            const newData = { ...stepData, metadata: { ...stepData.metadata, title: title } };
            updateNode(stepData.id, {data: newData});
        }
    };

    const typeName = stepData.type;
    const nodeTypeStyle = NodeTypesStyle[typeName];

    useEffect(() => {
        if (!quillDomRef.current || quillRef.current) return;

        const quill = quillRef.current = new Quill(quillDomRef.current, {
            placeholder: t('在此输入您的提示，使用 @ 来包含其他内容。'),
            theme: 'snow',
            modules: {
                toolbar: false,
                // 激活我们的自定义模块
                opalRefTag: true,
                mention: {
                    allowedChars: /^.*$/,
                    mentionDenotationChars: ["@"],
                    dataAttributes: ['id', 'value', 'refType', 'path'],
                    blotName: "opalRefTagMention",
                    source: async function(searchTerm: string, renderList: Function) {
                        const steps = (opalData?.nodes || []).filter(item => item.id !== stepData.id);
                        const stepsList = steps.map(item => ({
                            id: item.id,
                            value: item.metadata?.title || item.id,
                            team: "Step",
                            refType: "in",
                            path: item.id
                        }));
                        const toolsList = [
                            {id: 'search-web', value: '搜索网页', team: 'Tool', refType: 'tool', path: 'search-web'},
                            {id: 'code-execution', value: '代码执行', team: 'Tool', refType: 'tool', path: 'code-execution'}
                        ];

                        const allItems = [...toolsList, ...stepsList];
                        if (!searchTerm) {
                            renderList(allItems);
                        } else {
                            const filtered = allItems.filter(item =>
                                item.value.toLowerCase().includes(searchTerm.toLowerCase())
                            );
                            renderList(filtered);
                        }
                    },
                    renderItem: function(item: any) {
                        const div = document.createElement('div');
                        div.className = 'mention-item';
                        div.innerHTML = `<span class="mention-item-tag">${item.team}</span> ${item.value}`;
                        return div;
                    }
                }
            },
        });

        const handleTextChange = debounce((_delta: any, _oldDelta: any, source: string) => {
            // 只有真正的用户输入才需要保存：
            if (source !== 'user') {
                return;
            }

            const text = quillContentToText(quill);
            console.log('quill-text: ', text);

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
                data-nodetype={typeName} style={{ backgroundColor: nodeTypeStyle.bgColor }}>
                <span style={{lineHeight:"1"}}>{ nodeTypeStyle.icon }</span> 
                <div className="flex-1">
                    <input type="text" className="step-title-input" autoComplete="off" required 
                        value={title} 
                        onChange={(e) => setTitle(e.target.value)} 
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                handleTitleChange();
                            }
                        }}
                        onBlur={handleTitleChange}
                    />
                </div>
            </div>
            <div className="relative flex-1 opal-node-detail-body">
                <div className="absolute inset-0">
                    <div ref={quillDomRef}></div>
                </div>
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
    const { selectedNode, opalData, execState, loadGraph, startExecution, submitInput, resetExecutor } = useEditorContext();

    useEffect(() => {
        setSelectedTab(selectedNode !== null ? 'Step' : '');
    }, [selectedNode]);

    const doRunPreview = useCallback(async () => {
        resetExecutor();
        loadGraph(opalData);
    }, [opalData, loadGraph, resetExecutor]);

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
                    <button className={selectedTab === 'Step' ? 'selected' : ''} onClick={() => setSelectedTab('Step')}>{t('节点')}</button>
                    <button className={selectedTab === 'Console' ? 'selected' : ''} onClick={() => setSelectedTab('Console')}>{t('控制台')}</button>
                    {/*<button className={selectedTab === 'Theme' ? 'selected' : ''} onClick={() => setSelectedTab('Theme')}>{t('主题')}</button>*/}
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