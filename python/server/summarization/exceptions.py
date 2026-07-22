"""统一异常体系，便于 FastAPI 异常处理器按类型返回标准化错误响应。"""


class PreprocessorError(Exception):
    """所有本模块自定义异常的基类。"""


class UnsupportedDocFormatError(PreprocessorError):
    """不支持的文档格式。"""


class DocumentReadError(PreprocessorError):
    """文档读取/解析失败（损坏文件、编码错误、加密文档等）。"""


class TokenEstimationError(PreprocessorError):
    """Token 估算过程失败（如 tiktoken 编码器加载失败）。"""


class ChunkingError(PreprocessorError):
    """分块过程失败。"""


class SummarizationError(PreprocessorError):
    """LLM 摘要调用失败（含重试耗尽后的最终失败）。"""


class MapReduceError(PreprocessorError):
    """Map-Reduce 归约链路失败。携带已成功/失败的分块索引，便于上层决定重试范围。"""

    def __init__(self, message: str, failed_indices: list[int] | None = None):
        super().__init__(message)
        self.failed_indices = failed_indices or []


class ConfigurationError(PreprocessorError):
    """配置错误（如未知模型名、非法任务类型等）。"""
