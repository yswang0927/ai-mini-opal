import Quill from 'quill';
import { MentionBlot } from "quill-mention";

const Embed = Quill.import('blots/embed') as any;

export type OpalTagType = 'in' | 'asset' | 'tool' | 'routing';

export interface OpalTagValue {
  type: OpalTagType;
  path: string;
  title: string;
  instance?: string; // {{type:tool, path:'control-flow/routing', instance:<step_id>, title:''}}
  mimeType?: string;
}

// 不同 type 的图标,按需替换成你自己的 svg / iconfont
const OPAL_TAG_ICONS_MAP: Record<OpalTagType, string> = {
  in: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8"/></svg>`,
  asset: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1"/><path d="M14 2v5a1 1 0 0 0 1 1h5M2 15h10M9 18l3-3-3-3"/></svg>`,
  tool: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/></svg>`,
  routing: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3M15 9l6-6"/></svg>`,
};

export class OpalRefTagBlot extends Embed {
  static blotName = 'opalRefTag';
  static tagName = 'span';
  static className = 'opal-ref-tag';

  static create(value: OpalTagValue) {
    const node: HTMLElement = super.create(value);
    node.setAttribute('contenteditable', 'false');
    node.dataset.type = value.type;
    node.dataset.path = value.path;
    node.dataset.title = value.title;
    if (value.instance) {
      node.dataset.instance = value.instance;
    }
    if (value.mimeType) {
      node.dataset.mimeType = value.mimeType;
    }

    const icon = document.createElement('span');
    let iconType = value.type;
    if (value.path === 'control-flow/routing') {
      iconType = 'routing';
    }
    icon.className = 'opal-ref-tag-icon';
    icon.innerHTML = OPAL_TAG_ICONS_MAP[iconType] ?? OPAL_TAG_ICONS_MAP.in;

    const label = document.createElement('span');
    label.className = 'opal-ref-tag-title';
    label.textContent = value.title;

    node.innerHTML = '';
    node.appendChild(icon);
    node.appendChild(label);

    return node;
  }

  // 决定 quill.getContents() 拿到的 delta 里这个 embed 的值
  static value(node: HTMLElement): OpalTagValue {
    const dataset = node.dataset;
    let tagValue: OpalTagValue = {
      type: (dataset.type as OpalTagType) ?? 'in',
      path: dataset.path ?? '',
      title: dataset.title ?? ''
    };
    if (dataset.instance) {
      tagValue.instance = dataset.instance;
    }
    if (dataset.mimeType) {
      tagValue.mimeType = dataset.mimeType;
    }
    return tagValue;
  }
}

const OPAL_TAG_TYPES = new Set<OpalTagType>(['in', 'asset', 'tool']);

function tryParseTag(inner: string): OpalTagValue | null {
  // inner形如 {{"type":"in",...}}，去掉最外层各一个 { 和 }
  // 即可还原成合法 JSON: {"type":"in",...}
  let jsonText = inner;
  if (jsonText.startsWith('{{')) {
    jsonText = jsonText.substring(1, jsonText.length - 1);
  }

  try {
    const obj = JSON.parse(jsonText);
    if (obj && OPAL_TAG_TYPES.has(obj.type)
      && typeof obj.path === 'string'
      && typeof obj.title === 'string'
    ) {
      return obj as OpalTagValue;
    }
  } catch (e) {
    // 内容还不完整（用户没打完 / 不是合法 json），忽略
  }
  return null;
}

export class OpalRefTagModule {
  private quill: Quill;

  constructor(quill: Quill) {
    this.quill = quill;

    this.quill.on(Quill.events.TEXT_CHANGE, (_delta, _oldDelta, source) => {
      // tag 替换自身产生的改动 source 是 'silent'，直接忽略，防止无限循环
      if (source === Quill.sources.SILENT) {
        return;
      }
      this.checkAndReplaceTags();
    });
  }

  // getText() 会把非字符串 embed（包括我们自己的 tag）直接过滤掉，
  // 导致返回字符串的下标和真实文档下标不一致（每个 embed 在文档里占 1 个长度，
  // 但在 getText() 里贡献 0 个字符）。这里自己遍历 Delta，
  // 用一个等长占位符（\uFFFC）填充非字符串 embed，保证下标严格对齐真实文档。
  private buildIndexableText(): string {
    const delta = this.quill.getContents();
    let text = '';
    delta.ops.forEach((op: any) => {
      if (typeof op.insert === 'string') {
        text += op.insert;
      } else {
        text += '\uFFFC';
      }
    });
    return text;
  }

  private checkAndReplaceTags() {
    const text = this.buildIndexableText();
    const regex = /\{\{(.*?)\}\}/g;

    const matches: Array<{ index: number; length: number; text: string }> = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      matches.push({ index: match.index, length: match[0].length, text: match[0] });
    }

