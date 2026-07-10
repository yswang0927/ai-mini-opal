import { useEffect, useRef, useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ReactFlowProvider } from '@xyflow/react';
import ChatGraph from '@/components/graph/ChatGraph';
import { ExecutorPanel } from '@/components/graph/executor';
import { LayoutResizer } from '@/utils';
import type { OpalJson } from '@/types';
import { EditorProvider, useEditorContext } from './EditorContext';
import Header from './Header';
import Sidebar from './Sidebar';
import { api } from '@/utils/Api';

import "./style.css";
import "../../components/graph/executor/executor.css";

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
    const { id } = useParams<{ id: string }>();

    const sidebarDomRef = useRef<HTMLDivElement | null>(null);
    const resizerRef = useRef<LayoutResizer>(null);
    const { sidebarShow, viewMode, execState, loadGraph, startExecution, submitInput, resetExecutor } = useEditorContext();

    // Current app data state
    const [appData, setAppData] = useState<OpalJson | undefined>(undefined);

    // Debounce timer for saving
    const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

    const loadAppData = useCallback(async (appId: string) => {
        try {
            const appData = await api.getAppData(appId);
            // If app data has graph content, load it
            if (appData && appData.nodes && appData.edges) {
                setAppData(appData as OpalJson);
                loadGraph(appData as OpalJson);
            }
        } catch (e: any) {
            console.error('Failed to load app data:', e);
        }
    }, [loadGraph]);

    useEffect(() => {
        if (id) {
            loadAppData(id);
        }
    }, [id]);

    // Handle graph changes and save
    const handleGraphChange = useCallback((graphData: OpalJson) => {
        console.log('changed-graph-data: ', graphData);
    }, [id]);

    const saveAppData = useCallback(async (appId: string, graphData: OpalJson) => {
        try {
            // Get current app data to preserve title, description, etc.
            const currentAppData = await api.getAppData(appId);
            const dataToSave = {
                ...currentAppData,
                ...graphData
            };
            await api.saveAppData(appId, dataToSave);
        } catch (e: any) {
            console.error('Failed to save app data:', e);
        }
    }, []);

    
    const handleRunApp = useCallback(async () => {
        try {
            resetExecutor();
            if (id) {
                const appData = await api.getAppData(id);
                if (appData && appData.nodes && appData.edges) {
                    //loadGraph(appData as OpalJson);
                }
            }
        } catch (e: any) {
            console.error('Failed to load graph:', e);
        }
    }, [id, loadGraph, resetExecutor]);

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
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
        };
    }, [viewMode]);

    return (
        <div className="opal-editor">
            <div className="layout-header">
                <Header appData={appData} />
            </div>

            <div className="layout-body">
                {viewMode === 'editor' && (
                    <>
                        <div className="layout-main">
                            <ChatGraph graphData={appData} onGraphChange={handleGraphChange} />
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
