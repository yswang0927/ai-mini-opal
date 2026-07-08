import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Plus, FileText, X } from 'lucide-react'
import { api, type AppData } from '@/utils/Api'

export default function Home() {
  const navigate = useNavigate();
  const [apps, setApps] = useState<AppData[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<any>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadApps();
    //loadSettings();
  }, [])

  const loadApps = async () => {
    try {
      const apps = await api.listApps();
      setApps(apps);
    } catch (e) {
      console.error('Failed to load apps:', e);
    }
  }

  const loadSettings = async () => {
    try {
      const config = await api.loadSettings();
      setSettings(config);
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  const handleCreateApp = async () => {
    setLoading(true);
    try {
      const id = await api.createApp();
      navigate(`/editor/${id}`);
    } catch (e) {
      console.error('Failed to create app:', e);
    } finally {
      setLoading(false);
    }
  }

  const handleOpenApp = (id: string) => {
    navigate(`/editor/${id}`);
  }

  const handleSaveSettings = async () => {
    try {
      await api.saveSettings(settings);
      setIsSettingsOpen(false);
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">MiniOpal</h1>
        </div>
        <button
          onClick={() => setIsSettingsOpen(true)}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <Settings className="w-5 h-5 text-gray-600" />
        </button>
      </header>

      {/* Body */}
      <main className="flex-1 p-8 overflow-auto">
        <div className="max-w-6xl mx-auto">
          {/* Create Button */}
          <div className="mb-6">
            <button
              onClick={handleCreateApp}
              disabled={loading}
              className="flex items-center"
            >
              <Plus className="w-5 h-5" />
              {loading ? 'Creating...' : '+ Create New App'}
            </button>
          </div>

          {/* Card Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {apps.map((app) => (
              <div
                key={app.id}
                onClick={() => handleOpenApp(app.id)}
                className="bg-white rounded-xl border border-gray-200 p-6 cursor-pointer hover:shadow-lg hover:border-blue-300 transition-all"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                    <FileText className="w-5 h-5 text-white" />
                  </div>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{app.title}</h3>
                <p className="text-gray-600 text-sm line-clamp-2">
                  {app.description || 'No description'}
                </p>
              </div>
            ))}
          </div>

          {apps.length === 0 && !loading && (
            <div className="text-center py-16">
              <FileText className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No apps yet</h3>
              <p className="text-gray-500">Create your first app to get started</p>
            </div>
          )}
        </div>
      </main>

      {/* Settings Dialog */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">LLM Settings</h2>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Base URL
                </label>
                <input
                  type="text"
                  value={settings?.baseUrl}
                  onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  API Key
                </label>
                <input
                  type="password"
                  value={settings?.apiKey}
                  onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  placeholder="sk-..."
                />
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-200">
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSettings}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
