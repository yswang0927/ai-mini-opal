import { app, protocol, BrowserWindow, shell, ipcMain, screen, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
const devUrl = process.env.VITE_DEV_SERVER_URL;
export const VITE_DEV_SERVER_URL = devUrl && devUrl.includes('localhost')
  ? devUrl.replace('localhost', '127.0.0.1')
  : devUrl;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST;

// 必须在 app ready 之前注册方案名称
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, stream: true } }
]);

// 集成embedded-python环境
const isPackaged: boolean = app.isPackaged;
const pythonDir: string = isPackaged
  ? path.join(process.resourcesPath, 'python')
  : path.join(process.env.APP_ROOT, 'python', 'runtime');

const pythonExe: string = process.platform === 'win32'
  ? path.join(pythonDir, 'python.exe')
  : path.join(pythonDir, 'bin', 'python3');

// 全局变量用来存放进程实例
let pyProcess: any = null;

function runOpalPythonServer() {
  const scriptPath: string = isPackaged
    ? path.join(process.resourcesPath, 'python', 'server', 'server.py')
    : path.join(process.env.APP_ROOT, 'python', 'server', 'server.py');

  // 启动 Python 子进程
  pyProcess = spawn(pythonExe, [scriptPath, "--port", "18765"]);

  // 接收 Python 的标准输出
  pyProcess.stdout.on('data', (data: any) => {
    //console.log(`OpalPythonServer: ${data.toString()}`);
  });

  // 接收 Python 的错误信息
  pyProcess.stderr.on('data', (data: any) => {
    //console.error(`OpalPythonServer: ${data.toString()}`);
  });

  pyProcess.on('close', (code: any) => {
    //console.log(`OpalPythonServer 进程退出，退出码: ${code}`);
    pyProcess = null;
  });
}

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
  // 获取主屏幕的工作区尺寸（不含任务栏等）
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const winWidth = Math.round(screenWidth * 0.9);
  const winHeight = Math.round(screenHeight * 0.9);

  win = new BrowserWindow({
    title: 'Mini Opal',
    width: winWidth,
    height: winHeight,
    autoHideMenuBar: VITE_DEV_SERVER_URL ? false : true,
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    webPreferences: {
      preload,
      // 保持上下文隔离开启，增强安全性
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
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

  // Auto update 临时不开启
  //update(win);
}

app.whenReady().then(() => {
  // 注册自定义的文件读取协议
  protocol.registerFileProtocol('local-file', (request, callback) => {
    // 转换为真实的磁盘绝对路径
    // 例如输入: local-file://C:/Users/Pic.jpg -> C:/Users/Pic.jpg
    const filePath = decodeURIComponent(request.url.replace('local-file://', ''));
    try {
      return callback({ path: path.normalize(filePath) });
    } catch (error) {
      //console.error('Failed to register protocol', error);
    }
  });

  createWindow();
  runOpalPythonServer();
});

// 监听 Electron 的退出事件，确保强杀 Python
app.on('will-quit', () => {
  if (pyProcess) {
    //console.log('Electron 正在关闭，正在杀死 Python 进程...');
    // Windows 下可能需要通过 taskkill 强杀，如果是标准信号通常 kill() 即可
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pyProcess.pid, '/f', '/t']);
    } else {
      pyProcess.kill('SIGTERM');
    }
  }
});

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
ipcMain.handle('read-file', async (_, filepath: string) => {
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
ipcMain.handle('write-file', async (_, filepath: string, content: string) => {
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
ipcMain.handle('delete-file', async (_, filepath: string) => {
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
        //console.error(`Failed to read ${file}:`, e);
      }
    }

    // 3. 按照修改时间降序排序 (b - a 表示降序，即最新的在前)
    apps.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    // 4. 如果不需要把 mtime 返回给前端，可以在这里将其清理掉（可选）
    return apps.map(({ mtime, ...appData }) => appData);

  } catch (e) {
    //console.error('Failed to list apps:', e);
    return [];
  }
});

// 通用文件保存：弹出系统"另存为"对话框并将内容写入用户选择的路径。
// content 为 string 时按 utf-8 文本写入；为 Uint8Array 时按二进制写入（图片、二进制文件等）。
ipcMain.handle('save-as-file', async (event, defaultFileName: string, content: string | Uint8Array) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) ?? win ?? undefined;

  // 依据文件扩展名生成对话框过滤器
  const ext = path.extname(defaultFileName).replace(/^\./, '').toLowerCase();
  const filters = ext
    ? [
        { name: `${ext.toUpperCase()} 文件`, extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ]
    : [{ name: '所有文件', extensions: ['*'] }];

  const { canceled, filePath } = await dialog.showSaveDialog(senderWin as BrowserWindow, {
    title: '保存文件',
    defaultPath: defaultFileName,
    filters,
  });

  if (canceled || !filePath) {
    return { success: false, canceled: true };
  }

  try {
    if (typeof content === 'string') {
      await fs.writeFile(filePath, content, 'utf-8');
    } else {
      await fs.writeFile(filePath, Buffer.from(content));
    }
    return { success: true, filePath };
  } catch (e) {
    //console.error('Failed to save file:', e);
    return { success: false, error: String(e) };
  }
});
