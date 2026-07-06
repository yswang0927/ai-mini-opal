import Quill from 'quill';

const Embed = Quill.import('blots/embed') as any;

// 为了测试直观，这里先用简单的 Emoji 代替 SVG，确保先跑通流程
const ICONS: Record<string, string> = {
  in: '⬇️', 
  asset: '🖼️', 
  tool: '🔍' 
};

export class CustomTagBlot extends Embed {
  static blotName = 'custom-tag';
  static tagName = 'span'; // 强制全小写
  static className = 'custom-tag-wrapper';

  static create(value: any) {
    // ⚠️ 关键点 1：不传 value 给 super.create()，防止底层将 Object 强转为 "[object Object]" 导致错误
    const node = super.create() as HTMLElement;
    node.setAttribute('contenteditable', 'false');

    // 容错处理：确保 data 是个对象
    const data = typeof value === 'string' ? JSON.parse(value) : value;

    // ⚠️ 关键点 2：存入 dataset 时使用自定义属性名 tagData，避免与 Quill 内部变量冲突
    node.dataset.tagData = JSON.stringify(data);

    // 构建内部 DOM
    node.innerHTML = `
      <span class="tag-icon">${ICONS[data.type] || ICONS.tool}</span>
      <span class="tag-title">${data.title || 'Unknown'}</span>
    `;

    return node;
  }

  static value(node: HTMLElement) {
    try {
      return JSON.parse(node.dataset.tagData || '{}');
    } catch {
      return {};
    }
  }
}

export class TagReplacerModule {
  quill: Quill;

  constructor(quill: Quill) {
    this.quill = quill;

    this.quill.on(Quill.events.TEXT_CHANGE, (delta, oldDelta, source) => {
      if (source !== 'user') return;
      
      // ⚠️ 关键点 3：必须使用 setTimeout 脱离当前更新流，否则 Quill v2 会拦截此次 embed 插入
      setTimeout(() => {
        this.checkAndReplaceTags();
      }, 0);
    });
  }

  checkAndReplaceTags() {
    const text = this.quill.getText();
    const regex = /\{\{(.*?)\}\}/g;
    let match;
    const matches: Array<{ index: number; length: number; text: string }> = [];

    while ((match = regex.exec(text)) !== null) {
      matches.push({ index: match.index, length: match[0].length, text: match[0] });
    }

    if (matches.length > 0) {
      matches.reverse().forEach((m) => {
        try {
          const jsonStr = m.text.substring(1, m.text.length - 1);
          const data = JSON.parse(jsonStr);

          if (data.type && data.title) {
            // 删除原始文本并插入 Blot
            this.quill.deleteText(m.index, m.length, 'api');
            this.quill.insertEmbed(m.index, 'custom-tag', data, 'api');
          }
        } catch (e) {
          console.warn('JSON 解析失败，忽略此项:', m.text);
        }
      });
    }
  }
}