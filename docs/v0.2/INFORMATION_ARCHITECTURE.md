# v0.2 信息架构与交互契约

## 1. 设计目标

MetricLore v0.2 围绕用户任务组织界面：

```text
Build knowledge → Ask → Observe → Verify → Follow up
```

一级导航使用 `Ask / Knowledge / Data / Evaluate / Settings`。Skill、Tool、Ontology、Semantic Model 等技术对象出现在任务上下文中，由用户按需展开。

## 2. 路由

| Route | 页面 | 主要任务 |
| --- | --- | --- |
| `#/ask` | Ask Home | 新建对话、恢复最近对话、使用示例问题 |
| `#/ask/:conversationId` | Conversation | 提问、查看结果、继续追问、检查 Trace 与 Evidence |
| `#/knowledge/builder` | Wiki Builder | 上传文件夹、ZIP 或多个文件，创建摄入任务 |
| `#/knowledge/jobs/:jobId` | Ingestion Job | 查看解析、抽取、校验进度和文件错误 |
| `#/knowledge/review` | Review Queue | 筛选和批量审核候选知识 |
| `#/knowledge/review/:candidateId` | Candidate Review | 对照原文编辑实体、关系与冲突决定 |
| `#/knowledge/wiki` | Wiki Explorer | 搜索和浏览已发布页面 |
| `#/knowledge/wiki/:key` | Wiki Page | 查看页面、来源、版本、出边与入边 |
| `#/knowledge/ontology` | Ontology Graph | 搜索、筛选和遍历实体关系 |
| `#/data/metrics` | Metrics | 搜索指标、查看口径和血缘 |
| `#/data/semantic` | Semantic Model | 查看指标、维度、物理映射与校验状态 |
| `#/evaluate` | Evaluation | 查看评测运行与回归摘要 |
| `#/settings` | Settings | 查看模型、数据源、上传限制与本地存储状态 |

## 3. 全局布局

### 3.1 桌面端

```text
┌────────────────┬────────────────────────────────┬──────────────────────┐
│ Navigation     │ Main task                      │ Context Panel        │
│                │                                │                      │
│ + New chat     │ Conversation / Builder / Wiki  │ Run / Evidence       │
│ Recent chats   │                                │ Entity / Source      │
│ Knowledge      │                                │ Scope / Job detail   │
│ Data           │                                │                      │
│ Evaluate       │                                │                      │
└────────────────┴────────────────────────────────┴──────────────────────┘
```

- 左栏默认 248 px，可折叠为 72 px。
- 主工作区最小宽度 560 px，保持滚动上下文。
- Context Panel 默认 360 px，可折叠；点击 Trace、引用、实体或文件时切换内容。
- Composer 固定在主工作区底部，消息列表独立滚动。

### 3.2 小屏幕

- 一级导航收拢到抽屉。
- Context Panel 变为底部抽屉。
- Trace 与 Evidence 保留在消息卡片内，支持逐层展开。
- 表格默认横向滚动，图表使用单列布局。

## 4. Ask 用户旅程

### 4.1 空状态

首页提供两条明确路径：

1. `Build a Wiki`：进入知识导入。
2. `Ask sample data`：使用内置数据开始对话。

同时显示：

- 当前运行模式：Deterministic / LLM。
- 当前数据源。
- 已发布 Wiki 页数、实体数和索引状态。
- 最近摄入任务或对话。

### 4.2 Conversation 页面

一条 Assistant 消息由以下区块组成：

```text
Answer
Scope chips: metric · time · dimensions · filters
Visualization: chart | table
Public run summary
Evidence and citations
Follow-up actions
```

消息的公开运行摘要显示：

- 任务能力和上下文继承。
- Skill Plan。
- 当前 Skill 和工具状态。
- 数据范围与返回行数摘要。
- 来源数量和校验结果。

公开摘要不展示模型原始思维链。建议文案使用可验证事件，例如“沿用近 14 天范围”“正在查询收入指标”“已找到 3 条来源”。

### 4.3 运行状态

