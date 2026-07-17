import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings, Plus } from 'lucide-react';
import { 
  Alert,
  Button, 
  Card, 
  Elevation, 
  PopoverNext, 
  Menu, 
  MenuItem, 
  MenuDivider,
  Tooltip,
  Intent
} from "@blueprintjs/core";
import { api } from '@/utils/Api';
import { type AppData, validateOpalJson, OpalJsonValidationError } from '@/types';
import { Logo, Spinner } from '@/utils/icons';
import { downloadFile, AppToaster } from "@/utils";
import { useL10n } from "@/l10n";

import './home.css';

type ActionType = 'delete' | 'duplicate' | 'rename' | 'pin' | 'export';

export default function Home() {
  const { t } = useL10n();
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppData[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // 用于菜单操作的状态
  const [activeApp, setActiveApp] = useState<AppData|null>(null);
  const [activeAction, setActiveAction] = useState<ActionType|null>(null);

  const loadApps = async () => {
    try {
      const apps = await api.listApps();
      setApps(apps);
    } catch (e) {
      console.error('Failed to load apps:', e);
    }
  };

  const handleCreateApp = async () => {
    setCreating(true);
    try {
      const id = await api.createApp();
      navigate(`/editor/${id}`);
    } catch (e) {
      console.error('Failed to create app:', e);
    } finally {
      setCreating(false);
    }
  };

  const handleOpenApp = (id: string) => {
    navigate(`/editor/${id}`);
  };

  const handleDeleteApp = async (id: string) => {
    if (!id) return;
    try {
      await api.deleteApp(id);
      setApps(prevApps => prevApps.filter(app => app.id !== id));
    } catch (e) {
      console.error('Failed to delete app:', e);
    }
  };

  const handleDuplicateApp = async (id: string) => {
    if (!id) return;
    try {
      await api.duplicateApp(id);
      loadApps();
    } catch (e) {
      console.error('Failed to duplicate app:', e);
    }
  };

  const handleExportApp = async (app: AppData) => {
    if (!app) return;
    const filename = `${(app.title || 'Untitled-app').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    try {
      const appContent = JSON.stringify(await api.getAppData(app.id));
      const result = await downloadFile(filename, appContent);
      if (result.success) {
        (await AppToaster).show({
          message: `「${filename}」${t("已导出")} ${result.filePath ? (': '+result.filePath) : ''}`, 
          intent: Intent.SUCCESS 
        });
      }
      else if (!result.canceled) {
        (await AppToaster).show({
          message: `「${filename}」${t('导出失败')}: ${result.error}`, 
          intent: Intent.DANGER 
        });
      }
    } catch (e) {
      console.error(`「${filename}」${t("导出失败")}`, e);
      (await AppToaster).show({
        message: `「${filename}」${t("导出失败")}`, 
        intent: Intent.DANGER 
      });
    }
  };
  
  const handleImportApp = () => {
    // 打开文件选择窗口，仅接受 .json
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const fileName = `「${file.name}」`;
      try {
        const text = await file.text();
        // 解析并按 OpalJson 格式严格校验，不合法会抛 OpalJsonValidationError
        const appData = validateOpalJson(JSON.parse(text));
        const newAppId = await api.createApp();
        const ok = await api.saveAppData(newAppId, appData);
        if (!ok) throw new Error('save failed');
        (await AppToaster).show({ message: `${fileName} ${t('已导入')}`, intent: Intent.SUCCESS });
        loadApps();
      } catch (e) {
        console.error('Failed to import app:', e);
        // 校验失败时展示具体不符合的字段，其它错误用通用提示
        const message = e instanceof OpalJsonValidationError
          ? `${fileName} ${t('导入失败')}: ${e.message}`
          : `${fileName} ${t('导入失败')}`;
        (await AppToaster).show({ message, intent: Intent.DANGER });
      }
    };
    input.click();
  };

  const openAction = (app: AppData, action: ActionType) => {
    setActiveApp(app);
    setActiveAction(action);

    if ('duplicate' === action) {
      handleDuplicateApp(app.id);
      closeAction();
    }
    else if ('export' === action) {
      handleExportApp(app);
    }
  };

  const closeAction = () => {
    setActiveApp(null);
    setActiveAction(null);
  };

  useEffect(() => {
    loadApps();
  }, []);

  return (
    <div>
      {/* Header */}
      <header className="home-header flex items-center justify-between blur">
        <div className="flex items-center gap-md">
          <div className="flex items-center justify-center logo-wrapper">
            <Logo />
          </div>
          <div className="home-logoname">MiniOpal</div>
        </div>

        <div>
          <Tooltip content="打开设置" placement="bottom">
            <Button variant="minimal" icon="cog" onClick={() => setIsSettingsOpen(true)} />
          </Tooltip>
        </div>
      </header>

      {/* Body */}
      <main className="gallery-wrapper">
        <div>
          <h1 className="text-center">{t('使用自然语言构建、编辑和分享迷你AI应用')}</h1>

          <div className="flex padding-md justify-end gap-md">
            <Button className="create-new-app"
              onClick={handleCreateApp}
              size="medium"
              disabled={creating}
            >
              <span className="bp6-icon"> { creating ? <Spinner /> : <Plus size={16} strokeWidth={2} /> }</span>
              <span className="bp6-button-text">{t('创建新应用')}</span>
            </Button>

            <Button onClick={handleImportApp} variant="minimal" icon="import" text="导入应用" />
          </div>

          {/* Card Grid */}
          <div className="gallery-grid">
            {apps.map((app) => (
              <Card className="app-board"
                key={app.id}
                interactive={true}
                elevation={Elevation.TWO}
                onClick={() => handleOpenApp(app.id)}
              >
                <div className="flex items-center justify-center board-thumbnail">
                  <Logo/>
                </div>
                
                <div className="board-info">
                  <div className="board-title">{app.title}</div>
                  <div className="board-desc">{app.description || 'No description'}</div>
                </div>

                <div className="board-actions" onClick={(e) => e.stopPropagation()}>
                  <PopoverNext placement='bottom' content={
                    <Menu>
                      <MenuItem icon="duplicate" text={t('复制副本')} onClick={() => openAction(app, 'duplicate')} />
                      <MenuItem icon="export" text={t('导出')} onClick={() => openAction(app, 'export')} />
                      <MenuDivider />
                      <MenuItem icon="trash" text={t('删除')} intent="danger" onClick={() => openAction(app, 'delete')} />
                    </Menu>
                  }>
                    <Button variant="minimal" icon="more" />
                  </PopoverNext>

                </div>
              </Card>
            ))}
          </div>

          {apps.length === 0 && !creating && (
            <div className="text-center padding-lg">
              <h3>{t('尚未有应用')}</h3>
              <p>{t('创建你的首个应用，即刻开始上手')}</p>
            </div>
          )}
        </div>
      </main>
      
      <Alert
        canEscapeKeyCancel={true}
        canOutsideClickCancel={true}
        cancelButtonText={t('取消')}
        confirmButtonText={t('删除')}
        icon="trash"
        intent="danger"
        isOpen={activeAction === 'delete' && activeApp !== null}
        onCancel={closeAction}
        onConfirm={() => {
          handleDeleteApp(activeApp?.id || '');
          closeAction();
        }}
      >
        <p>{t('确定要删除应用 [{name}] 吗? 删除后将无法恢复。', {'name': activeApp?.title || ''})}</p>
      </Alert>
    </div>
  )
}
