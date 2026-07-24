import { ipcRenderer, contextBridge, webUtils } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // You can expose other APTs you need here.
  // ...
})

interface App {
  id: string
  title: string
  description: string
  thumbnailUrl?: string
  tags?: string[]
}

contextBridge.exposeInMainWorld('electronAPI', {
  readFile: (filepath: string): Promise<string | null> => ipcRenderer.invoke('read-file', filepath),
  writeFile: (filepath: string, content: string): Promise<boolean> => ipcRenderer.invoke('write-file', filepath, content),
  deleteFile: (filepath: string): Promise<boolean> => ipcRenderer.invoke('delete-file', filepath),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('get-data-dir'),
  listApps: (): Promise<App[]> => ipcRenderer.invoke('list-apps'),
  // Electron 已移除 File.path,通过 webUtils 从 File 对象取本地磁盘物理绝对路径(无需上传)。
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  // 通用文件保存：弹出系统"另存为"对话框并写入文件（文本或二进制）
  saveAsFile: (defaultFileName: string, content: string | Uint8Array): Promise<SaveFileResult> =>
    ipcRenderer.invoke('save-as-file', defaultFileName, content),
  // 读取 server.log 内容（返回末尾片段及日志文件路径）
  readLog: (): Promise<LogResult> => ipcRenderer.invoke('read-log'),
  // 打开独立的日志查看器窗口
  openLogWindow: (): Promise<void> => ipcRenderer.invoke('open-log-window'),
})

interface LogResult {
  path: string
  content: string
  error?: string
}

interface SaveFileResult {
  success: boolean
  filePath?: string
  canceled?: boolean
  error?: string
}

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}


function useLoading() {
  const className = `loaders-css-spin`
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 64px;
  height: 64px;
  color: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}">
    <div><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 656 656" fill="currentColor"><path d="M350.128 130.315C371.01 73.798 410.053 38.597 469.73 29.82c82.06-12.069 154.606 42.807 167.727 125.137 10.948 68.702-29.46 137.445-94.98 161.58-3.124 1.152-6.277 2.23-9.368 3.467-7.367 2.949-11.23 8.472-11.006 15.58.21 6.68 4.47 11.92 12.035 14.18 28.81 8.612 52.644 24.703 71.562 47.949 20.829 25.593 32.231 54.958 33.658 87.988 1.862 43.09-12.577 80.163-42.636 110.856-23.578 24.076-52.36 39.05-85.838 43.352-43.812 5.63-82.93-6.629-116.546-35.008-25.745-21.733-42.278-49.396-48.764-82.738-1.36-6.996-5.493-10.88-11.576-11.051-6.425-.181-10.455 3.21-12.006 10.901-6.156 30.528-20.518 56.625-43.18 77.79-32.575 30.426-71.004 45.136-115.929 40.61-65.59-6.608-118.145-53.628-131.907-117.825-13.355-62.29 18.752-130.297 75.362-159.913 13.845-7.243 28.339-12.377 43.739-15.004 7.346-1.253 11.454-5.63 11.636-12.189.177-6.41-3.704-11.12-11.249-12.376-30.44-5.066-56.305-18.943-78.144-40.443-22.91-22.555-37.135-49.886-42.336-81.544-6.152-37.445.416-72.81 21.076-104.776C75.44 58.623 110.1 35.88 154.796 29.633c49.894-6.972 92.379 8.546 127.501 44.243 18.654 18.96 30.189 42.067 36.991 67.638.641 2.411 1.19 4.856 1.989 7.215 1.943 5.74 6.738 9.195 12.37 9.076 5.615-.12 10.226-3.848 11.826-9.736 1.57-5.777 3.012-11.588 4.655-17.754M73.99 554.544c27.887 42.457 66.873 63.691 117.78 57.762 39.964-4.654 69.336-27.312 90.03-61.371 7.173-11.806 10.492-25.06 13.866-38.348 4.853-19.118 22.742-31.033 42.286-28.977 18.198 1.914 31.124 14.093 35.02 33.792 4.797 24.25 16.562 44.474 34.545 61.138 29.948 27.75 65.086 40.216 105.626 32.666 61.069-11.374 108.162-72.594 96.65-137.514-5.555-31.326-20.646-56.943-45.317-77.011-11.44-9.306-24.53-15.14-38.453-19.647-31.614-10.235-42.278-44.721-21.96-70.157 6.689-8.374 16.13-12.053 25.762-15.45 17.411-6.14 32.955-15.457 45.697-28.78 27.145-28.38 39.064-62.203 34.162-101.4-3.702-29.609-16.876-54.562-39.167-74.353-26.865-23.852-58.35-33.916-94.147-29.673-30.585 3.625-56.152 17.044-76.298 40.35-14.5 16.774-22.396 36.757-27.574 58.094-4.33 17.846-19.538 29.92-38.196 30.248-17.187.302-33.229-9.929-38.854-26.133-1.524-4.388-2.6-8.935-3.808-13.429-16.158-60.109-72.68-98.012-133.704-88.79-71.92 10.87-113.126 79.666-99.01 144.437 10.73 49.234 48.32 84.774 97.777 93.728 18.995 3.439 31.34 16.959 32.885 37.378 1.116 14.749-6.088 32.822-25.745 39.818-5.145 1.831-10.614 2.774-15.958 4.024C74.6 394.076 30.961 482.03 73.99 554.544z"/><path d="M412.174 377.243c-22.6 15.308-47.504 23.031-74.019 26.106-15.526 1.801-31.204 2.506-46.427 6.443-32.524 8.412-56.057 27.429-69.61 58.538-5.851 13.432-12.479 26.525-18.597 39.845-1.381 3.007-3.266 4.172-6.55 4.135-12.664-.142-25.331-.055-37.997-.093-6.014-.018-6.4-.548-3.853-5.853a81642.517 81642.517 0 0 1 52.42-108.988c22.637-46.967 45.333-93.907 67.952-140.883 5.606-11.64 11.77-22.747 22.591-30.592 28.5-20.663 69.722-11.414 85.907 19.814 10.19 19.659 19.562 39.74 29.354 59.606 1.152 2.335 1.818 5.006 3.94 6.773 2.416-.378 3.244-2.37 4.364-3.935 6.747-9.423 11.85-19.688 15.237-30.765 1.15-3.76 2.825-5.017 6.88-3.6a620.82 620.82 0 0 0 30.432 9.774c4.344 1.271 4.827 3.025 3.34 7.145-12.82 35.501-33.81 64.766-65.364 86.53M294.85 315.258l-26.75 55.25c2.493 1.607 4.074.97 5.663.504 18.153-5.314 36.916-6.553 55.601-8.303 17.94-1.68 34.873-6.597 50.694-15.346 3.79-2.096 4.198-4.35 2.365-8.08-11.74-23.892-23.276-47.883-34.984-71.79-3.863-7.887-8.699-10.299-17.39-9.324-6.117.686-9.85 4.36-12.378 9.628-7.484 15.601-14.973 31.2-22.82 47.46zM433.954 383.953c3.715-3.527 7.164-6.82 11.354-10.821l67.673 137.34c-1.792 2.155-3.393 1.75-4.821 1.755-12.489.037-24.979-.094-37.465.09-3.757.055-5.673-1.522-7.243-4.747a22990.782 22990.782 0 0 0-50.945-104.027c-1.622-3.29-1.195-4.952 2.167-6.567 6.93-3.328 13.13-7.848 19.28-13.023z"/></svg></div>
  </div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle)
      safeDOM.remove(document.body, oDiv)
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 3000)