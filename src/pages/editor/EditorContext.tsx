import React, {createContext, useContext, useEffect, useRef, useState} from 'react';
import type {ExecutionState} from '@/components/graph/executor';
import {useGraphExecutor} from '@/components/graph/executor';
import {type OpalJson, SaveState} from '@/types';
import {api} from '@/utils/Api';

type ViewMode = 'editor' | 'app';

type EditorContextValue = {
    sidebarShow: boolean;
    toggleSidebar: () => void;
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    opalData: OpalJson | null;
    setOpalData: (data: OpalJson | null) => void;
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
    const [opalData, setOpalData] = useState<OpalJson | null>(null);
    const [savingState, setSavingState] = useState<SaveState|null>(null);
    const [selectedNode, setSelectedNode] = useState<any>(null);
    const { execState, loadGraph, start: startExecution, submitInput, reset: resetExecutor } = useGraphExecutor();

    // 用来标记是否是用户引起的“真正修改”
    const isFirstFetched = useRef(true);
    const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

    const toggleSidebar = () => {
        setSidebarShow(prev => !prev);
    };

    // 根据 id 获取远程数据
    useEffect(() => {
        if (!id) return;

        setDataLoading(true);
        // 每次切换 id 时，重置标记为 true，因为换了新文件，第一次赋值属于“加载”而非“修改”
        isFirstFetched.current = true;

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

    // 自动保存逻辑（防抖：数据停止变化 1 秒后自动保存）
    useEffect(() => {
        if (!opalData) return;

        // 如果是第一次加载引发的赋值，直接跳过，并将标记设为 false
        if (isFirstFetched.current) {
            isFirstFetched.current = false;
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
            }).catch((err: any) => {
                setSavingState(SaveState.Failed);
            });
        }, 1000);

        return () => {
            if (autoSaveTimerRef.current) {
                clearTimeout(autoSaveTimerRef.current);
            }
        };
    }, [opalData, id]);

    return (
        <EditorContext.Provider value={{
            viewMode, setViewMode,
            sidebarShow, toggleSidebar,
            dataLoading, savingState,
            opalData, setOpalData,
            selectedNode, setSelectedNode,
            execState, loadGraph, startExecution, submitInput, resetExecutor,
        }}
        >
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
