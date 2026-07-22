# Summarization Preprocessor

长文本摘要系统的预处理模块：**流式 Token 估算** + **多策略分块**（Python + LangChain + FastAPI）。

## 架构总览

```
summarization/
├── config.py              # 枚举、模型上下文窗口、任务尺寸配置表、Map-Reduce运行参数
├── schemas.py              # Pydantic 数据契约（TokenEstimateResult / Chunk / MapReduceResult / SummarizationResult ...）
├── exceptions.py           # 统一异常体系
├── tokenization.py         # 【第一步】流式 Token 长度估算
├── pipeline.py              # 分块流水线：编排第一步与第二步
├── service.py               # 端到端服务：串联 分块流水线 + Map-Reduce 归约
├── llm_client.py           # LLM 调用抽象（重试装饰器 + LangChain 适配器 + 离线测试用 FakeLLMClient）
├── prompts.py               # Map/Reduce/Refine 各阶段的 Prompt 构建（角色框定/结构化约束/防幻觉指令）
├── map_reduce.py             # Map 阶段（并发分块摘要）+ Reduce 阶段（分层归约至收敛）
├── refine.py                  # Refine 阶段（严格串行滚动精炼 + 运行中摘要长度控制）
├── readers/                 # 流式文档读取器（按格式分派）
│   ├── base.py               # 抽象接口 + TextUnit（逻辑单元）
│   ├── text_readers.py       # txt / markdown：固定缓冲区流式读取
│   ├── office_readers.py     # docx / pptx：lxml.iterparse 增量 XML 解析
│   ├── pdf_reader.py          # pdf：逐页解析
│   └── factory.py             # 按后缀名路由到具体 Reader
├── chunking/                # 【第二步】分块策略
    ├── base.py                # 抽象接口 + RawChunk
    ├── logical_chunker.py     # 按逻辑单元分块（标题/段落/幻灯片/页面）
    ├── semantic_chunker.py    # 语义分块（embedding 相似度断点，含无依赖兜底实现）
    ├── task_sizer.py          # 任务目标驱动的块大小 / 重叠比例计算
    ├── overlap.py             # 通用块重叠机制（token 级别，策略无关）
    └── factory.py             # 编排三者关系，产出最终 Chunk 列表
    
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

4. **Map-Reduce 归约链路如何避免"层数越多、幻觉越放大"**：
   - Reduce 阶段不是简单的"每两个摘要合并一次"，而是按 token 预算贪心装箱，尽量减少归约层数；
   - 每个批次只包含 1 个节点时直接透传，不发起无意义的 LLM 调用（省成本、避免不必要的改写幻觉）；
   - 每一层都记录 `child_source_indices`（血缘追溯），任意一句最终摘要都能定位到具体的原始分块，
     这是后续接入"分解-验证"式幻觉检测的必要前提；
   - Prompt 层面对 Reduce 阶段做了显式防幻觉约束：只能合并归纳已给出的信息，不能编造，
     信息冲突时要求模型明确指出冲突而非擅自取舍；
   - `max_reduce_levels` 防御性上限防止异常输入（如单条摘要本身就超大）导致归约无法收敛。

5. **Map/Reduce 阶段的生产工程细节**：有界并发（`Semaphore`）避免打满下游 LLM 服务的限流；
   指数退避重试（`RetryingLLMClient`）应对瞬时性失败；`fail_fast` 可配置为"部分分块失败即终止"
   或"跳过失败分块继续归约"；LLM 客户端通过 `LLMClient` 接口与具体供应商解耦，
   `LangChainChatModelClient` 可包装任意 LangChain `BaseChatModel`（Anthropic/OpenAI/自建模型均可）。

6. **Map-Reduce 与 Refine：两种归约策略的取舍**（`SummarizationStrategy` 枚举，与决定"怎么切"的
   `ChunkingStrategy` 是正交维度）：

   | | Map-Reduce | Refine |
   |---|---|---|
   | 执行方式 | 各分块并行 Map，再分层 Reduce | 严格按原文顺序串行滚动精炼 |
   | 延迟 | 低（并行 + O(log N) 层归约） | 高，与分块数线性相关（N 次串行调用） |
   | 信息交汇时机 | 只在 Reduce 阶段才第一次相遇 | 每一步都能看到"迄今为止的全部信息" |
   | 适合场景 | 分块数量大、追求低延迟、话题相对独立的文档 | 强调时间线/叙事连贯性、前后文强依赖的文档 |
   | 特有风险 | 归约层数越多，上一层的错误越可能被放大 | 运行中摘要可能随链条无限增长，需要专门的长度控制 |
   | 失败处理 | 可以跳过失败分块，不阻断其余分支 | 某一步失败会阻断后续所有依赖它的步骤（严格串行） |

   Refine 的核心工程难点是**运行中摘要的长度控制**：每一步的 prompt = 运行中摘要 + 新分块 +
   模板开销，三者必须共同落在可用上下文之内。本项目通过 `refine_chunk_budget_ratio` /
   `refine_summary_budget_ratio` 两个比例把可用上下文预先分配好；当运行中摘要超出预算时，
   触发一次独立的"压缩"调用（只合并同类信息、去冗余，明确禁止删减事实），压回预算之内再继续，
   避免摘要随处理进度无限膨胀最终把自己撑爆下一步的上下文。此外，Refine 会在运行时校验
   上游分块是否超过它自己的单步预算（该预算天然小于 Map-Reduce 使用的分块预算，因为要
   同时容纳运行中摘要），超限则自动二次切分，不要求调用方为 Refine 单独重新调整分块策略。

## 快速开始

```bash
pip install -r requirements.txt

# 仅分块（不调用LLM）
python examples/example_usage.py ./report.pdf --strategy logical --task summarization

# 端到端摘要：分块 + Map-Reduce 归约（默认离线演示，不发起真实LLM调用）
python examples/map_reduce_example.py ./report.pdf --strategy logical --task summarization

# 接入真实模型（以 Anthropic 为例）
export ANTHROPIC_API_KEY=sk-xxx
python examples/map_reduce_example.py ./report.pdf --model claude-sonnet-5 --real

```


## 生产环境待办（超出本次交付范围，建议后续补充）

- 幻觉检测与验证管道：对 Map-Reduce 产出的摘要做"分解-验证"（拆分为原子声明，逐条用 NLI 模型对照原文核验），本项目已通过 `child_source_indices` 血缘追溯为此打好基础。
- 分层评估体系：ROUGE/BERTScore/QA式指标/LLM-as-judge 的自动化评估 + 人工抽检工作流。
- 扫描件 PDF 的 OCR 接入（当前 `pdf_reader.py` 对无文本层页面仅做跳过 + 告警）。
- 语义分块的 Embeddings 建议显式注入生产级向量化服务（OpenAI/自建服务）， 而非依赖默认的本地模型或词袋兜底方案。
- 增加分布式追踪 / 指标埋点（分块耗时、Map/Reduce 各阶段延迟与 token 消耗、各策略触发频次、归约层数分布等）。
