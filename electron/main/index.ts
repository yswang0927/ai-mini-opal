import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { update } from './update';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..');

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron');
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist');
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

// Disable GPU Acceleration for Windows 7
if (process.platform === 'win32' && os.release().startsWith('6.1')) {
  app.disableHardwareAcceleration();
}

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') {
  app.setAppUserModelId(app.getName());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
const preload = path.join(__dirname, '../preload/index.mjs');
const indexHtml = path.join(RENDERER_DIST, 'index.html');

async function createWindow() {
  win = new BrowserWindow({
    title: 'Main window',
    width: 1400,
    height: 800,
    autoHideMenuBar: VITE_DEV_SERVER_URL ? false : true,
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      // 保持上下文隔离开启，增强安全性
      contextIsolation: true, 
      nodeIntegration: false,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    // Open devTool if the app is not packaged
    win.webContents.openDevTools();
  } else {
    win.loadFile(indexHtml);
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' }
  });

  // Auto update
  update(win);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  win = null;
  if (process.platform !== 'darwin') {
    app.quit();
  }
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
})

// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`);
  } else {
    childWindow.loadFile(indexHtml, { hash: arg });
  }
})

// Get data directory (base path for all files)
ipcMain.handle('get-data-dir', async () => {
  return app.getPath('userData');
});

// Read file (relative to userData)
ipcMain.handle('read_file', async (_, filepath: string) => {
  const userDataPath = app.getPath('userData')
  const fullPath = path.join(userDataPath, filepath)
  // Ensure directory exists
  const dir = path.dirname(fullPath)
  await fs.mkdir(dir, { recursive: true })

  // Check if file exists using existsSync - simple and straightforward
  if (!existsSync(fullPath)) {
    return null
  }

  // File exists, read it
  try {
    return await fs.readFile(fullPath, 'utf-8')
  } catch (e) {
    // If reading fails for any reason, return null
    return null
  }
});

// Write file (relative to userData)
ipcMain.handle('write_file', async (_, filepath: string, content: string) => {
  const userDataPath = app.getPath('userData');
  const fullPath = path.join(userDataPath, filepath);
  // Ensure directory exists
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(fullPath, content, 'utf-8');
    return true;
  } catch (e) {
    throw new Error(`Failed to write file ${filepath}: ${e}`);
  }
});

// Delete file (relative to userData)
ipcMain.handle('delete_file', async (_, filepath: string) => {
  const userDataPath = app.getPath('userData')
  const fullPath = path.join(userDataPath, filepath)
  try {
    if (existsSync(fullPath)) {
      await fs.unlink(fullPath);
    }
    return true;
  } catch (e) {
    throw new Error(`Failed to delete file ${filepath}: ${e}`);
  }
});

// List all JSON files in apps directory
ipcMain.handle('list-apps', async () => {
  const userDataPath = app.getPath('userData');
  const appsDir = path.join(userDataPath, 'apps');
  
  // Ensure apps directory exists
  await fs.mkdir(appsDir, { recursive: true });
  
  try {
    const files = await fs.readdir(appsDir);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    const apps = [];
    
    for (const file of jsonFiles) {
      const filePath = path.join(appsDir, file);
      try {
        // 1. 同时获取文件内容和文件状态（包含修改时间）
        const [content, stat] = await Promise.all([
          fs.readFile(filePath, 'utf-8'),
          fs.stat(filePath)
        ]);
        
        const data = JSON.parse(content);
        apps.push({
          id: file.replace('.json', ''),
          title: data.title || 'Untitled App',
          description: data.description || '',
          mtime: stat.mtime // 2. 保存修改时间用于排序
        });
      } catch (e) {
        console.error(`Failed to read ${file}:`, e);
      }
    }
    
    // 3. 按照修改时间降序排序 (b - a 表示降序，即最新的在前)
    apps.sort((a, b) => b.mtime - a.mtime);
    
    // 4. 如果不需要把 mtime 返回给前端，可以在这里将其清理掉（可选）
    return apps.map(({ mtime, ...appData }) => appData);
    
  } catch (e) {
    console.error('Failed to list apps:', e);
    return [];
  }
});
