import React, { useState } from "react";
import { RotateCcw, CirclePlus, FileDown } from "lucide-react";
import {
  Button,
  Intent,
  PopoverNext,
  Menu,
  MenuItem,
  MenuDivider,
} from "@blueprintjs/core";
import { useL10n } from "@/l10n";
import { downloadFile, AppToaster } from "@/utils";
import type { ExecutionState, InputRequest, RenderedOutput } from "./types";

interface ExecutorPanelProps {
  execState: ExecutionState;
  onSubmitInput: (inputs: Record<string, string>) => void;
  onStart: () => void;
  onRestart: () => void;
}

export default function ExecutorPanel({ execState, onSubmitInput, onStart, onRestart }: ExecutorPanelProps) {
  const { status, pendingInputs, renderedOutputs, error, nodeOutputs } = execState;
  const { t } = useL10n();

  if (status === 'idle') {
    return null;
  }

  // 下载生成的HTML输出文件
  const handleDownloadReport = async (reportName:string) => {
    if (!renderedOutputs || renderedOutputs.length === 0) return;

    // 文件名规则: <title> -> 第一个 <h1> -> 默认 "输出<日期>"
    // 测试：取第一个
    const filtered = renderedOutputs.filter(item => item.title === reportName);
    if (!filtered || filtered.length === 0) return;

    const renderedHtml = filtered[0]?.content || '';
    let filename = '';
    const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').trim();
    const titleMatch = renderedHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    
    if (titleMatch) {
      filename = stripTags(titleMatch[1]);
    }

    if (!filename) {
      const h1Match = renderedHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match) {
        filename = stripTags(h1Match[1]);
      }
    }
    
    if (!filename) {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filename = `输出${date}`;
    }

    // 去除文件名中的非法字符
    filename = `${filename.replace(/[\\/:*?"<>|]/g, '_')}.html`;

    const result = await downloadFile(filename, renderedHtml);
    if (result.success) {
      (await AppToaster).show({
        message: `「${filename}」${t("下载完成")} ${result.filePath ? (': '+result.filePath) : ''}`, 
        intent: Intent.SUCCESS 
      });
    }
    else if (!result.canceled) {
      (await AppToaster).show({
        message: `「${filename}」${t('下载失败')}: ${result.error}`, 
        intent: Intent.DANGER 
      });
    }
  };

  return (
    <div className="executor-panel">
      <div className="executor-panel-header">
        <span className="executor-title">{t('应用预览')}</span>
        <div className="flex gap-md">
          {(renderedOutputs !== null && renderedOutputs.length > 0) && (
            <PopoverNext placement='bottom' content={
              <Menu>
                {renderedOutputs.map(output => <MenuItem text={output.title} onClick={() => handleDownloadReport(output.title)} />)}
              </Menu>
            }>
              <Button variant="minimal" icon={<span className="bp6-icon"><FileDown size={20} strokeWidth={1.5} /></span>} title={t('下载')} />
            </PopoverNext>
          )}
          <Button onClick={onRestart} variant="minimal" icon={<span className="bp6-icon"><RotateCcw size={20} strokeWidth={1.5} /></span>} title={t('重启应用')} />
        </div>
      </div>

      <div className="executor-panel-body">
        {status === 'ready' && (
          <SplashView
            title={execState.graphTitle}
            description={execState.graphDescription}
            onStart={onStart}
          />
        )}
        {status === 'running' && <RunningView title={execState.currentNodeTitle} />}
        {status === 'waiting_input' && (
          <InputCollector inputs={pendingInputs} onSubmit={onSubmitInput} />
        )}
        {status === 'completed' && renderedOutputs !== null && (
          <OutputsRenderer outputs={renderedOutputs} />
        )}
        {status === 'completed' && !renderedOutputs && (
          <CompletedView outputs={nodeOutputs} />
        )}
        {status === 'error' && <ErrorView error={error} />}
      </div>
    </div>
  );
}

