# Opie 工具 Schema 设计(路径A:工具调用架构)

## 0. 整体架构

```
用户一句话需求
      │
      ▼
  Opie (LLM) ──调用──▶ 工具层 (7个工具)
      │                    │
      │                    ▼
      │              后端编译器 (id分配/坐标计算/embed URI映射/端口命名)
      │                    │
      ▼                    ▼
  对话回复            实际 Opal JSON (nodes + edges)
```

Opie 只负责"决策"——建什么类型的节点、写什么 prompt、连到哪、挂什么工具。所有 JSON 里那些细节全部由工具执行层在收到调用后生成,Opie 从不接触。

---

## 1. 工具总览

| 工具名 | 作用 | 对应JSON节点类型                          |
|---|---|-------------------------------------|
| `graph_get_overview` | 读取当前图状态 | —                                   |
| `create_input_step` | 创建"询问用户"节点 | `user-inputs`                       |
| `create_agent_step` | 创建Agentic计算/生成节点 | `agent-generate`                    |
| `create_render_step` | 创建HTML渲染输出节点 | `render-outputs` |
| `edit_step` | 修改已有节点的prompt/配置 | —                                   |
| `remove_step` | 删除节点(自动清理相关edges) | —                                   |
| `manage_connection` | 增/删 parent连线或route | —                                   |
| `set_graph_metadata` | 设置图的标题/描述/标签 | 顶层 `metadata`/`title`/`description` |

---

## 2. 详细 Schema 定义

### 2.1 `graph_get_overview`(只读,建图前必须先调用)

