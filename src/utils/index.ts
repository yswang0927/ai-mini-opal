/**
 * 防抖函数返回值接口，扩展了取消和立即执行的方法
 */
export interface DebouncedFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;
  /** 取消尚未执行的定时器，防止内存泄漏 */
  cancel(): void;
  /** 立即强制触发一次执行 */
  flush(...args: Parameters<T>): ReturnType<T> | undefined;
}

/**
 * 工业级防抖函数
 * @param func 目标执行函数
 * @param wait 触发延迟时间 (ms)
 * @param immediate 是否在延迟开始前立即调用
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  immediate = false
): DebouncedFunction<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: any = null;

  const debounced: DebouncedFunction<T> = function (this: any, ...args: Parameters<T>) {
    lastArgs = args;
    lastThis = this;

    const invokeFunc = () => {
      if (lastArgs) {
        func.apply(lastThis, lastArgs);
        lastArgs = lastThis = null;
      }
    };

    const isInvokingImmediate = immediate && !timeoutId;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (!immediate) {
        invokeFunc();
      }
    }, wait);

    if (isInvokingImmediate) {
      invokeFunc();
    }
  };

  // 取消执行
  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = null;
    lastArgs = lastThis = null;
  };

  // 立即刷出执行
  debounced.flush = function (this: any, ...args: Parameters<T>) {
    debounced.cancel();
    return func.apply(this, args);
  };

  return debounced;
}

export interface ThrottledFunction<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): void;
  cancel(): void;
}

export interface ThrottleOptions {
  /** 是否调用处于节流开始前的边界（首次触发是否立即执行，默认 true） */
  leading?: boolean;
  /** 是否调用处于节流结束后的边界（结束后是否再补执行一次，默认 true） */
  trailing?: boolean;
}

/**
 * 工业级节流函数
 * @param func 目标执行函数
 * @param wait 节流窗口时间 (ms)
 * @param options 配置项 { leading, trailing }
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  options: ThrottleOptions = {}
): ThrottledFunction<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: any = null;
  let previous = 0;

  const leading = options.leading !== false;
  const trailing = options.trailing !== false;

  const throttled: ThrottledFunction<T> = function (this: any, ...args: Parameters<T>) {
    const now = Date.now();
    
    // 如果是第一次触发且不需要 leading 执行，把 previous 挪到当前时间，使其不会触发 immediate invoke
    if (!previous && !leading) {
      previous = now;
    }

    // 距离下次执行还需要等待的时间
    const remaining = wait - (now - previous);
    lastArgs = args;
    lastThis = this;

    const invokeFunc = () => {
      previous = leading ? Date.now() : 0;
      timeoutId = null;
      if (lastArgs) {
        func.apply(lastThis, lastArgs);
        lastArgs = lastThis = null;
      }
    };

    // 情况 1：达到了 wait 时间，或者系统时间被篡改（remaining > wait）
    if (remaining <= 0 || remaining > wait) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      previous = now;
      func.apply(lastThis, lastArgs);
      lastArgs = lastThis = null;
    } 
    // 情况 2：未达到 wait 时间，但允许 trailing 补尾巴执行
    else if (!timeoutId && trailing) {
      timeoutId = setTimeout(invokeFunc, remaining);
    }
  };

  throttled.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    previous = 0;
    timeoutId = null;
    lastArgs = lastThis = null;
  };

  return throttled;
}


/**
 * 布局resize通用函数, 用于拖动手柄resize 左|右|上|下 区域的大小.
 *
 * 示例1(拖动左侧区域改变大小):
 * ```
 * <div class="flex flex-row layout1">
 *  <div style="width: 200px" class="relative">
 *      <div class="layout-resizer" data-region="left" data-min="60" data-max="500"></div>
 *  </div>
 *  <div class="flex-1">Right</div>
 * </div>
 *
 * new LayoutResizer({
 *  key: "resizer1", // 如果配置了,则可以自动记忆
 *  trigger: document.querySelector('.layout1 .layout-resizer'),
 *  target: document.querySelector('.layout1 .layout-resizer').parentElement
 * });
 * 
 * // 或者通过 onResizing 自己写resize目标方式
 * new LayoutResizer({
 *  trigger: document.querySelector('.layout1 .layout-resizer'),
 *  onResizing: (w) => {
 *      document.querySelector('.layout1 .layout-resizer').parentElement.style.width = w + 'px';
 *  }
 * });
 * ```
 *
 * 示例2(拖动右侧区域改变大小):
 * ```
 * <div class="flex flex-row layout2">
 *  <div class="flex-1">Left</div>
 *  <div style="width: 200px" class="relative">
 *      <div class="layout-resizer" data-region="right" data-min="60" data-max="500"></div>
 *  </div>
 * </div>
 *
 * new LayoutResizer({
 *  trigger: document.querySelector('.layout2 .layout-resizer'),
 *  onResizing: (w) => {
 *      document.querySelector('.layout2 .layout-resizer').parentElement.style.width = w + 'px';
 *  }
 * });
 * ```
 *
 * 示例3(上下参照示例1,2类似: data-region="top|bottom").
 */
