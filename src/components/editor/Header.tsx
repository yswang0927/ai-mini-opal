import {
    ArrowLeft,
    CloudUpload,
    Share2,
    EllipsisVertical,
    PanelRightClose,
    PanelRightOpen
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEditorContext } from './EditorContext';

export default function Header() {
    const navigate = useNavigate();
    const { sidebarShow, toggleSidebar, viewMode, setViewMode } = useEditorContext();

    return (
        <div className="editor-header">
            <div className="editor-header-left">
                <button className="nav-back" onClick={() => navigate('/')}><ArrowLeft size={20} strokeWidth={1.25} /></button>
                <input type="text" className="nav-title-input" autoComplete="off" required placeholder="Untitled app" />
            </div>
            <div className="editor-header-center">
                <div className="editor-header-btn-group">
                    <button className={viewMode === 'editor' ? 'selected' : ''} onClick={() => setViewMode('editor')}>Editor</button>
                    <button className={viewMode === 'app' ? 'selected' : ''} onClick={() => setViewMode('app')}>App</button>
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