```json
{
  "name": "graph_get_overview",
  "description": "获取当前图的完整结构:所有节点(含step_id、title、type、prompt摘要)和所有连线关系。建图或编辑前必须先调用此工具了解现状。",
  "input_schema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**返回示例**(供LLM读取,非用户可见):
```json
{
  "nodes": [
    {"step_id": "n_a1b2", "title": "Height Cm", "step_type": "input"},
    {"step_id": "n_c3d4", "title": "Calculate BMI And Category", "step_type": "agent",
     "prompt_preview": "Calculate BMI using formula...", "tools": [], "parents": ["n_a1b2"]}
  ],
  "edges": [
    {"from": "n_a1b2", "to": "n_c3d4", "relation": "parent"}
  ]
}
```

---

### 2.2 `create_input_step`

对应 JSON 里 `ask_user_height_cm` 这类节点。这类节点配置最简单,不需要 tools/routes/parents(它本身是图的起点)。

```json
{
  "name": "create_input_step",
  "description": "创建一个向用户询问信息的输入节点。用于收集用户需要提供的原始数据(数字、文本、选择等)。这是图的起点节点,通常没有上游连接。",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "节点标题,简短明确,如'Height Cm'、'User Email'。用户在画布上看到的就是这个标题。"
      },
      "question_text": {
        "type": "string",
        "description": "向用户展示的提问文案,如'Enter your height in centimeters.'"
      },
      "modality": {
        "type": "string",
        "enum": ["Text", "Any", "Image", "Audio"],
        "description": "期望的输入模态。大多数场景用'Any'即可,除非明确要求特定输入类型(如仅接受图片上传)。"
      }
    },
    "required": ["title", "question_text"]
  }
}
```

**编译规则(后端)**:
- 生成 `step_id`(如 `input_{slug}_{短hash}`)
- `type` 固定映射为 `user-inputs`
- `configuration.description.content` = `question_text`
- `configuration.p-modality` = `modality`(默认 `"Any"`)
- 坐标:所有input类型节点统一分配在 `x=250`,`y` 按创建顺序间隔150递增(250, 450, 600...)

---

### 2.3 `create_agent_step`(核心工具,对应原prompt里"Composing a Step Prompt"整套方法论)

```json
{
  "name": "create_agent_step",
  "description": "创建一个自主Agentic计算/生成节点,由Gemini驱动完成一个目标性任务(计算、分析、生成文本/图像/视频/音频、多轮对话等)。这是图里最核心的节点类型。",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "节点标题,概括该step的职责,如'Calculate BMI And Category'"
      },
      "prompt": {
        "type": "string",
        "description": "纯目标性文本(objective),不含任何标签语法。按角色/目标→编号任务→返回值的结构撰写。不要在文本里插入<parent>/<tool>等标签——上下游关系和工具通过下面的结构化字段声明。"
      },
      "parents": {
        "type": "array",
        "items": {"type": "string"},
        "description": "上游节点的step_id列表(通过graph_get_overview或此前create调用的返回值获取)。这些节点的输出会作为context注入到本节点。"
      },
      "tools": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["search-web", "get-webpage", "code-execution", "memory"]
        },
        "description": "本节点需要挂载的工具能力列表。"
      },
      "generation_capabilities": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["text", "image", "video", "speech", "music"]
        },
        "description": "本节点需要用到的生成模态,默认为['text']。若涉及生成图片/视频/语音/音乐需显式声明,后端会据此配置对应模型。"
      },
      "enable_chat": {
        "type": "boolean",
        "description": "是否需要与用户进行多轮对话(而非单次执行)。true时prompt中应包含'chat with user'一类的意图描述。"
      },
      "enable_memory": {
        "type": "boolean",
        "description": "是否启用持久化记忆(跨session保留状态)。"
      },
      "routes": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "target_step_id": {"type": "string", "description": "路由目标节点的step_id"},
            "label": {"type": "string", "description": "该路由的语义标签,如'Morning'/'Evening',会体现在prompt里指导agent何时选择该路由"}
          },
          "required": ["target_step_id", "label"]
        },
        "description": "若该节点需要条件路由(只走其中一条出边而非全部),在此声明所有候选路由。"
      },
      "expected_output": {
        "type": "string",
        "description": "该节点应返回的最终结果描述,如'BMI值和健康评估的字符串'。对应prompt结构里的'What to return'部分。"
      }
    },
    "required": ["title", "prompt", "expected_output"]
  }
}
```

**编译规则(后端)**:
- `type` 固定映射为 `agent-generate`
- `configuration.generation-mode` = `"agent"`
- `configuration.config$prompt.content` = 拼接 `prompt` + 自动追加的"Output Format"段(嵌入`expected_output`)+ 自动追加的"User Input/Context"段(遍历`parents`,为每个生成 `{{"type":"in","path":"{parent_id}","title":"{parent_title}"}}`占位符)
- `tools` 列表 → 编译为对应的工具挂载配置(具体字段视Opal底层schema而定,不在prompt文本里出现标签)
- `routes` → 为每个route生成一条 `edge`,并在prompt文本追加路由决策说明(如"若...则前往{label}对应节点")
- `metadata.step_intent` = 由 `prompt` + `expected_output` 自动摘要生成(供UI悬浮提示用,不需要LLM单独提供)
- 坐标:按图的拓扑深度(depth)分配 `x`,同深度节点按`y`间隔排布,复用现有BMI JSON里的模式(depth0=250, depth1=720, depth2=1100...)

---

### 2.4 `create_render_step`

对应 `node_step_bmi_result_page`。这个节点的关键特殊性:**双层prompt**——用户可控的视觉设计需求 + 系统固定的HTML生成规范。原JSON里的 `system-instruction` 内容(Tailwind CDN、禁止外链嵌入、禁止虚构footer等)是**产品级常量**,不该由LLM每次重新生成,而应作为工具内置模板,LLM只填视觉设计部分。

```json
{
  "name": "create_render_step",
  "description": "创建一个最终展示页面节点,将上游数据渲染为一个自包含的HTML结果页。用于图的终点,呈现给用户看的可视化结果。",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "节点标题,如'Design Dashboard'"
      },
      "parents": {
        "type": "array",
        "items": {"type": "string"},
        "description": "需要展示的数据来源节点的step_id列表。注意:(1)通常应包含原始输入节点(而非仅计算结果节点),避免渲染节点只能从自然语言结果里反推原始数值;(2)若图中存在图像/视频/语音生成类agent节点且design_brief要求展示其产物,该节点必须包含在parents里——渲染节点的系统级规则禁止编造媒体URL,只能渲染上游明确传入的媒体,遗漏连线会导致设计要求的媒体位置渲染为空。"
      },
      "design_brief": {
        "type": "string",
        "description": "视觉设计需求描述:整体氛围/vibe、配色方案(可含条件配色规则,如按结果分类变色)、布局分区(header/hero/grid/footer等)、关键组件说明。不需要提及技术实现细节(Tailwind/CSP等),那部分是系统固定模板。注意:若涉及footer,只能描述为免责声明/说明性文字(如医疗免责声明、日期),不要描述为版权/法律声明类内容(如'All rights reserved')——系统固定模板对后者有硬性禁止规则,写了也不会生效。"
      }
    },
    "required": ["title", "parents", "design_brief"]
  }
}
```

**编译规则(后端)**:
- `type` 固定映射为 `render-outputs`
- `configuration.text.content` = `design_brief` + 自动追加所有`parents`的变量占位符
- `configuration.system-instruction` = **固定常量模板**(即示例JSON里那段"You are an AI Web Developer..."全文),对所有render节点复用,LLM不参与生成,只做版本化维护
- `configuration.p-render-mode` = `"Auto"`,`b-render-model-name` = 系统默认值(如`"gemini-flash"`)

---

### 2.5 `edit_step`

```json
{
  "name": "edit_step",
  "description": "修改一个已存在节点的配置。只需传入需要变更的字段,未传字段保持原值。",
  "input_schema": {
    "type": "object",
    "properties": {
      "step_id": {"type": "string", "description": "目标节点的step_id"},
      "title": {"type": "string", "description": "新标题(可选)"},
      "prompt": {"type": "string", "description": "新的prompt/design_brief文本(可选,字段含义视节点类型而定)"},
      "tools": {
        "type": "array",
        "items": {"type": "string"},
        "description": "覆盖式设置工具列表(可选,仅agent节点适用)"
      },
      "enable_chat": {"type": "boolean", "description": "(可选,仅agent节点适用)"},
      "enable_memory": {"type": "boolean", "description": "(可选,仅agent节点适用)"}
    },
    "required": ["step_id"]
  }
}
```

---

### 2.6 `remove_step`

```json
{
  "name": "remove_step",
  "description": "删除一个节点。会自动清理所有与之相关的连线(该节点的parents引用和作为其他节点parent的引用)。",
  "input_schema": {
    "type": "object",
    "properties": {
      "step_id": {"type": "string", "description": "要删除的节点的step_id"}
    },
    "required": ["step_id"]
  }
}
```

---

### 2.7 `manage_connection`

统一管理两类连线(parent依赖 / route路由),避免拆成4个工具。

```json
{
  "name": "manage_connection",
  "description": "增加或移除节点之间的连线,支持数据依赖连线(parent)和条件路由连线(route)两种类型。",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["add", "remove"]},
      "connection_type": {"type": "string", "enum": ["parent", "route"]},
      "source_step_id": {"type": "string", "description": "起点节点step_id"},
      "target_step_id": {"type": "string", "description": "终点节点step_id"},
      "route_label": {
        "type": "string",
        "description": "仅当connection_type为route且action为add时需要,描述该路由的选择条件语义"
      }
    },
    "required": ["action", "connection_type", "source_step_id", "target_step_id"]
  }
}
```

---

### 2.8 `set_graph_metadata`

```json
{
  "name": "set_graph_metadata",
  "description": "设置或更新整个图的标题、描述、标签。",
  "input_schema": {
    "type": "object",
    "properties": {
      "title": {"type": "string"},
      "description": {"type": "string"},
      "tags": {"type": "array", "items": {"type": "string"}}
    },
    "required": []
  }
}
```

---

## 3. 完整调用序列示例:还原BMI计算器

用户输入:"我要一个计算身高体重的BMI计算器"

```
1. graph_get_overview()
   → 空图

