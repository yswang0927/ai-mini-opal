import { useEffect, useState } from 'react';
import {
    ArrowLeft,
    Share2,
    EllipsisVertical,
    PanelRightClose,
    PanelRightOpen
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useEditorContext } from './EditorContext';
import { useL10n } from "@/l10n";
import type { OpalJson } from '@/types';

export default function Header() {
    const { t } = useL10n();
    const navigate = useNavigate();
    const { sidebarShow, toggleSidebar, viewMode, setViewMode, graphData } = useEditorContext();
    const [title, setTitle] = useState('Untitled app');

    useEffect(() => {
        setTitle(graphData?.title || 'Untitled app');
    }, [graphData]);

    return (
        <div className="editor-header">
            <div className="editor-header-left">
                <button className="nav-back" onClick={() => navigate('/')}><ArrowLeft size={20} strokeWidth={1.25} /></button>
                <input type="text" className="nav-title-input" autoComplete="off" required placeholder="Untitled app" 
                    value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="editor-header-center">
                <div className="editor-header-btn-group">
                    <button className={viewMode === 'editor' ? 'selected' : ''} onClick={() => setViewMode('editor')}>{t('画布')}</button>
                    <button className={viewMode === 'app' ? 'selected' : ''} onClick={() => setViewMode('app')}>{t('应用')}</button>
                </div>
            </div>
            <div className="editor-header-right">
                <div style={{ fontSize: "var(--font-size-sm)" }}>{t('已保存')}</div>
                <button className="nav-share"><Share2 size={18} strokeWidth={1.5} /> <span>{t('分享')}</span></button>
                <button><EllipsisVertical size={18} strokeWidth={1.5} /></button>
                <div style={{marginLeft: '0.5rem'}}>
                    <button onClick={toggleSidebar}>{ (sidebarShow ? <PanelRightClose size={18} strokeWidth={1.5} /> : <PanelRightOpen size={18} strokeWidth={1.5} />) }</button>
                </div>
            </div>
        </div>
    );
}
