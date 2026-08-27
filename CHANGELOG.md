# Changelog

本文件记录 MetricLore 的公开版本变化，格式参考 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

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
[0.1.0]: https://github.com/wchao030410-sudo/MetricLore/commits/main

