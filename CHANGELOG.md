# Changelog

本文件记录 MetricLore 的公开版本变化，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [Unreleased]

（无）

## [0.3.1] - 2026-08-27

### Changed

- 评测页改为分数置顶：新增分数总览卡（确定性回归与 LLM 评分分色标识），「评测体系」与「这些指标怎么算」折叠为「指标口径与评测定义」细节区。
- 评测集管理支持多套 Judge 评测集：每套独立 Key 与版本链，可从界面新建、切换并分别保存版本；LLM-as-a-Judge 报告按评测集独立评分并输出每套分数。
- Agent 回答策略约束：以简洁、专业、克制的中文陈述句收尾，不再以反问句结束或主动建议后续操作；不再提及项目不存在的看板 / 仪表盘 / 报表功能。

### Fixed

- `currentJudgeDatasetContent` 只查询 `content_json` 导致返回的评测集缺 Key / 版本字段，改为全列查询。

## [0.3.0] - 2026-08-27

### Added

- 数据工作区：CSV / Excel 上传建表，列类型与角色自动推断（时间 / 维度 / 数值 / 属性）且可微调，一键体验示例数据，数据源列表、预览与删除（被语义模型引用时受保护）。
- 多语义模型管理：注册多个语义模型（事实表、时间字段、维度自动识别），为指定模型注册原子 / 派生指标，并选择 Agent 当前模型。
- 跨模型自动路由：Agent 跨全部语义模型匹配指标并自动选择查询模型；多轮追问继承所属模型；跨模型歧义时澄清后继续；指标页按所属语义模型筛选与展示。
- 评测升级为版本化运行：每次运行记录评测集、知识与语义模型三份快照；新增数据准确率套件（对用户模型独立重算比对）与 LLM-as-a-Judge 知识问答质量评分；补充平均 / P95 耗时指标；Judge 评测集可从界面版本化管理。

### Changed

- 指标注册从单模型升级为按模型分区，同名指标在不同模型中是独立口径。
- 自定义模型维度补充常见中文别名（地区、渠道、品类等），中文追问可命中用户模型。
- `npm run verify` 纳入 `eval:data` 与 `eval:judge` 套件。

### Security

- 数据上传沿用格式与大小限制；物理表使用内部标识（`user_<uuid>`），列名白名单清洗；删除数据源带语义模型引用保护。

## [0.2.0] - 2026-08-27

### Added

- Wiki Builder：文件、文件夹与 ZIP 摄入，支持 Markdown、TXT、SQL、CSV、HTML、PDF、DOCX 和 XLSX。
- 候选知识抽取、本体校验、来源定位、冲突检测、编辑、批量审核和版本化发布。
- 持久化会话、结构化多轮上下文、澄清恢复、重试与取消。
- Agent SSE 实时事件流、消息级 Public Trace、Tool Call、Evidence 和运行数据快照。
- Agent Workbench：智能问答、Wiki 构建、审核队列、Wiki 浏览、本体图、指标、语义模型、评测和设置页面。
- 两套可直接导入的 Wiki Builder 示例：电商增长与订阅业务。
- 30 组多轮评测和 15 项 Wiki 摄入、冲突、引用、发布与索引检查。

### Changed

- 问答页升级为任务型工作台，图表、表格、来源和执行轨迹跟随每条回答展示。
- CI 使用干净依赖安装，并执行单轮、多轮、Wiki、健康、审计和依赖安全门禁。
- Node.js 最低版本调整为 22.13。

### Security

- 增加上传数量、大小、路径深度、ZIP 解压体积和压缩比限制。
- HTML 摄入移除脚本与外部资源；上传内容使用服务器生成的文件标识保存。
- Public Trace 只保存公开计划、工具摘要、证据和校验结果。

## [0.1.0] - 2026-08-26

### Added

- 基于本体、Markdown Wiki 和语义层的确定性 Agent Runtime。
- 7 个声明式 Skill Package 与受治理 Tool Registry。
- SQLite 合成数据、参数化指标查询、知识检索和答案校验。
- 初版 Web 界面、120 条单轮 Agent 评测与开源敏感信息审计。

[0.2.0]: https://github.com/wchao030410-sudo/MetricLore/releases/tag/v0.2.0
[0.3.0]: https://github.com/wchao030410-sudo/MetricLore/releases/tag/v0.3.0
[0.1.0]: https://github.com/wchao030410-sudo/MetricLore/commits/main