export interface LayoutResizerOptions {
  trigger: string | HTMLElement; // [必须]定义resizer手柄是哪个DOM元素
  target?: string | HTMLElement;  // [可选]定义resize目标DOM元素
  onResizeStart?: (e: MouseEvent) => void;
  onResizing?: (size: number, region: string, e: MouseEvent) => void;
  onResizeEnd?: (size: number, e: MouseEvent) => void;
  min?: number;
  max?: number;
  key?: string;
}

export class LayoutResizer {
  // 定义属性类型
  public trigger: HTMLElement | null = null;
  public target: HTMLElement | null = null;
  public onResizeStart: (e: MouseEvent) => void;
  public onResizing: (size: number, region: string, e: MouseEvent) => void;
  public onResizeEnd: (size: number, e: MouseEvent) => void;
  
  public min: number;
  public max: number;

  private _region: string;
  private _dir: 'vertical' | 'horizontal';
  private _key: string | null;
  private _currentSize: number = 0;
  private _maskElement: HTMLDivElement | null = null;

  // 拖拽过程中的临时坐标与初始大小
  private _startX: number = 0;
  private _startY: number = 0;
  private _startWidth: number = 0;
  private _startHeight: number = 0;

  constructor(options: LayoutResizerOptions) {
    const opts = (typeof options === 'object' && options !== null) ? options : {} as LayoutResizerOptions;

    let triggerIn: string | HTMLElement | undefined = opts.trigger;
    if (typeof triggerIn === 'string') {
      this.trigger = document.querySelector<HTMLElement>(triggerIn);
    } else if (triggerIn instanceof HTMLElement) {
      this.trigger = triggerIn;
    }

    if (!this.trigger) {
      console.warn('LayoutResizer: 未找到触发拖拽的 DOM 元素。');
      // TS 中构造函数不能直接返回，但我们可以通过条件判断阻止后续 init
      this.min = 0;
      this.max = 0;
      this._region = 'left';
      this._dir = 'horizontal';
      this._key = null;
      this.onResizeStart = () => {};
      this.onResizing = () => {};
      this.onResizeEnd = () => {};
      return;
    }

    let targetIn = opts.target;
    if (typeof targetIn === 'string') {
      this.target = document.querySelector<HTMLElement>(targetIn);
    } else if (targetIn instanceof HTMLElement) {
      this.target = targetIn;
    }

    this.onResizeStart = opts.onResizeStart || (() => {});
    this.onResizing = opts.onResizing || (() => {});
    this.onResizeEnd = opts.onResizeEnd || (() => {});

    // 获取区域，默认为左侧
    this._region = this.trigger.getAttribute('data-region') || 'left';
    this._dir = ['top', 'bottom'].includes(this._region) ? 'vertical' : 'horizontal';

    // 范围限制
    const hasMinOpt = Object.prototype.hasOwnProperty.call(opts, 'min');
    const hasMaxOpt = Object.prototype.hasOwnProperty.call(opts, 'max');
    
    const minAttr = this.trigger.getAttribute('data-min');
    const maxAttr = this.trigger.getAttribute('data-max');

    let minVal = Number(hasMinOpt ? opts.min : (minAttr !== null ? minAttr : NaN));
    let maxVal = Number(hasMaxOpt ? opts.max : (maxAttr !== null ? maxAttr : NaN));

    this.min = isNaN(minVal) ? 0 : minVal;
    this.max = isNaN(maxVal) ? 99999 : maxVal;

    // 用于自动记忆上一次resize的大小
    this._key = opts.key ? "layout_resizer_" + opts.key : null;

    // 绑定上下文
    this._handleMouseDown = this._handleMouseDown.bind(this);
    this._handleMouseMove = this._handleMouseMove.bind(this);
    this._handleMouseUp = this._handleMouseUp.bind(this);

    this.init();
  }

