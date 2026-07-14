interface App {
  id: string
  title: string
  description: string
  thumbnailUrl?: string
  tags?: string[]
}

interface ElectronAPI {
  listApps: () => Promise<App[]>
  readFile: (filepath: string) => Promise<string | null>
  writeFile: (filepath: string, content: string) => Promise<boolean>
  deleteFile: (filepath: string) => Promise<boolean>
  getDataDir: () => Promise<string>
  getPathForFile: (file: File) => string
}

interface Window {
  electronAPI: ElectronAPI
}
