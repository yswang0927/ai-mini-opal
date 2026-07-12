export interface AppData {
  id: string
  title: string
  description: string
  thumbnailUrl?: string
  tags?: string[]
}

/*=============================
生成的 opal-json 数据格式
{
  metadata: {intent:string, tags:string[], parameters:{}}, 
  title, 
  description, 
  url: string,
  assets: {},
  version: string,
  nodes:[
    {
      id: string,
      type: string,
      metadata: {
        title: string, 
        visual?: {x:number, y:number}, 
        userModified?: boolean, 
        step_intent?: string, 
        expected_output?: [{type:string, description:string, list:boolean}]
      },
      configuration:{
        description?: {parts:[{text:string}], role:string}, 
        text?: {parts:[{text:string}], role:string}, 
        "config$prompt"?: {parts:[{text:string}], role:string}, 
        "generation-mode"?: string, 
        "config$ask-user"?: boolean, 
        "config$list"?: boolean, 
        "p-modality"?: string, 
        "p-required"?: boolean, 
        "p-render-mode"?: string, 
        "system-instruction"?: {parts:[{text:string}], role:string}
      }
    }
  ], 
  edges:[{from:string, to:string, out:string, in:string}]
}
==============================*/

export enum OpalNodeType {
  UserInputs = 'user-inputs',
  AgentGenerate = 'agent-generate',
  RenderOutputs = 'render-outputs'
}

export interface OpalNodeMetadata {
  title: string;
  visual?: {
    x: number;
    y: number;
  };
  userModified?: boolean;
  step_intent?: string;
  expected_output?: Array<{
    type: string;
    description: string;
    list: boolean;
  }>;
}

export interface OpalNodeInstruction {
  content: string;
  role: string;
}

export interface OpalNodeConfig {
  description?: OpalNodeInstruction;
  text?: OpalNodeInstruction;
  "config$prompt"?: OpalNodeInstruction;
  "config$ask-user"?: boolean;
  "config$list"?: boolean;
  "p-modality"?: string;
  "p-required"?: boolean;
  "p-render-mode"?: string;
  "generation-mode"?: string;
  "system-instruction"?: OpalNodeInstruction;

  // 索引签名：允许 string 类型变量作为下标访问
  [key: string]: any;
};

export interface OpalNode {
  id: string;
  type: OpalNodeType;
  metadata: OpalNodeMetadata;
  configuration: OpalNodeConfig;
  [key: string]: unknown; // 增加索引签名
}

export interface OpalEdge {
  from: string;
  to: string;
  out?: string;
  in?: string;
}

export interface OpalJson {
  metadata?: any;
  title: string;
  description?: string;
  assets?: any;
  version?: string;
  nodes: OpalNode[];
  edges: OpalEdge[];
}

export enum SaveState {
  Pending = "pending",
  Saved = "saved",
  Failed = "failed"
}
