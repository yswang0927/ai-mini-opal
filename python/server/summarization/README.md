# Summarization Preprocessor

长文本摘要系统的预处理模块：**流式 Token 估算** + **多策略分块**（Python + LangChain + FastAPI）。

## 架构总览

```
summarization/
├── config.py              # 枚举、模型上下文窗口、任务尺寸配置表
├── schemas.py              # Pydantic 数据契约（TokenEstimateResult / Chunk / ChunkingResult）
├── exceptions.py           # 统一异常体系
├── tokenization.py         # 【第一步】流式 Token 长度估算
├── pipeline.py              # 主流水线：编排第一步与第二步
├── api.py                   # FastAPI 路由（文件上传 -> 分块结果）
├── readers/                 # 流式文档读取器（按格式分派）
│   ├── base.py               # 抽象接口 + TextUnit（逻辑单元）
│   ├── text_readers.py       # txt / markdown：固定缓冲区流式读取
│   ├── office_readers.py     # docx / pptx：lxml.iterparse 增量 XML 解析
│   ├── pdf_reader.py          # pdf：逐页解析
│   └── factory.py             # 按后缀名路由到具体 Reader
└── chunking/                # 【第二步】分块策略
    ├── base.py                # 抽象接口 + RawChunk
    ├── logical_chunker.py     # 按逻辑单元分块（标题/段落/幻灯片/页面）
    ├── semantic_chunker.py    # 语义分块（embedding 相似度断点，含无依赖兜底实现）
    ├── task_sizer.py           # 任务目标驱动的块大小 / 重叠比例计算
    ├── overlap.py               # 通用块重叠机制（token 级别，策略无关）
    └── factory.py                # 编排三者关系，产出最终 Chunk 列表
```

## 关键设计决策

1. **为什么能处理几百 MB 的文档而不 OOM？**
   - txt/markdown：固定大小缓冲区 (`stream_buffer_size_bytes`) 逐块读取，`io` 自动处理跨块的多字节编码边界。
   - docx/pptx：不使用 `python-docx`/`python-pptx` 的整树 DOM 加载，而是用 `zipfile` 打开压缩包内的 XML 部件，
     配合 `lxml.etree.iterparse` 做 SAX 风格增量解析，每处理完一个段落/文本节点立即 `elem.clear()` 释放内存。
   - pdf：`pypdf` 按页解析，逐页调用 `extract_text()`，峰值内存与单页大小而非全文档大小成正比。
   - Token 估算：滚动结转窗口（carry window）逐块编码，避免整篇拼接后再 tokenize；并支持提前终止（early-exit）。

2. **三种分块策略与重叠机制的关系**（详见 `chunking/factory.py` 顶部注释）：
   - 语义分块 / 逻辑单元分块 —— 决定切分边界；
   - 任务目标尺寸调整 —— 决定块应该多大、重叠多少，作为参数注入前两者；
   - 块重叠 —— 在最终块序列上统一叠加的后处理，与具体切分算法解耦。

3. **语义分块的内存边界**：语义相似度计算本质上需要"看到一段连续文本"，因此无法逐字节流式处理。
   实现上采用"有界批次"策略（默认单批次不超过 `max_chunk_tokens * 20`），在语义连贯性与内存可控性之间折中。

## 生产环境待办（超出本次交付范围，建议后续补充）

- 扫描件 PDF 的 OCR 接入（当前 `pdf_reader.py` 对无文本层页面仅做跳过 + 告警）。
- 语义分块的 Embeddings 建议显式注入生产级向量化服务（OpenAI/自建服务），而非依赖默认的本地模型或词袋兜底方案。
- 增加分布式追踪 / 指标埋点（分块耗时、token 估算耗时、各策略触发频次等）。
