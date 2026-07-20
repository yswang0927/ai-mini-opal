import { z } from 'zod';

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
  RenderOutputs = 'render-outputs',
  AssetsText = 'assets-text',
  AssetsFile = 'assets-file',
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
  description?: OpalNodeInstruction;      // OpalNodeType.UserInput
  "config$prompt"?: OpalNodeInstruction;  // OpalNodeType.AgentGenerate
  text?: OpalNodeInstruction;             // OpalNodeType.RenderOutputs
  "config$ask-user"?: boolean;
  "config$list"?: boolean;
  file?: {url: string, mimeType?:string, role: string},
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
  assets?: Record<string, any>;
  version?: string;
  nodes?: OpalNode[];
  edges?: OpalEdge[];
}

export enum OpalNodeRefType {
  In = "in",
  Asset = "asset",
  Tool = "tool"
}

export enum SaveState {
  Pending = "pending",
  Saved = "saved",
  Failed = "failed"
}

/** 校验失败时抛出，message 指明具体不符合的字段。 */
export class OpalJsonValidationError extends Error {
  constructor(message: string, public readonly issues?: z.core.$ZodIssue[]) {
    super(message);
    this.name = 'OpalJsonValidationError';
  }
}

// 使用 looseObject 保留接口中索引签名允许的额外字段（校验后会被原样写回磁盘）。
const opalNodeMetadataSchema = z.looseObject({
  title: z.string(),
  visual: z.looseObject({ x: z.number(), y: z.number() }).optional(),
  userModified: z.boolean().optional(),
  step_intent: z.string().optional(),
  expected_output: z
    .array(z.looseObject({ type: z.string(), description: z.string(), list: z.boolean() }))
    .optional(),
});

const opalNodeSchema = z.looseObject({
  id: z.string().min(1),
  type: z.enum(OpalNodeType),
  metadata: opalNodeMetadataSchema,
  // configuration 有索引签名，保持宽松，仅要求是对象。
  configuration: z.looseObject({}),
});

const opalEdgeSchema = z.looseObject({
  from: z.string().min(1),
  to: z.string().min(1),
  out: z.string().optional(),
  in: z.string().optional(),
});

export const opalJsonSchema = z.looseObject({
  metadata: z.any().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  assets: z.any().optional(),
  version: z.string().optional(),
  nodes: z.array(opalNodeSchema).optional(),
  edges: z.array(opalEdgeSchema).optional(),
});

/** 将 zod 校验问题格式化为「字段路径: 说明」的可读文本。 */
function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}

/**
 * 严格校验任意值是否符合 OpalJson 格式，通过则返回带类型的对象，否则抛出 OpalJsonValidationError。
 */
export function validateOpalJson(data: unknown): OpalJson {
  const result = opalJsonSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues;
    throw new OpalJsonValidationError(issues.map(formatZodIssue).join('; '), issues);
  }
  return result.data as OpalJson;
}
