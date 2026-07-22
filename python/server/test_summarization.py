from pathlib import Path

from summarization.pipeline import SummarizationPreprocessor

if __name__ == '__main__':

    preprocessor = SummarizationPreprocessor(model_name="qwen3.6", max_context_tokens=3000)

    #file_path = "/home/xk/下载/AI时代流程引擎选型调研报告.md"
    file_path = "/home/xk/下载/环境使用指导书.pdf"
    result = preprocessor.process(
        file_path,
    )
    print(">> total_chunks: ", result.total_chunks)
    print(">> token_estimate: ", result.token_estimate)
    print(result)