2. set_graph_metadata(
     title="BMI Pulse",
     description="Calculate your Body Mass Index quickly with this simple health tool.",
     tags=["Calculator", "Fitness", "Health"]
   )

3. create_input_step(
     title="Height Cm",
     question_text="Enter your height in centimeters."
   )
   → 返回 step_id = "n_height"

4. create_input_step(
     title="Weight Kg",
     question_text="Enter your current weight in kilograms."
   )
   → 返回 step_id = "n_weight"

5. create_agent_step(
     title="Calculate BMI And Category",
     prompt="Act as a health metrics calculator. Calculate the Body Mass Index using the formula BMI = weight_kg / ((height_cm / 100) ** 2). Categorize the result into standard categories: Underweight (BMI < 18.5), Normal weight (18.5-24.9), Overweight (25-29.9), Obese (BMI >= 30).",
     parents=["n_height", "n_weight"],
     expected_output="A clear string stating the calculated BMI value rounded to one decimal place and the health category."
   )
   → 返回 step_id = "n_bmi"

6. create_render_step(
     title="Design Dashboard",
     parents=["n_height", "n_weight", "n_bmi"],
     design_brief="Premium health-focused BMI dashboard, 'Clean Wellness' vibe. Hero section with large BMI value + color-coded health category badge (Emerald=Normal, Amber=Under/Overweight, Coral=Obese). Two-column grid below showing original height/weight. Reference scale showing all 4 categories. Minimalist header + low-contrast footer disclaimer."
   )
   → 返回 step_id = "n_dashboard"
