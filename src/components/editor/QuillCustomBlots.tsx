import Quill from 'quill';

const Embed = Quill.import('blots/embed') as any;

export type TagType = 'in' | 'asset' | 'tool';
 
export interface TagValue {
  type: TagType;
  path: string;
  title: string;
  mimeType?: string;
}
 
// 不同 type 的图标,按需替换成你自己的 svg / iconfont
const ICON_MAP: Record<TagType, string> = {
  in: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 1l7 4v6l-7 4-7-4V5z"/></svg>`,
  asset: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="1" y="2" width="14" height="12" rx="1.5"/></svg>`,
  tool: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="8" cy="8" r="6"/></svg>`,
};
 
export class TagBlot extends Embed {
  static blotName = 'tag';
  static tagName = 'span';
  static className = 'custom-tag';
 
  static create(value: TagValue) {
    const node: HTMLElement = super.create(value);
    node.setAttribute('contenteditable', 'false');
    node.dataset.type = value.type;
    node.dataset.path = value.path;
    node.dataset.title = value.title;
    if (value.mimeType) {
      node.dataset.mimeType = value.mimeType;
    }
 
    const icon = document.createElement('span');
    icon.className = `tag-icon tag-icon-${value.type}`;
    icon.innerHTML = ICON_MAP[value.type] ?? ICON_MAP.in;
 
    const label = document.createElement('span');
    label.className = 'tag-title';
    label.textContent = value.title;
 
    node.innerHTML = '';
    node.appendChild(icon);
    node.appendChild(label);
 
    return node;
  }
 
  // 决定 quill.getContents() 拿到的 delta 里这个 embed 的值
  static value(node: HTMLElement): TagValue {
    return {
      type: (node.dataset.type as TagType) ?? 'in',
      path: node.dataset.path ?? '',
      title: node.dataset.title ?? '',
      mimeType: node.dataset.mimeType ?? '',
    };
  }
}

const TAG_TYPES = new Set<TagType>(['in', 'asset', 'tool']);
 
function tryParseTag(inner: string): TagValue | null {
  // inner形如 {{"type":"in",...}}，去掉最外层各一个 { 和 }
  // 即可还原成合法 JSON: {"type":"in",...}
  let jsonText = inner;
  if (jsonText.startsWith('{{')) {
    jsonText = jsonText.substring(1, jsonText.length - 1);
  }

  try {
    const obj = JSON.parse(jsonText);
    if (obj && TAG_TYPES.has(obj.type) 
      && typeof obj.path === 'string' 
      && typeof obj.title === 'string'
    ) {
      return obj as TagValue;
    }
  } catch(e) {
    // 内容还不完整（用户没打完 / 不是合法 json），忽略
  }
  return null;
}
 
export class TagModule {
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
        console.warn('Tag JSON 解析失败或字段不完整:', m.text);
        return;
      }
      this.quill.deleteText(m.index, m.length, Quill.sources.SILENT);
      this.quill.insertEmbed(m.index, TagBlot.blotName, value, Quill.sources.SILENT);
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
      const targetIndex = cursorIndex;
      requestAnimationFrame(() => {
        this.quill.setSelection(targetIndex, 0, Quill.sources.SILENT);
      });
    }
  }
}

