import React, { useState } from "react";
import { RotateCcw, CirclePlus} from "lucide-react";
import type { ExecutionState, InputRequest } from "./types";

interface ExecutorPanelProps {
  execState: ExecutionState;
  onSubmitInput: (inputs: Record<string, string>) => void;
  onStart: () => void;
  onRestart: () => void;
}

export default function ExecutorPanel({ execState, onSubmitInput, onStart, onRestart }: ExecutorPanelProps) {
  const { status, pendingInputs, renderedHtml, error, nodeOutputs } = execState;

  if (status === 'idle') return null;

  return (
    <div className="executor-panel">
      <div className="executor-panel-header">
        <span className="executor-title">App Preview</span>
        <button className="executor-close" onClick={onRestart} title="Restart app"><RotateCcw size={20} strokeWidth={1.5} /></button>
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
        {status === 'completed' && renderedHtml && (
          <HtmlRenderer html={renderedHtml} />
        )}
        {status === 'completed' && !renderedHtml && (
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
  return (
    <div className="executor-splash">
      <h2 className="executor-splash-title">{title || 'Untitled App'}</h2>
      {description && <p className="executor-splash-desc">{description}</p>}
      <button className="executor-start-btn" onClick={onStart}>开始</button>
    </div>
  );
}

function RunningView({ title }: { title: string | null }) {
  return (
    <div className="executor-running">
      <div className="executor-spinner" />
      <p>{title ? `${title} 正在处理...` : '正在处理...'}</p>
    </div>
  );
}

function ErrorView({ error }: { error: string | null }) {
  return (
    <div className="executor-error">
      <p>执行出错</p>
      <pre>{error}</pre>
    </div>
  );
}

function CompletedView({ outputs }: { outputs: Record<string, string> }) {
  return (
    <div className="executor-completed">
      <p>执行完成</p>
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
      <button type="submit" className="executor-submit-btn">继续</button>
    </form>
  );
}

function HtmlRenderer({ html }: { html: string }) {
  return (
    <div className="executor-html-render">
      <iframe
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin"
        style={{ width: '100%', height: '100%', border: 'none' }}
        title="App Output"
      />
    </div>
  );
}