```

**关键点**:每次`create_*`调用都不需要LLM关心embed URI、坐标、端口命名——这些全部在第3~6步的后端编译阶段自动生成,和原JSON里的字段完全对应。

---

## 4. 需要同步修改原有 Opie 提示词的地方

| 原提示词内容 | 建议修改 |
|---|---|
| "To express connections... use `<parent>`, `<tool>`, `<file>`, `<a>` 标签" | 改为:"通过工具调用的`parents`/`tools`/`routes`参数声明,不要在prompt文本里写标签" |
| "Steps are always created as Generate steps with Agent mode" | 保留,但改为:"调用`create_agent_step`时后端会自动设置" |
| Tool chip映射表(供解释给用户用) | 保留不变——这部分是解释UI层的,和工具调用架构无关 |
| "Use graph_get_overview first" | 保留,现在是真实工具而非隐喻 |
| render节点的system-instruction写法 | 移除——不再需要Opie知道这段内容,已固化进`create_render_step`后端模板 |

---

## 5. 一个需要你决定的开放问题

**路由(routes)的时序问题**:如果用户要求"根据BMI结果走不同分支",那么`create_agent_step`调用时,分支目标节点可能还不存在(还没创建)。两种处理方式:

- **方案1**:先创建所有目标节点,再创建带routes的源节点(要求LLM做拓扑排序式的调用顺序规划)
- **方案2**:允许`routes`里的`target_step_id`留空占位,创建后用`manage_connection`补充连线(更灵活,但多一轮调用)

建议采用方案1,并在提示词的"Editing Tips"里加一条:"当计划创建带路由的节点时,先创建所有可能的路由目标节点,再创建带routes参数的源节点。"这样能避免设计一个"占位id"机制的额外复杂度。

---

## 6. `create_render_step` 固定模板与相关设计约束

### 6.1 固定常量:`b-system-instruction` 全文

以下文本是 `create_render_step` 编译出的每个渲染节点共享的系统指令,**在后端存为常量,不对Opie暴露,Opie不参与其生成或修改**。产品迭代时若要调整渲染节点的通用行为(比如换CSS框架、放宽某条限制),直接改这份常量,不涉及提示词或工具schema变更。

```
You are an AI Web Developer. Your task is to generate a single, self-contained HTML document for rendering in an iframe, based on user instructions and data.

**Visual aesthetic:**
    * Aesthetics are crucial. Make the page look amazing, especially on mobile.
    * Respect any instructions on style, color palette, or reference examples provided by the user.
    * **CRITICAL: Aim for premium, state-of-the-art designs. Avoid simple minimum viable products.**
    * **Use Rich Aesthetics**: The USER should be wowed at first glance by the design. Use best practices in modern web design (e.g. vibrant colors, dark modes, glassmorphism, and dynamic animations) to create a stunning first impression. Failure to do this is UNACCEPTABLE.
    * **Prioritize Visual Excellence**: Implement designs that will WOW the user and feel extremely premium:
        - Avoid generic colors (plain red, blue, green). Use curated, harmonious color palettes (e.g., HSL tailored colors, sleek dark modes).
        - Using modern typography (e.g., from Google Fonts like Inter, Roboto, or Outfit) instead of browser defaults.
        - Use smooth gradients.
        - Add subtle micro-animations for enhanced user experience.
    * **Use a Dynamic Design**: An interface that feels responsive and alive encourages interaction. Achieve this with hover effects and interactive elements. Micro-animations, in particular, are highly effective for improving user engagement.
    * **Thematic Specificity**: Do not just create a generic layout. Define a clear "vibe" or theme based on the content. Use specific aesthetic keywords (e.g., "Glassmorphism", "Neobrutalism", "Minimalist", "Comic Book Style") to guide the design.
    * **Typography Hierarchy**: Explicitly import and use font pairings. Use a distinct Display Font for headers and a highly readable Body Font for text.
    * **Readability**: Pay extra attention to readability. Ensure the text is always readable with sufficient contrast against the background. Choose fonts and colors that enhance legibility.

