import { createContext, useContext, useState, type ReactNode } from 'react';

type ViewMode = 'editor' | 'app';

type EditorContextValue = {
    sidebarShow: boolean;
    toggleSidebar: () => void;
    selectedNode: any;
    setSelectedNode: (node: any) => void;
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
};

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: ReactNode }) {
    const [sidebarShow, setSidebarShow] = useState(true);
    const [selectedNode, setSelectedNode] = useState<any>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('editor');

    const toggleSidebar = () => {
        setSidebarShow(prev => !prev);
    };

    return (
        <EditorContext.Provider value={{ 
            sidebarShow, 
            toggleSidebar, 
            selectedNode, 
            setSelectedNode, 
            viewMode, setViewMode 
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
