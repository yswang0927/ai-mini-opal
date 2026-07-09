import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings, Plus } from 'lucide-react';
import { Button, Card, Elevation } from "@blueprintjs/core";
import { api } from '@/utils/Api';
import { type AppData } from '@/types';
import { Logo, Spinner } from '@/utils/icons';
import { useL10n } from "@/l10n";

import './home.css';

export default function Home() {
  const { t } = useL10n();
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppData[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadApps = async () => {
    try {
      const apps = await api.listApps();
      setApps(apps);
    } catch (e) {
      console.error('Failed to load apps:', e);
    }
  }

  useEffect(() => {
    loadApps();
  }, [])

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

  return (
    <div>
      {/* Header */}
      <header className="home-header flex items-center justify-between">
        <div className="flex items-center gap-md">
          <div className="flex items-center justify-center logo-wrapper">
            <Logo />
          </div>
          <div className="home-logoname">MiniOpal</div>
        </div>

        <div>
          <Button variant="minimal" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={20} strokeWidth={1.5} />
          </Button>
        </div>
      </header>

      {/* Body */}
      <main className="gallery-wrapper">
        <div>
          <h1 className="text-center">{t('使用自然语言构建、编辑和分享迷你AI应用')}</h1>

          <div className="flex padding-md justify-end">
            <Button className="create-new-app"
              onClick={handleCreateApp}
              disabled={creating}
            >
              <span className="bp6-icon"> { creating ? <Spinner /> : <Plus size={16} strokeWidth={2} /> }</span>
              <span className="bp6-button-text">{t('创建新应用')}</span>
            </Button>
          </div>

          {/* Card Grid */}
          <div>
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
                </Card>
              ))}
            </div>
          </div>

          {apps.length === 0 && !creating && (
            <div className="text-center padding-lg">
              <h3>{t('尚未有应用')}</h3>
              <p>{t('创建你的首个应用，即刻开始上手')}</p>
            </div>
          )}
        </div>
      </main>
      
    </div>
  )
}
