import { v4 as uuidv4 } from 'uuid';
import { type AppData } from '@/types';

const SETTINGS_FILE = "settings.json";

// Python 执行器服务基地址
export const SERVER_BASE_URL = "http://127.0.0.1:18765";

const getUUID = () => {
  //return uuidv4().replace(/-/g, '');
  return uuidv4();
};

class Api {

  /**
   * 获取应用列表
   */
  async listApps(): Promise<AppData[]> {
    try {
      return await window.electronAPI.listApps();
    } catch(e) {
      return [];
    }
  }

  /**
   * 读取文件内容
   */
  async readFile(filepath: string): Promise<string | null> {
    return await window.electronAPI.readFile(filepath);
  }

  /**
   * 写入文件内容
   */
  async writeFile(filepath: string, content: string): Promise<boolean> {
    return await window.electronAPI.writeFile(filepath, content);
  }

  async deleteFile(filepath: string): Promise<boolean> {
    return await window.electronAPI.deleteFile(filepath);
  }

  /**
   * 获取数据目录路径
   */
  async getDataDir(): Promise<string> {
    return await window.electronAPI.getDataDir();
  }

  /**
   * 创建新应用
   */
  async createApp(): Promise<string> {
    const id = getUUID();
    const initialData = {
      title: 'Untitled app',
      description: '',
      version: "0.0.1",
      nodes: [],
      edges: []
    }
    await this.writeFile(`apps/${id}.json`, JSON.stringify(initialData, null, 2));
    return id;
  }

  async getAppData(appId:string): Promise<any> {
    try {
      const appContent = await this.readFile(`apps/${appId}.json`);
      if (appContent === null) {
        return {};
      }
      return JSON.parse(appContent);
    } catch(e) {
      return {};
    }
  }

  async saveAppData(appId: string, appData: any): Promise<boolean> {
    try {
      await this.writeFile(`apps/${appId}.json`, typeof appData === 'string' ? appData : JSON.stringify(appData, null, 2));
      return true;
    } catch(e) {
      console.error('Failed to save app data:', e);
      return false;
    }
  }

  /**
   * 删除应用
   */
  async deleteApp(appId: string): Promise<boolean> {
    try {
      await this.deleteFile(`apps/${appId}.json`);
      return true;
    } catch (e) {
      console.error('Failed to delete app:', e);
      return false;
    }
  }

  /**
   * 复制应用
   */
  async duplicateApp(appId: string): Promise<boolean> {
    try {
      const appData = await this.getAppData(appId);
      const newId = getUUID();
      appData.title = `${appData.title} (Copy)`;
      await this.saveAppData(newId, appData);
      return true;
    } catch (e) {
      console.error('Failed to duplicate app:', e);
      return false;
    }
  }

  /**
   * 加载配置
   */
  async loadSettings(): Promise<any> {
    try {
      const content = await this.readFile(SETTINGS_FILE);
      if (content === null) {
        return {};
      }
      return JSON.parse(content);
    } catch (e) {
      console.error('Failed to load settings:', e);
      return {};
    }
  }

  /**
   * 保存配置
   */
  async saveSettings(settings: any): Promise<boolean> {
    try {
      await this.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      return true;
    } catch (e) {
      console.error('Failed to save settings:', e);
      return false;
    }
  }
}

// 导出单例实例
export const api = new Api();
