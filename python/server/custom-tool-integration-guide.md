# 自定义扩展工具集成指南

本文档说明如何为 Opal 执行器新增一个运行时工具(runtime tool),方便后续持续追加。

## 背景:两套"工具"不要混淆

系统里有两套完全不同的 tool,新增运行时能力时**只关心第二套**:

| | 层 | 文件 | 谁调用 | 作用 |
|---|---|---|---|---|
| 构图工具 | Build | [opie_tools.py](opie_tools.py) | 构图 LLM | 搭建/编辑图结构(建节点、连边) |
| **运行时工具** | Runtime | [opal_runtime_tools.py](opal_runtime_tools.py) | **执行阶段的 agent 节点** | agent 真正执行时可调用的能力(算代码、读网页、读写文件……) |

一个运行时工具从"被 agent 声明"到"被真正执行",要经过 3 个地方:

```
opal_graph.TOOL_PATH_MAP        编译期:登记工具名 -> path/标题,校验并生成占位符
        │
        ▼
编译产物 prompt 里出现占位符      {{"type":"tool","path":"<path>","title":"<title>"}}
        │
        ▼
opal_executor.extract_tool_paths  执行期:从 prompt 里提取 path 列表
        │
        ▼
opal_runtime_tools.build_runtime_tools  按 path 构建 LangChain StructuredTool
        │
        ▼
agent handler bind_tools + 工具调用循环   LLM 真正调用工具
```

## 新增一个工具:5 步

以新增一个假想的 `get-weather`(查天气)工具为例。

### 第 1 步 — 在 `TOOL_PATH_MAP` 登记(opal_graph.py)

[opal_graph.py](opal_graph.py) 顶部的 `TOOL_PATH_MAP` 决定了:
- 哪些工具名是**合法的**(校验时不在表里会报错)
- 编译成占位符时用什么 `path` 和 `title`

```python
TOOL_PATH_MAP: Dict[str, Dict[str, Any]] = {
    # ...已有工具...
    "get-weather": {
        "path": "get-weather",          # 占位符里的 path,执行期靠它路由
        "display_title": "Get Weather", # 占位符里的 title(chip 显示名)
        "confirmed": True,
    },
}
```

> `path` 一般与工具名一致;只有个别历史工具例外(如 `memory` 的 path 是 `function-group/use-memory`)。保持一致最省心。

### 第 2 步 — 实现运行时工具(opal_runtime_tools.py)

在 [opal_runtime_tools.py](opal_runtime_tools.py) 里写一个 pydantic 入参模型 + 执行函数 + 工厂函数。函数返回 `str`(工具结果会作为 `ToolMessage` 回填给 LLM)。

```python
class GetWeatherInput(BaseModel):
    city: str = Field(description="城市名,例如 '北京'。")


def _get_weather(city: str) -> str:
    # 真正的实现;出错时把错误信息作为字符串返回,别抛出去
    try:
        ...  # 调 API / 计算
        return f"{city} 今天晴,26℃。"
    except Exception as e:  # noqa: BLE001
        return f"查询天气失败 ({city}): {e}"


def _make_get_weather_tool() -> StructuredTool:
    return StructuredTool.from_function(
        func=_get_weather,
        name="get_weather",              # LLM 侧的函数名,用下划线
        description="查询指定城市的当前天气。",
        args_schema=GetWeatherInput,
    )
```

约定:
- **name 用下划线**(`get_weather`),因为要作为 LLM function name;而 `path` 用连字符(`get-weather`)。
- **不要抛异常**:把失败信息当成正常返回值给 LLM,让它自己决定怎么处理。
- **控制输出体积**:大结果要截断(参考 `_FILE_MAX_BYTES`、`get-webpage` 的 12000 字符截断),避免撑爆上下文。
- **需要外部配置**时,读环境变量,未配置就返回明确提示而不是报错(参考 `search-web` 的 `TAVILY_API_KEY` 处理)。

### 第 3 步 — 在工厂里挂上 path(opal_runtime_tools.py)

在 `build_runtime_tools()` 的分支里加一条,把 path 映射到工厂函数:

```python
    elif path == "get-weather":
        tools.append(_make_get_weather_tool())
```

> 一个 path 也可以返回**多个**工具(参考 `memory` 用 `tools.extend([...])` 同时给出 remember/recall)。

### 第 4 步 — 更新工具名清单(opie_tools.py)

[opie_tools.py](opie_tools.py) 里 `create_agent_step` 工具的 `tools` 参数 description 列出了可选工具名,追加新工具让构图 LLM 知道它可用:

```python
"可选值:... code-execution, memory, read-file, write-file, get-weather"
```

### 第 5 步 — (可选)更新提示词文档

若希望构图 LLM 主动推荐该工具,在 [mini_opal_prompt_v2.md](mini_opal_prompt_v2.md) 的工具清单里补一行说明。这一步只影响"AI 会不会主动用",不影响功能是否可用。

## 验证

新增后跑一遍编译 → 提取 → 构建的闭环:

```python
from opal_graph import OpalGraphState
from opal_executor import extract_tool_paths
from opal_runtime_tools import build_runtime_tools

g = OpalGraphState()
i = g.add_input_step(title="City", question_text="哪个城市?")
g.add_agent_step(title="Weather", prompt="查天气", expected_output="天气",
                 tools=["get-weather"], parents=[i.step_id])

compiled = g.compile_to_opal_json()
prompt = compiled["nodes"][1]["configuration"]["config$prompt"]["content"]

paths = extract_tool_paths(prompt)          # 应含 'get-weather'
tools = build_runtime_tools(paths)          # 应含 name='get_weather' 的工具
print(paths, [t.name for t in tools])
```

单独测工具函数本身:

```python
tools = build_runtime_tools(["get-weather"])
tool = [t for t in tools if t.name == "get_weather"][0]
print(tool.invoke({"city": "北京"}))
```

## 检查清单

- [ ] `TOOL_PATH_MAP` 加了条目(name / path / display_title)
- [ ] `opal_runtime_tools.py` 写了 Input 模型 + 执行函数 + 工厂函数
- [ ] `build_runtime_tools()` 分支里映射了 path
- [ ] `opie_tools.py` 的可选工具清单追加了工具名
- [ ] (可选)提示词文档 `mini_opal_prompt_v2.md` 补充说明
- [ ] 跑通"编译 → extract → build"闭环验证

## 已内置的运行时工具

| 工具名 (path) | 函数名 | 说明 | 依赖 |
|---|---|---|---|
| `code-execution` | `code_execution` | 受限沙箱执行 Python,捕获 stdout | 无(仅 math/statistics/json/datetime/re/random) |
| `get-webpage` | `get_webpage` | 抓网页返回纯文本(≤12000 字符) | 无 |
| `search-web` | `search_web` | 联网搜索 | `TAVILY_API_KEY` 环境变量 |
| `memory` | `memory_remember` / `memory_recall` | 进程内 KV 记忆 | 无 |
| `search-internal` | `search_internal` | 内部知识库检索(占位未接入) | 待接入 |
| `read-file` | `read_file` | 按绝对路径读文件(≤1MB) | 无 |
| `write-file` | `write_file` | 按绝对路径写文件(覆盖,自动建父目录) | 无 |

## 注意:路由工具是特例

`control-flow/routing`(路由)也是以 tool 占位符形式出现在 prompt 里,但它**不是运行时工具** —— 它由执行器的条件路由机制单独处理。`extract_tool_paths()` 会**主动跳过**它(见 `_ROUTING_TOOL_PATH`),因此不要在 `build_runtime_tools()` 里为它建工具。
