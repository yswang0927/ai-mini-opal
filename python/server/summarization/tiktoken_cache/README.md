# tiktoken 离线词表缓存

本目录随包内置 tiktoken 词表,供 Electron 打包后在离线 / 局域网环境使用,
避免运行时从 `openaipublic.blob.core.windows.net` 下载。

`tokenization.py` 在导入 tiktoken 之前会把 `TIKTOKEN_CACHE_DIR` 指向本目录
(仅当用户未显式设置该环境变量时)。

内置两个编码器:

- **cl100k_base**(默认,见 `tokenization.py` 的 `_DEFAULT_ENCODING`)——
  GPT-3.5/4 一代,对中文约 1 token/字,会高估中文约 40%,但方向"安全"
  (偏早触发分块,不会漏切超窗)。
- **o200k_base**(已 vendored,当前未启用)—— GPT-4o 一代,词表约 20 万,
  对中文约 0.7 token/字,更接近新模型的真实分词。若文档以中文为主、在意分块
  粒度与归约成本,可把 `_DEFAULT_ENCODING` 改为 `o200k_base`。

## 文件命名规则

tiktoken 用「词表下载 URL 的 SHA1」作为缓存文件名,不能随意重命名。

- `cl100k_base` → `.../encodings/cl100k_base.tiktoken`
  → SHA1 = `9b5ad71b2ce5302211f9c61530b329a4922fc6a4`
- `o200k_base` → `.../encodings/o200k_base.tiktoken`
  → SHA1 = `fb374d419588a4632f3f557e76b4b70aebbca790`

## 重新生成 / 升级

在**能联网**的机器上执行(会把词表下载到本目录):

```bash
cd python/server
TIKTOKEN_CACHE_DIR="$(pwd)/summarization/tiktoken_cache" \
  python -c "import tiktoken; tiktoken.get_encoding('cl100k_base'); tiktoken.get_encoding('o200k_base')"
```

若换了其他编码器,先算出对应文件名再确认:

```python
import hashlib
url = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
print(hashlib.sha1(url.encode()).hexdigest())
```

## 打包注意

- 确保打包配置(PyInstaller / electron 资源拷贝)**包含本目录及其二进制文件**,
  且不要因 `.gitignore` / 打包过滤规则被排除。
- 该文件是二进制词表,约 1.6MB,应纳入版本控制。
