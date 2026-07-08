import React, { useState } from "react";
import { X } from "lucide-react";
import type { ExecutionState, InputRequest } from "./types";

interface ExecutorPanelProps {
  execState: ExecutionState;
  onSubmitInput: (inputs: Record<string, string>) => void;
  onClose: () => void;
}

export default function ExecutorPanel({ execState, onSubmitInput, onClose }: ExecutorPanelProps) {
  const { status, pendingInputs, renderedHtml, error, nodeOutputs } = execState;

  if (status === 'idle') return null;

  return (
    <div className="executor-panel">
      <div className="executor-panel-header">
        <span className="executor-title">App Preview</span>
        <button className="executor-close" onClick={onClose}><X size={20} strokeWidth={1.5} /></button>
      </div>

      <div className="executor-panel-body">
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

function RunningView({ title }: { title: string | null }) {
  return (
    <div className="executor-running">
      <div className="executor-spinner" />
      <p>正在执行{title ? `：${title}` : '...'}</p>
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

  const handleChange = (nodeId: string, value: string) => {
    setValues(prev => ({ ...prev, [nodeId]: value }));
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
          <input
            type="text"
            value={values[input.nodeId] || ""}
            onChange={(e) => handleChange(input.nodeId, e.target.value)}
            required={input.required}
            placeholder={input.description}
          />
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