  public init(): void {
    if (!this.trigger) return;
    
    requestAnimationFrame(() => {
      this.trigger!.addEventListener('mousedown', this._handleMouseDown);

      // 从记忆恢复
      if (this._key) {
        const savedSizeStr = window.localStorage.getItem(this._key);
        if (savedSizeStr !== null) {
          let savedSize = parseInt(savedSizeStr, 10);
          if (isNaN(savedSize)) {
            window.localStorage.removeItem(this._key);
            return;
          }
          this._resizeTarget(savedSize);
        }
      }
    });
  }

  private _handleMouseDown(e: MouseEvent): void {
    if (!this.trigger) return;
    e.preventDefault();
    this._startX = e.clientX;
    this._startY = e.clientY;

    const parent = this.trigger.parentElement;
    const rect = (this.target || parent as HTMLElement).getBoundingClientRect();
    this._startWidth = rect.width;
    this._startHeight = rect.height;

    this._currentSize = (this._dir === 'horizontal') ? this._startWidth : this._startHeight;
    this._createMask();
    this.onResizeStart(e);
    this.trigger.classList.add('dragging');
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', this._handleMouseMove);
    window.addEventListener('mouseup', this._handleMouseUp);
  }

  private _handleMouseMove(e: MouseEvent): void {
    let currentSize: number;

    if (this._dir === 'horizontal') {
      const deltaX = e.clientX - this._startX;
      // right 减，left 加
      currentSize = this._region === 'right' ? this._startWidth - deltaX : this._startWidth + deltaX;
    } else {
      const deltaY = e.clientY - this._startY;
      // bottom 减，top 加
      currentSize = this._region === 'bottom' ? this._startHeight - deltaY : this._startHeight + deltaY;
    }

    // 边界限制
    currentSize = this._currentSize = Math.max(this.min, Math.min(this.max, currentSize));

    this._resizeTarget(currentSize);

    if (typeof this.onResizing === 'function') {
      this.onResizing(currentSize, this._region, e);
    }
  }

  private _handleMouseUp(e: MouseEvent): void {
    window.removeEventListener('mousemove', this._handleMouseMove);
    window.removeEventListener('mouseup', this._handleMouseUp);
    this._removeMask();
    this.onResizeEnd(this._currentSize, e);
    if (this.trigger) {
      this.trigger.classList.remove('dragging');
    }
    document.body.style.userSelect = '';
    // 记忆
    if (this._key) {
      window.localStorage.setItem(this._key, String(this._currentSize));
    }
  }

  private _resizeTarget(size: number): void {
    if (this.target) {
      if (this._dir === 'horizontal') {
        this.target.style.width = this.target.style.minWidth = size + 'px';
      } else {
        this.target.style.height = this.target.style.minHeight = size + 'px';
      }
    }
  }

  // 创建全屏透明遮罩
  private _createMask(): void {
    const mask = this._maskElement = document.createElement('div');
    Object.assign(mask.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      zIndex: '999999', // 确保在最上层，挡住 iframe 和其他业务组件
      backgroundColor: 'transparent',
      cursor: this._dir === 'horizontal' ? 'col-resize' : 'row-resize',
    });

    document.body.appendChild(mask);
  }

  private _removeMask(): void {
    if (this._maskElement) {
      this._maskElement.remove();
      this._maskElement = null;
    }
  }

  public destroy(): void {
    if (this.trigger) {
      this.trigger.removeEventListener('mousedown', this._handleMouseDown);
    }
    window.removeEventListener('mousemove', this._handleMouseMove);
    window.removeEventListener('mouseup', this._handleMouseUp);
  }
}
