from pathlib import Path

from summarization.pipeline import SummarizationPreprocessor

if __name__ == '__main__':

    from summarization.config import settings

    settings.model_context_windows['qwen3.6'] = 300000

    preprocessor = SummarizationPreprocessor(model_name="qwen3.6")

    file_path = "/home/xk/下载/AI时代流程引擎选型调研报告.docx"
    result = preprocessor.process(
        file_path,
    )

    print(result)
