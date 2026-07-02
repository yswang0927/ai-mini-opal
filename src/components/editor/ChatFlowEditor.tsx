import { useEffect, useRef } from 'react';
import ChatFlow from '@/components/flow/ChatFlow';
import { LayoutResizer } from '@/utils/util';

import "./editor.css";

export default function ChatFlowEditor() {

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
        <div className="flow-editor">
            <div className="flow-editor-header">
                <div className="flow-editor-header-left"></div>
                <div className="flow-editor-header-center">
                    <div className="flow-editor-header-btn-group">
                        <button className="selected">Editor</button>
                        <button>App</button>
                    </div>
                </div>
                <div className="flow-editor-header-right"></div>
            </div>

            <div className="flow-editor-body">
                <div className="flow-editor-main">
                    <ChatFlow />
                </div>

                <div ref={sidebarRef} className="flow-editor-sidebar">
                    <div className="layout-resizer" data-region="right" data-min="300" data-max="1200"></div>
                    <div className="flow-editor-sidebar-body"></div>
                </div>
            </div>
        </div>
    );

};