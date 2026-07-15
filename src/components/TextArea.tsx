import React, { useRef, useEffect, type TextareaHTMLAttributes } from 'react';

// 定义组件的 Props 类型，继承原生 textarea 的所有属性
interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoHeight?: boolean;
  maxHeight?: number;
}

const TextArea: React.FC<TextareaProps> = ({
  autoHeight = true,
  maxHeight,
  rows = 1,
  onChange,
  style,
  value,
  ...props
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (autoHeight) {
      // 1. 重置高度，方便在内容减少时正确计算收缩后的 scrollHeight
      textarea.style.height = 'auto';

      // 2. 获取当前内容的实际高度
      let targetHeight = textarea.scrollHeight;

      // 3. 如果设置了 maxHeight 且超过了限制，则锁定高度并开启滚动条
      if (maxHeight && targetHeight >= maxHeight) {
        textarea.style.height = `${maxHeight}px`;
        textarea.style.overflowY = 'auto';
      } else {
        // 未超过限制时，高度自适应，隐藏滚动条（防止右侧出现多余的白边）
        textarea.style.height = `${targetHeight}px`;
        textarea.style.overflowY = 'hidden';
      }
    }
  };

  // 监听 value 的变化（受控组件场景下非常关键）
  useEffect(() => {
    adjustHeight();
  }, [value]);

  // 处理输入事件
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    adjustHeight();
    // 触发父组件传入的 onChange 回调
    if (onChange) {
      onChange(e);
    }
  };

  return (
    <textarea
      {...props}
      ref={textareaRef}
      rows={rows}
      value={value}
      onChange={handleInputChange}
      style={{
        resize: 'none',       // 禁用右下角手动的拉伸把手
        boxSizing: 'border-box', // 确保高度计算把 padding 和 border 算进去
        display: 'block',
        width: '100%',
        ...style,             // 允许外部样式覆盖
      }}
    />
  );
};

export default TextArea;
