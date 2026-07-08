import { useState, useCallback, useRef } from "react";
import type { OpalGraphJson, ExecutionState } from "./types";
import { GraphExecutor } from "./GraphExecutor";

const initialState: ExecutionState = {
  status: 'idle',
  pendingInputs: [],
  nodeOutputs: {},
  renderedHtml: null,
  error: null,
  currentNodeId: null,
  currentNodeTitle: null,
};

export function useGraphExecutor() {
  const [execState, setExecState] = useState<ExecutionState>(initialState);
  const executorRef = useRef<GraphExecutor | null>(null);

  const execute = useCallback(async (graphJson: OpalGraphJson) => {
    const executor = new GraphExecutor(graphJson);
    executorRef.current = executor;
    setExecState({ ...initialState, status: 'running' });
    await executor.run(setExecState);
  }, []);

  const submitInput = useCallback((inputs: Record<string, string>) => {
    if (!executorRef.current) return;
    executorRef.current.resumeWithInput(inputs);
  }, []);

  const reset = useCallback(() => {
    executorRef.current = null;
    setExecState(initialState);
  }, []);

  return { execState, execute, submitInput, reset };
}