| 状态 | UI |
| --- | --- |
| Queued | 消息占位、可取消 |
| Planning | 显示任务目标和已继承上下文 |
| Running | 展开步骤列表，当前步骤显示进度 |
| Needs clarification | 在消息内显示候选选项，选择后恢复 Run |
| Validating | 显示数字、范围和引用校验 |
| Completed | 回答、图表、Trace 和 Evidence 完整展示 |
| Failed | 错误卡片显示失败阶段、可重试操作和诊断 ID |
| Cancelled | 保留已完成步骤，提供重新运行 |

### 4.4 多轮上下文

Composer 上方显示当前上下文条：

```text
收入 × 近 14 天 × 地区：华东 × 日粒度
```

用户可以移除某个条件。Agent 在回答中明确标记继承项和本轮新增项。澄清选择写入会话上下文并触发原计划恢复。

## 5. Wiki Builder 用户旅程

### 5.1 上传

上传区支持：

- 拖拽多个文件。
- 选择文件夹。
- 选择 ZIP。
- 查看格式、文件数和大小限制。
- 选择抽取模式：Local rules / LLM assisted。

选择云端 LLM assisted 时，在开始前展示将发送的内容类型、模型地址和隐私提示。

### 5.2 任务进度

任务页面分三层展示：

1. 总体阶段：Uploading / Parsing / Extracting / Validating / Awaiting review。
2. 文件列表：格式、大小、状态、候选数量、错误。
3. 事件日志：只显示公开阶段与诊断，不显示模型私有推理。

失败文件支持单独重试，成功文件无需重复处理。

### 5.3 Review Queue

默认列表字段：

- 实体标题和类型。
- 来源文件与定位。
- 状态。
- 校验问题。
- 重复/冲突标记。
- 置信度与抽取方式。

支持按任务、类型、状态、来源和冲突筛选。批量操作包含 Approve、Reject 和 Publish approved。

### 5.4 Candidate Review

```text
┌──────────────────────────┬───────────────────────────┐
│ Source preview           │ Candidate editor          │
│ page / section / sheet   │ type / title / key        │
│ highlighted evidence     │ definition / aliases      │
│                          │ relations / validation    │
└──────────────────────────┴───────────────────────────┘
```

关系目标从现有实体和同一任务候选中选择。发现重复时显示现有页面与候选差异，用户选择 Merge、Create separately 或 Reject。

### 5.5 发布结果

发布完成页显示：

- 新建、更新、合并、驳回数量。
- Wiki 版本和健康检查结果。
- FTS 与图谱更新时间。
- `Ask this Wiki` 主操作。

## 6. Knowledge 与 Data 页面

### Wiki Explorer

- 左侧目录和类型筛选。
- 中间页面正文。
- 右侧来源、版本、关系和反向引用。
- 搜索结果展示命中章节和来源定位。

### Ontology Graph

- 支持实体类型、关系类型和状态筛选。
- 节点搜索后聚焦一跳或两跳子图。
- 点击节点在 Context Panel 打开详情。
- 图谱布局提供 Fit、Center、Depth 和 Reset。

### Metrics 与 Semantic Model

- Metrics 使用可搜索表格，展示指标类型、公式、维度、来源和状态。
- 点击指标打开定义、关系、可用维度和示例问题。
- Semantic Model 展示业务对象到物理字段的映射和校验结果。

## 7. 视觉与组件约束

- 采用研究工作台风格：暖灰画布、深墨文字、精细边界和高信息密度。
- 电光绿用于运行与主操作，蓝色用于数据，琥珀色用于审核，红色用于错误与冲突。
- 状态同时使用图标、文字与颜色表达。
- 核心组件：MessageCard、RunTimeline、EvidenceList、ScopeBar、JobProgress、CandidateDiff、EntityGraph、DataView。
- 所有交互支持键盘焦点；图标按钮提供可访问名称；动效遵循 reduced-motion。

## 8. 页面级验收

- 新用户从空状态进入 Wiki Builder 不超过 1 次点击。
- 发布完成后进入第一次提问不超过 1 次点击。
- 每条回答的 Trace 和 Evidence 可在原消息内打开。
- 多轮上下文在提问前可见、可编辑。
- 任务和运行失败都提供阶段、诊断 ID 和恢复操作。
- 页面刷新后对话、任务、审核和运行状态可恢复。
