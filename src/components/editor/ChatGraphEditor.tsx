import { useEffect, useRef, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import ChatGraph from '@/components/graph/ChatGraph';
import { ExecutorPanel } from '@/components/graph/executor';
import type { OpalGraphJson } from '@/components/graph/executor';
import { LayoutResizer } from '@/utils/util';
import { EditorProvider, useEditorContext } from './EditorContext';
import Header from './Header';
import Sidebar from './Sidebar';

import "./style.css";
import "../graph/executor/executor.css";

export default function ChatGraphEditor() {
    return (
        <EditorProvider>
            <ReactFlowProvider>
                <ChatGraphEditorContent />
            </ReactFlowProvider>
        </EditorProvider>
    );
};

function ChatGraphEditorContent() {
    const sidebarRef = useRef<HTMLDivElement | null>(null);
    const resizerRef = useRef<LayoutResizer>(null);
    const { sidebarShow, viewMode, execState, loadGraph, startExecution, submitInput, resetExecutor } = useEditorContext();

    useEffect(() => {
        resizerRef.current?.destroy();
        resizerRef.current = new LayoutResizer({
            key: 'opal-flow-editor-resize',
            trigger: sidebarRef.current!.querySelector<HTMLElement>('.layout-resizer')!,
            target: sidebarRef.current!
        });
        return () => {
            resizerRef.current?.destroy();
        };
    }, []);

    const handleRunApp = useCallback(async () => {
        try {
            resetExecutor();
            const rsp = await fetch('./generated_graph.json');
            const graphJson: OpalGraphJson = await rsp.json();
            loadGraph(graphJson);
        } catch (e: any) {
            console.error('Failed to load graph:', e);
        }
    }, [loadGraph, resetExecutor]);

    useEffect(() => {
        if (viewMode === 'app' && execState.status === 'idle') {
            handleRunApp();
        }
    }, [viewMode]);

    return (
        <div className="opal-editor">
            <div className="layout-header">
                <Header />
            </div>

            <div className="layout-body">
                {viewMode === 'editor' && (
                    <>
                        <div className="layout-main">
                            <ChatGraph />
                        </div>

                        <div ref={sidebarRef} className={`layout-sidebar${sidebarShow ? '' : ' is-hidden'}`}>
                            <div className="layout-resizer" data-region="right" data-min="300" data-max="1200"></div>
                            <div className="layout-sidebar-body">
                                <Sidebar />
                            </div>
                        </div>
                    </>
                )}

                {viewMode === 'app' && (
                    <div className="layout-main">
                        <ExecutorPanel
                            execState={execState}
                            onSubmitInput={submitInput}
                            onStart={startExecution}
                            onRestart={handleRunApp}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
