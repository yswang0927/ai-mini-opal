"""
命令行演示：对本地文件执行「Token估算 + 分块」完整流水线。

用法:
    python examples/example_usage.py /path/to/document.pdf --strategy semantic --task summarization
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from summarization.config import ChunkingStrategy, TaskType  # noqa: E402
from summarization.pipeline import SummarizationPreprocessor  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

def main() -> None:
    parser = argparse.ArgumentParser(description="摘要预处理流水线演示")
    parser.add_argument("file_path", type=str, help="待处理文档路径 (docx/pdf/pptx/md/txt)")
    parser.add_argument(
        "--strategy",
        type=str,
        choices=[s.value for s in ChunkingStrategy],
        default=ChunkingStrategy.LOGICAL.value,
    )
    parser.add_argument(
        "--task",
        type=str,
        choices=[t.value for t in TaskType],
        default=TaskType.SUMMARIZATION.value,
    )
    parser.add_argument("--model", type=str, default="gpt-4o")
    args = parser.parse_args()

    preprocessor = SummarizationPreprocessor(model_name=args.model)
    result = preprocessor.process(
        args.file_path,
        strategy=ChunkingStrategy(args.strategy),
        task_type=TaskType(args.task),
    )

    print("=" * 80)
    print(f"模型: {args.model}")
    print(f"Token 估算: {result.token_estimate.total_tokens} "
          f"(可用窗口: {result.token_estimate.usable_context_tokens}, "
          f"超限: {result.token_estimate.exceeds_limit})")
    print(f"分块策略: {result.strategy.value} | 任务类型: {result.task_type.value if result.task_type else '-'}")
    print(f"总块数: {result.total_chunks}")
    print("=" * 80)

    for chunk in result.chunks:
        meta = chunk.metadata
        preview = chunk.content[:120].replace("\n", " ")
        print(
            f"[Chunk {meta.chunk_index}] tokens={meta.token_count} "
            f"unit_type={meta.logical_unit_type} overlap={meta.overlap_token_count} "
            f"| {preview}..."
        )


if __name__ == "__main__":
    main()
