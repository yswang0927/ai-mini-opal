"""
端到端演示：文档 -> （Token估算+分块）-> Refine 滚动精炼 -> 最终摘要。

Refine 与 Map-Reduce 的调用方式几乎一致（都通过 SummarizationService），
区别只在于底层传入的是 RefineSummarizer 而不是 MapReduceSummarizer——
这正是本项目把"归约策略"设计成可插拔组件的意义所在。

默认使用 FakeLLMClient（确定性伪 LLM），保证本脚本在没有任何 API Key 的情况下
也能跑通、验证串行链路的编排逻辑（含摘要长度压缩机制）。

用法:
    python examples/refine_example.py /path/to/document.pdf
    python examples/refine_example.py ./report.pdf --model claude-sonnet-5 --real
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
from summarization.refine import RefineSummarizer  # noqa: E402
from llm_client import FakeLLMClient, build_default_llm_client  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Refine 归约链路演示")
    parser.add_argument("file_path", type=str, help="待处理文档路径 (docx/pdf/pptx/md/txt)")
    parser.add_argument(
        "--strategy", type=str, choices=[s.value for s in ChunkingStrategy], default="logical"
    )
    parser.add_argument("--task", type=str, choices=[t.value for t in TaskType], default="summarization")
    parser.add_argument("--model", type=str, default="gpt-4o")
    parser.add_argument("--real", action="store_true", help="使用真实 LLM（需提前配置对应供应商的 API Key）")
    args = parser.parse_args()

    preprocessor = SummarizationPreprocessor(model_name=args.model)

    if args.real:
        client = build_default_llm_client(args.model)
    else:
        print("[提示] 使用 FakeLLMClient 离线演示，不会发起真实 LLM 调用；加 --real 接入真实模型。\n")
        client = FakeLLMClient()

    summarizer = RefineSummarizer(refine_client=client, model_name=args.model)
    service = SummarizationService(preprocessor=preprocessor, summarizer=summarizer)

    result = await service.summarize(
        args.file_path,
        strategy=ChunkingStrategy(args.strategy),
        task_type=TaskType(args.task),
    )

    print("=" * 80)
    print(f"文档分块数: {result.chunking.total_chunks}")
    print(f"Refine 总步数: {result.refine.total_steps} (含压缩步骤 {result.refine.total_compression_steps} 次)")
    if result.refine.failed_chunk_indices:
        print(f"⚠ 失败分块索引: {result.refine.failed_chunk_indices}")
    print("=" * 80)
    for step in result.refine.steps:
        tag = "[压缩]" if step.is_compression_step else f"[分块{step.source_chunk_indices}]"
        status = "OK" if step.succeeded else "FAIL"
        print(f"步骤{step.step_index} {tag} {status} 输出token={step.output_token_count}")
    print("=" * 80)
    print("最终摘要:\n")
    print(result.final_summary)


if __name__ == "__main__":
    asyncio.run(main())