**Design and Functionality:**
    * **Component-Based Design**: Do not just dump text into blocks. Semanticize the content into distinct UI components.
    * **Layout Dynamics**: Break the grid. Avoid strict, identical grid columns. Use asymmetrical layouts, Bento grids, or responsive flexbox layouts where some elements span full width to create visual interest and emphasize key content.
    * **Tailwind Configuration**: Extend the Tailwind configuration within a `<script>` block to define custom font families and color palettes that match the theme.
    * Thoroughly analyze the user's instructions to determine the desired type of webpage, application, or visualization. What are the key features, layouts, or functionality?
    * Analyze any provided data to identify the most compelling layout or visualization of it. For example, if the user requests a visualization, select an appropriate chart type (bar, line, pie, scatter, etc.) to create the most insightful and visually compelling representation. Or if user instructions say `use a carousel format`, you should consider how to break the content and any media into different card components to display within the carousel.
    * If requirements are underspecified, make reasonable assumptions to complete the design and functionality. Your goal is to deliver a working product with no placeholder content.
    * Ensure the generated code is valid and functional. Return only the code, and open the HTML codeblock with the literal string "```html".
    * The output must be a complete and valid HTML document with no placeholder content for the developer to fill in.

**Libraries:**
  Unless otherwise specified, use:
    * Tailwind for CSS
    * **CRITICAL: Use the Tailwind CDN from `https://cdn.tailwindcss.com`. Do NOT use `tailwind.min.css` or any other local Tailwind file. Always include Tailwind using: `<script src="https://cdn.tailwindcss.com"></script>`**

**Constraints:**
  * **External Links:** You ARE allowed to generate external links (`<a href="...">` and `window.open(...)`) to external websites (e.g. google.com, wikipedia.org) for user navigation.
  * **NO External Embeds:** Do NOT embed any external resources (e.g. `<script src="...">`, `<img src="...">`, `<iframe src="...">`, `<link href="...">`) from external URLs. Content Security Policy (CSP) will block them.
  * **Media Restriction:** ONLY use media URLs that are explicitly passed in the input. Do NOT generate or hallucinate any other media URLs (e.g. from placeholder sites or external CDNs).
  * **Render All Media:** You MUST render ALL media (images, videos, audio) that are passed in. Do NOT skip or omit any provided media items. Every passed-in media URL must appear in the final HTML output.
  * **Navigation Restriction:** Do NOT generate unneeded fake links or buttons to sub-pages (e.g. "About", "Contact", "Learn More") unless explicitly requested. Stick to the plan and the provided content.
  * **Footer Restriction:** **NEVER** generate any footer content, including legal footers like "All rights reserved" or "Copyright 2024". [It is a violation of Google's policies to hallucinate legal footers.]
```

### 6.2 三条隐含约束 → 反推到工具设计上的具体动作

这段系统指令虽然不给Opie看,但其中几条硬性规则会直接限制"什么样的design_brief/parents组合是有效的"。已在2.4节工具schema里落地为description补丁,这里统一列出对照关系,方便review:

| 系统指令原句 | 隐含约束 | 已落地的schema改动 |
|---|---|---|
| "ONLY use media URLs that are explicitly passed in the input" + "You MUST render ALL media... that are passed in" | 渲染节点不能编造媒体URL,只能渲染parents传入的;反过来说,想展示的媒体必须先连线进来 | `create_render_step.parents` description补充第(2)条 |
| "**NEVER** generate any footer content, including legal footers... violation of Google's policies" | 禁止版权/法律类footer文案,但不禁止免责声明/说明性文案(二者需要在design_brief措辞层面区分,否则可能被系统指令连带过滤掉合理的disclaimer) | `create_render_step.design_brief` description补充措辞边界提醒 |
| "Do NOT generate unneeded fake links or buttons to sub-pages... unless explicitly requested" | design_brief里不该无依据地加导航按钮(如"Back"、"Recalculate"),除非用户明确要求或图结构本身需要这种交互(如迭代式review流程) | 建议:Opie在撰写design_brief前,先确认该按钮对应的交互是否真的存在于图里(比如是否有route连回上游节点),而不是习惯性加上 |

### 6.3 新增校验规则(建议加入后端`create_render_step`执行前的校验逻辑)

```
校验:媒体节点连线完整性
IF design_brief 中提及展示图片/视频/音频
   AND parents 中不包含任何 generation_capabilities 含
       image/video/speech/music 的 agent 节点
THEN 阻止创建并向 Opie 返回错误提示:
     "design_brief中提到展示媒体内容,但parents未包含对应的媒体生成节点。
      请检查是否需要将该媒体生成节点加入parents列表。"
```

这条校验放在工具执行层(而不是指望Opie自己记住这条规则),是因为——即便提示词里写清楚了这条约束,LLM在多轮编辑、图结构变复杂时仍可能漏连,工具层做硬校验比指望prompt自律更可靠。这也是路径A(工具调用架构)相对于路径B(直接生成JSON)的一个实际优势:**关键正确性约束可以下沉到确定性代码里做校验,而不必全部依赖LLM的指令遵循能力。**
