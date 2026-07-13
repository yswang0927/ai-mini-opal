import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import type {ExecutionState} from '@/components/graph/executor';
import {useGraphExecutor} from '@/components/graph/executor';
import {type OpalJson, SaveState} from '@/types';
import {api} from '@/utils/Api';

type ViewMode = 'editor' | 'app';

export type OpalDataPayload = {
    data: OpalJson | null;
    silent: boolean;
};

type EditorContextValue = {
    sidebarShow: boolean;
    toggleSidebar: () => void;
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    opalPayload: OpalDataPayload;
    setOpalData: (data: OpalJson | null, silent?: boolean) => void;
    savingState: SaveState | null;
    dataLoading: boolean;
    selectedNode: any;
    setSelectedNode: (node: any) => void;
    execState: ExecutionState;
    loadGraph: (graphJson: OpalJson | null) => void;
    startExecution: () => Promise<void>;
    submitInput: (inputs: Record<string, string>) => void;
    resetExecutor: () => void;
};

const EditorContext = createContext<EditorContextValue | null>(null);

export const EditorProvider: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const [viewMode, setViewMode] = useState<ViewMode>('editor');
    const [sidebarShow, setSidebarShow] = useState(true);
    const [dataLoading, setDataLoading] = useState<boolean>(false);
    const [opalPayload, setOpalPayload] = useState<OpalDataPayload>({ data: null, silent: false });
    const [savingState, setSavingState] = useState<SaveState|null>(null);
    const [selectedNode, setSelectedNode] = useState<any>(null);
    const { execState, loadGraph, start: startExecution, submitInput, reset: resetExecutor } = useGraphExecutor();

    const isDataFetchingRef = useRef(true);
    const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

    const setOpalData = useCallback((data: OpalJson | null, silent = false) => {
        setOpalPayload({ data: data, silent: silent });
    }, []);

    const toggleSidebar = () => {
        setSidebarShow(prev => !prev);
    };

    useEffect(() => {
        if (!id) return;
        setDataLoading(true);
        isDataFetchingRef.current = true;

        api.getAppData(id)
            .then((data: OpalJson) => {
                setDataLoading(false);
                setOpalData(data);
            })
            .catch((err: any) => {
                setDataLoading(false);
                console.error('opal data加载失败：', err);
            });
    }, [id]);

    useEffect(() => {
        const opalData = opalPayload.data;
        if (!opalData) return;

        if (isDataFetchingRef.current) {
            isDataFetchingRef.current = false;
            return;
        }

        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
        }

        autoSaveTimerRef.current = setTimeout(() => {
            console.log('自动保存数据...', opalData);
            setSavingState(SaveState.Pending);
            api.saveAppData(id, opalData).then(() => {
                setSavingState(SaveState.Saved);
            }).catch(() => {
                setSavingState(SaveState.Failed);
            });
        }, 500);

        return () => {
            if (autoSaveTimerRef.current) {
                clearTimeout(autoSaveTimerRef.current);
            }
        };
    }, [opalPayload, id]);

    return (
        <EditorContext.Provider value={{
            viewMode, setViewMode,
            sidebarShow, toggleSidebar,
            dataLoading, savingState,
            opalPayload, setOpalData,
            selectedNode, setSelectedNode,
            execState, loadGraph, startExecution, submitInput, resetExecutor,
        }}>
            {children}
        </EditorContext.Provider>
    );
}

export function useEditorContext() {
    const context = useContext(EditorContext);
    if (!context) {
        throw new Error('useEditorContext must be used within EditorProvider');
    }
    return context;
}
