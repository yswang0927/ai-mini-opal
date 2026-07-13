import { useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import ChatGraph from '@/components/graph/ChatGraph';
import { ExecutorPanel } from '@/components/graph/executor';
import { LayoutResizer } from '@/utils';
import { EditorProvider, useEditorContext } from './EditorContext';
import Header from './Header';
import Sidebar from './Sidebar';

import "./style.css";
import "../../components/graph/executor/executor.css";

export default function ChatGraphEditor() {
    const { id } = useParams<{ id: string }>();

    if (!id) {
        return <div>缺少编辑器ID</div>;
    }

    return (
        <EditorProvider id={id}>
            <ReactFlowProvider>
                <ChatGraphEditorContent />
            </ReactFlowProvider>
        </EditorProvider>
    );
};

function ChatGraphEditorContent() {
    const { id } = useParams<{ id: string }>();
    const sidebarDomRef = useRef<HTMLDivElement | null>(null);
    const resizerRef = useRef<LayoutResizer>(null);
    const { sidebarShow, viewMode, opalPayload, execState,
        loadGraph, startExecution, submitInput, resetExecutor } = useEditorContext();
    const opalData = opalPayload.data;

    const handleRunApp = useCallback(async () => {
        try {
            resetExecutor();
            loadGraph(opalData);
        } catch (e: any) {
            console.error('Failed to load graph:', e);
        }
    }, [opalData, loadGraph, resetExecutor]);

    useEffect(() => {
        if (viewMode === 'app' && execState.status === 'idle') {
            handleRunApp();
        }
    }, [viewMode, handleRunApp]);


    useEffect(() => {
        resizerRef.current?.destroy();
        
        if (viewMode === 'editor') {
            resizerRef.current = new LayoutResizer({
                key: 'opal-flow-editor-resize',
                trigger: sidebarDomRef.current!.querySelector<HTMLElement>('.layout-resizer')!,
                target: sidebarDomRef.current!
            });
        }

        return () => {
            resizerRef.current?.destroy();
            resizerRef.current = null;
        };
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
                            <ChatGraph graphId={id} />
                        </div>

                        <div ref={sidebarDomRef} className={`layout-sidebar${sidebarShow ? '' : ' is-hidden'}`}>
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
