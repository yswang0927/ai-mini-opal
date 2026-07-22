"""
端到端演示：文档 -> （Token估算+分块）-> Map-Reduce 归约 -> 最终摘要。

默认使用 FakeLLMClient（确定性伪 LLM，不发起真实网络请求），保证本脚本
在没有任何 API Key 的情况下也能跑通、验证整条链路的编排逻辑。

接入真实模型：
    export ANTHROPIC_API_KEY=sk-xxx
    python examples/map_reduce_example.py ./report.pdf --model claude-sonnet-5 --real

用法:
    python examples/map_reduce_example.py /path/to/document.pdf [--strategy logical] [--task summarization]
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from summarization.config import ChunkingStrategy, TaskType  # noqa: E402
from summarization.pipeline import SummarizationPreprocessor  # noqa: E402
from summarization.service import SummarizationService  # noqa: E402
from summarization.map_reduce import MapReduceSummarizer  # noqa: E402
from llm_client import FakeLLMClient, build_default_llm_client  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Map-Reduce 归约链路演示")
    parser.add_argument("file_path", type=str, help="待处理文档路径 (docx/pdf/pptx/md/txt)")
    parser.add_argument(
        "--strategy", type=str, choices=[s.value for s in ChunkingStrategy], default="logical"
    )
    parser.add_argument("--task", type=str, choices=[t.value for t in TaskType], default="summarization")
    parser.add_argument("--model", type=str, default="gpt-4o")
    parser.add_argument("--reduce-model", type=str, default=None, help="Reduce 阶段可用不同（更强）的模型")
    parser.add_argument(
        "--real", action="store_true", help="使用真实 LLM（需提前配置对应供应商的 API Key）"
    )
    args = parser.parse_args()

    preprocessor = SummarizationPreprocessor(model_name=args.model)

    if args.real:
        map_client = build_default_llm_client(args.model)
        reduce_client = build_default_llm_client(args.reduce_model) if args.reduce_model else None
    else:
        print("[提示] 使用 FakeLLMClient 离线演示，不会发起真实 LLM 调用；加 --real 接入真实模型。\n")
        map_client = FakeLLMClient()
        reduce_client = None

    summarizer = MapReduceSummarizer(
        map_client=map_client,
        reduce_client=reduce_client,
        map_model_name=args.model,
        reduce_model_name=args.reduce_model,
    )
    service = SummarizationService(preprocessor=preprocessor, summarizer=summarizer)

    result = await service.summarize(
        args.file_path,
        strategy=ChunkingStrategy(args.strategy),
        task_type=TaskType(args.task),
    )

    print("=" * 80)
    print(f"文档分块数: {result.chunking.total_chunks}")
    print(f"Map 阶段调用数: {len(result.map_reduce.map_results)}")
    print(f"Reduce 归约层数: {result.map_reduce.total_levels}")
    if result.map_reduce.failed_chunk_indices:
        print(f"⚠ 失败分块索引: {result.map_reduce.failed_chunk_indices}")
    print("=" * 80)
    print("最终摘要:\n")
    print(result.final_summary)


if __name__ == "__main__":
    asyncio.run(main())
