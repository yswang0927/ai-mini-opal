import { Annotation } from "@langchain/langgraph";

// 对应 Opal JSON 里的节点定义 [1-3]
export interface OpalNode {
  id: string;
  type: string;
  metadata: any;
  configuration: any;
}

export interface OpalEdge {
  from: string;
  to: string;
  out: string;
  in: string;
}

// 贯穿整个图执行的状态通道
export const OpalState = Annotation.Root({
  // 记录每个 step_id 产生的输出结果
  nodeOutputs: Annotation<Record<string, string>>({
    reducer: (state, update) => ({ ...state, ...update }),
    default: () => ({}),
  })
});