    if (matches.length === 0) {
      return;
    }

    // 记录替换前的光标位置（这里拿到的是真实文档坐标，和 m.index 是同一套坐标系）。
    // deleteText/insertEmbed 用 silent source 时，Quill 内置的光标自动追踪
    // 对“同一位置先删除再插入”这种组合操作并不可靠，所以这里自己算最终应处的位置。
    let cursorIndex: number | null = null;

    // ⚠️ 必须从后往前替换：所有 match.index 都是基于替换前的原始文本算出来的，
    // 从后往前处理时，已经处理过的位置都在“待处理位置”的后面，
    // 不会影响前面还没处理的 match.index，天然避免了偏移计算。
    matches.slice().reverse().forEach((m) => {
      const value = tryParseTag(m.text);
      if (!value) {
        console.warn('OpalRefTag JSON 解析失败或字段不完整:', m.text);
        return;
      }
      this.quill.deleteText(m.index, m.length, Quill.sources.SILENT);
      this.quill.insertEmbed(m.index, OpalRefTagBlot.blotName, value, Quill.sources.SILENT);
      // 可选：插入空格防止粘连
      this.quill.insertText(m.index + 1, ' ', Quill.sources.SILENT);

      // 净变化：删除了 m.length 个字符，插入了 1 个字符（embed）
      const shift = m.length - 1;
      if (cursorIndex === null) {
        // reverse 后第一个处理的就是原本最靠右的匹配，光标目标定在它后面一位
        cursorIndex = m.index + 1;
      } else if (m.index < cursorIndex) {
        // 更靠左的匹配会让它右侧的一切（包括我们已经定好的目标位置）整体左移
        cursorIndex -= shift;
      }
    });

    if (cursorIndex !== null) {
      const targetIndex = cursorIndex + 1; // +1 是因为标签后面插入了一个空格，所以要跳到空格那
      requestAnimationFrame(() => {
        this.quill.setSelection(targetIndex, 0, Quill.sources.SILENT);
      });
    }
  }
}

/**
 * 定制修改 quill-mention, 使插入的tag效果符合OpalRefTag效果定义
 */
export class OpalRefTagMentionBlot extends MentionBlot {
  static create(value: any) {
    const node: HTMLElement = super.create(value) as HTMLElement;
    node.setAttribute('contenteditable', 'false');
    node.className = "opal-ref-tag";

    const icon = document.createElement('span');
    icon.className = `opal-ref-tag-icon opal-ref-tag-icon-${value.refType}`;
    icon.innerHTML = OPAL_TAG_ICONS_MAP[value.refType as OpalTagType] ?? OPAL_TAG_ICONS_MAP.in;

    const label = document.createElement('span');
    label.className = 'opal-ref-tag-title';
    label.textContent = value.value;

    node.innerHTML = '';
    node.appendChild(icon);
    node.appendChild(label);

    return node;
  }

  // 决定 quill.getContents() 拿到的 delta 里这个 embed 的值
  static value(node: HTMLElement): OpalTagValue {
    // {id, path, refType, value}
    const dataset = node.dataset;
    let tagValue: OpalTagValue = {
      type: (dataset.refType as OpalTagType) ?? 'in',
      path: dataset.path ?? '',
      title: dataset.value ?? ''
    };
    if (dataset.mimeType) {
      tagValue.mimeType = dataset.mimeType;
    }
    return tagValue;
  }
}
OpalRefTagMentionBlot.blotName = "opalRefTagMention";


// 把 tag embed 序列化回 {{"type":"...","path":"...","title":"..."}} 文本格式，
// 和 tagAutoConvert 里的解析逻辑互为逆操作，用于保存时还原成纯文本字段
export function tagValueToText(value: OpalTagValue): string {
  const refValue:OpalTagValue = {
    type: value.type,
    path: value.path,
    title: value.title
  };

  if (value.instance) {
    refValue['instance'] = value.instance;
  }
  if (value.mimeType) {
    refValue['mimeType'] = value.mimeType;
  }
  return `{${JSON.stringify(refValue)}}`;
}

// 把整个 Quill 内容（字符串 + tag embed 混合）还原成一段纯文本，
// 保存到后端时用这个，而不是 quill.getText()（会把 tag 直接丢弃）
// 或 quill.root.innerHTML（格式和原始字段不一致）
export function quillContentToText(quill: Quill): string {
  const delta = quill.getContents();
  let text = '';

  delta.ops.forEach((op: any) => {
    if (typeof op.insert === 'string') {
      text += op.insert;
    } else if (op.insert && typeof op.insert === 'object') {
      if (op.insert.opalRefTag) {
        text += tagValueToText(op.insert.opalRefTag);
      }
      else if (op.insert.opalRefTagMention) {
        text += tagValueToText(op.insert.opalRefTagMention);
      }
    }
  });

  return text;
}


