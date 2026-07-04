import { useState } from 'react';
import { 
    ArrowLeft, 
    CloudUpload, 
    Share2, 
    EllipsisVertical, 
    PanelRightClose, 
    PanelRightOpen 
} from 'lucide-react';
import { useEditorContext } from './EditorContext';

export default function Header() {
    const [selectedTab, setSelectedTab] = useState('Editor');
    const { sidebarShow, toggleSidebar } = useEditorContext();

    return (
        <div className="editor-header">
            <div className="editor-header-left">
                <button className="nav-back"><ArrowLeft size={20} strokeWidth={1.25} /></button>
                <input type="text" className="nav-title-input" autoComplete="off" required placeholder="Untitled app" />
            </div>
            <div className="editor-header-center">
                <div className="editor-header-btn-group">
                    <button className={selectedTab === 'Editor' ? 'selected' : ''} onClick={() => setSelectedTab('Editor')}>Editor</button>
                    <button className={selectedTab === 'App' ? 'selected' : ''} onClick={() => setSelectedTab('App')}>App</button>
                </div>
            </div>
            <div className="editor-header-right">
                <div style={{ fontSize: "var(--font-size-sm)" }}>Saved</div>
                <button className="nav-publish"><CloudUpload size={18} strokeWidth={1.5} /> <span>发布</span></button>
                <button className="nav-share"><Share2 size={18} strokeWidth={1.5} /> <span>分享</span></button>
                <button><EllipsisVertical size={18} strokeWidth={1.5} /></button>
                <div style={{marginLeft: '0.5rem'}}>
                    <button onClick={toggleSidebar}>{ (sidebarShow ? <PanelRightClose size={18} strokeWidth={1.5} /> : <PanelRightOpen size={18} strokeWidth={1.5} />) }</button>
                </div>
            </div>
        </div>
    );
}