function SplashView({ title, description, onStart }: {
  title: string | null;
  description: string | null;
  onStart: () => void;
}) {
  const { t } = useL10n();

  return (
    <div className="executor-splash">
      <h2 className="executor-splash-title">{title || 'Untitled App'}</h2>
      {description && <p className="executor-splash-desc">{description}</p>}
      <button className="executor-start-btn" onClick={() => onStart()}>{t('开始')}</button>
    </div>
  );
}

function RunningView({ title }: { title: string | null }) {
  const { t } = useL10n();

  return (
    <div className="executor-running">
      <div className="executor-spinner" />
      <p><b>{title ? `「${title}」` : ''}</b>{`${t('正在处理')}...`}</p>
    </div>
  );
}

function ErrorView({ error }: { error: string | null }) {
  const { t } = useL10n();

  return (
    <div className="executor-error">
      <p>{t('运行出错')}</p>
      <pre>{error}</pre>
    </div>
  );
}

function CompletedView({ outputs }: { outputs: Record<string, string> }) {
  const { t } = useL10n();

  return (
    <div className="executor-completed">
      <p>{t('运行完成')}</p>
      {Object.entries(outputs).map(([nodeId, output]) => (
        <div key={nodeId} className="executor-output-item">
          <strong>{nodeId}</strong>
          <pre>{output.substring(0, 500)}</pre>
        </div>
      ))}
    </div>
  );
}

function InputCollector({
  inputs,
  onSubmit,
}: {
  inputs: InputRequest[];
  onSubmit: (values: Record<string, string>) => void;
}) {
  const { t } = useL10n();

  const [values, setValues] = useState<Record<string, string>>({});
  // 记录已选文件名,仅用于界面展示;实际提交的是本地磁盘物理绝对路径。
  const [fileNames, setFileNames] = useState<Record<string, string>>({});

  const handleChange = (nodeId: string, value: string) => {
    setValues(prev => ({ ...prev, [nodeId]: value }));
  };

  // 在 Electron 客户端中,直接取所选文件的本地物理绝对路径,无需上传到服务端。
  const handleFileChange = (nodeId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const getPath = window.electronAPI?.getPathForFile;
    const paths = Array.from(files).map(f => (getPath ? getPath(f) : f.name));
    // 多选时用换行分隔多个绝对路径,单选即单个路径。
    handleChange(nodeId, paths.join('\n'));
    setFileNames(prev => ({
      ...prev,
      [nodeId]: Array.from(files).map(f => f.name).join(', '),
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <form className="executor-input-form" onSubmit={handleSubmit}>
      {inputs.map((input) => (
        <div key={input.nodeId} className="executor-input-field">
          <label>{input.title}</label>
          <p className="executor-input-desc">{input.description}</p>
          <div className="executor-inputbox">
            {/* 如果 modality=Any|Image|File 则显示一个选择文件的按钮 */}
            {input.modality !== 'Text' && (
              <button type="button" className="executor-input-filepicker">
                <span className="btn-icon"><CirclePlus size={20} strokeWidth={1.25} /></span>
                <input
                  type="file"
                  multiple
                  className="absolute inset-0"
                  style={{ zIndex: 0, opacity: 0 }}
                  onChange={(e) => handleFileChange(input.nodeId, e)}
                />
              </button>
            )}

            <input
              type="text"
              className="flex-1"
              value={values[input.nodeId] || ""}
              onChange={(e) => handleChange(input.nodeId, e.target.value)}
              required={input.required}
              placeholder={fileNames[input.nodeId] ? "" : input.description}
            />
          </div>
          {fileNames[input.nodeId] && (
            <p className="executor-input-filename">已选择: {fileNames[input.nodeId]}</p>
          )}
        </div>
      ))}
      <button type="submit" className="executor-submit-btn">{t('继续')}</button>
    </form>
  );
}

function OutputsRenderer({ outputs }: {outputs: RenderedOutput[]}) {
  return (
    <div className="executor-html-render flex">
      {outputs.map(output => {
        return (
          <div key={output.title} className="flex-1 flex flex-col">
            <h3>{output.title}</h3>
            <div className="flex-1" style={{height:'100%'}}>
              <iframe
                srcDoc={output.content}
                sandbox="allow-scripts allow-same-origin"
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="App Output"
              />
            </div>
          </div>
        )
      })}
    </div>
  );
}
