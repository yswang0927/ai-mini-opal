import { useEffect, useRef } from 'react';
import ChatGraph from '@/components/graph/ChatGraph';
import { LayoutResizer } from '@/utils/util';
import { EditorProvider, useEditorContext } from './EditorContext';
import Header from './Header';
import Sidebar from './Sidebar';

import "./style.css";

export default function ChatGraphEditor() {
    return (
        <EditorProvider>
            <ChatGraphEditorContent />
        </EditorProvider>
    );
};

function ChatGraphEditorContent() {
    const { sidebarShow } = useEditorContext();
    const sidebarRef = useRef<HTMLDivElement | null>(null);
    const resizerRef = useRef<LayoutResizer>(null);

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

    return (
        <div className="opal-editor">
            <div className="layout-header">
                <Header />
            </div>

            <div className="layout-body">
                <div className="layout-main">
                    <ChatGraph />
                </div>

                <div ref={sidebarRef} className={`layout-sidebar${sidebarShow ? '' : ' is-hidden'}`}>
                    <div className="layout-resizer" data-region="right" data-min="300" data-max="1200"></div>
                    <div className="layout-sidebar-body">
                        <Sidebar />
                    </div>
                </div>
            </div>
        </div>
    );
}
