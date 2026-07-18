import { useEffect, useState, useCallback } from 'react';
import {
    ArrowLeft,
    Share2,
    EllipsisVertical,
    PanelRightClose,
    PanelRightOpen
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Tooltip } from "@blueprintjs/core";
import { useEditorContext } from './EditorContext';
import { useL10n } from "@/l10n";
import { SaveState } from '@/types';

export default function Header() {
    const { t } = useL10n();
    const navigate = useNavigate();
    const { sidebarShow, toggleSidebar, viewMode, setViewMode, opalPayload, setOpalData, savingState } = useEditorContext();
    const opalData = opalPayload.data;
    const [title, setTitle] = useState('Untitled app');

    useEffect(() => {
        setTitle(opalData?.title || 'Untitled app');
    }, [opalData?.title]);

    const handleTitleChanged = () => {
        if (title.trim()) {
            setOpalData({...opalData!, title: title});
        }
    };

    return (
        <div className="editor-header">
            <div className="editor-header-left">
                <button className="nav-back" onClick={() => navigate('/')}><ArrowLeft size={20} strokeWidth={1.25} /></button>
                <div className="flex-1">
                    <input type="text" className="nav-title-input" autoComplete="off" required placeholder="Untitled app" 
                        value={title} 
                        onChange={(e) => setTitle(e.target.value)} 
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                (e.target as HTMLInputElement).blur();
                            }
                        }} 
                        onBlur={handleTitleChanged}
                        />
                </div>
            </div>
            <div className="editor-header-center">
                <div className="editor-header-btn-group">
                    <button className={viewMode === 'editor' ? 'selected' : ''} onClick={() => setViewMode('editor')}>{t('画布')}</button>
                    <button className={viewMode === 'app' ? 'selected' : ''} onClick={() => setViewMode('app')}>{t('应用')}</button>
                </div>
            </div>
            <div className="editor-header-right">
                <div style={{ fontSize: "var(--font-size-sm)", color: (SaveState.Failed === savingState)?'#cc0000':'inherit' }}>
                    { (SaveState.Pending === savingState)
                        ? t('保存中...')
                        : ((SaveState.Saved === savingState)
                            ? t('已保存')
                            : ((SaveState.Failed === savingState) ? t('保存失败') : ''))
                    }
                </div>
                <button className="nav-share" disabled><Share2 size={18} strokeWidth={1.5} /> <span>{t('分享')}</span></button>
                {/*<button><EllipsisVertical size={18} strokeWidth={1.5} /></button>*/}
                <div style={{marginLeft: '0.5rem'}}>
                    <Tooltip content={sidebarShow ? t("收起侧边栏") : t("展开侧边栏")} placement="bottom-end">
                    <button onClick={toggleSidebar}>{ (sidebarShow ? <PanelRightClose size={18} strokeWidth={1.5} /> : <PanelRightOpen size={18} strokeWidth={1.5} />) }</button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
