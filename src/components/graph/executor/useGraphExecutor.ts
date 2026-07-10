import { useState, useCallback, useRef } from "react";
import type { OpalJson } from "@/types";
import type { ExecutionState } from "./types";
import { GraphExecutor } from "./GraphExecutor";

const initialState: ExecutionState = {
  status: 'idle',
  pendingInputs: [],
  nodeOutputs: {},
  renderedHtml: null,
  error: null,
  currentNodeId: null,
  currentNodeTitle: null,
  graphTitle: null,
  graphDescription: null,
  nodeStatuses: {},
  nodeExecLog: [],
};

export function useGraphExecutor() {
  const [execState, setExecState] = useState<ExecutionState>(initialState);
  const executorRef = useRef<GraphExecutor | null>(null);
  const graphRef = useRef<OpalJson | null>(null);

  const loadGraph = useCallback((graphJson: OpalJson) => {
    graphRef.current = graphJson;
    setExecState({
      ...initialState,
      status: 'ready',
      graphTitle: graphJson.title || null,
      graphDescription: graphJson.description || null,
    });
  }, []);

  const start = useCallback(async () => {
    const graphJson = graphRef.current;
    if (!graphJson) return;
    const executor = new GraphExecutor(graphJson);
    executorRef.current = executor;
    setExecState(prev => ({ ...prev, status: 'running' }));
    await executor.run(setExecState);
  }, []);

  const submitInput = useCallback((inputs: Record<string, string>) => {
    if (!executorRef.current) return;
    executorRef.current.resumeWithInput(inputs);
  }, []);

  const reset = useCallback(() => {
    executorRef.current = null;
    graphRef.current = null;
    setExecState(initialState);
  }, []);

  return { execState, loadGraph, start, submitInput, reset };
}
