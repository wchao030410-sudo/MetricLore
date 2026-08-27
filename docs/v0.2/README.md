# MetricLore v0.2 Foundation Contract

本目录是 v0.2 M0 阶段的开发基线。后续 M1–M5 按这里定义的信息架构、数据对象、API 和事件协议实施；发现需要修改契约时，先更新对应文档并在 `V0.2_ITERATION_PLAN.md` 的进度记录中说明。

## 文档

- [INFORMATION_ARCHITECTURE.md](INFORMATION_ARCHITECTURE.md)：用户旅程、导航、页面布局与交互状态。
- [DATA_MODEL.md](DATA_MODEL.md)：SQLite 表、关系、状态机、索引与迁移策略。
- [API_AND_EVENTS.md](API_AND_EVENTS.md)：HTTP API、SSE 事件、错误信封和兼容约定。

## M0 决策

1. v0.2 采用本地优先、单工作区、单用户运行模型；数据结构为后续多工作区预留 `workspace_id`，本版本不实现多租户。
2. 已发布 Wiki 继续以 Markdown 作为可版本管理的事实源；SQLite 保存摄入任务、候选、审核、会话、运行和证据等操作状态。
3. 每条用户消息触发一个独立 Agent Run，每条 Assistant 消息与一个 Run 绑定；Trace 不再作为全局“最后一次运行”。
4. 多轮上下文同时保存原始消息和结构化状态。指标、维度、时间、筛选和实体引用通过结构化状态继承。
5. 消息提交与事件订阅采用两步协议：`POST message` 创建 Run，`GET events` 使用 SSE 订阅。SSE 支持 `Last-Event-ID` 重连。
6. UI 展示公开计划、Skill、工具、数据范围、来源和校验结果；模型私有推理不进入事件、数据库或前端。
7. Wiki Builder 使用“解析 → 抽取 → 校验 → 审核 → 发布”状态机。自动抽取只产生候选，发布需要显式审核决定。
8. 所有 ID 使用带资源前缀的 UUID，例如 `conv_<uuid>`、`run_<uuid>`；所有时间使用 UTC ISO 8601；所有 JSON 对象包含 `schemaVersion: "0.2"`。
9. 新接口使用 `/api` 前缀并保持现有只读接口兼容。破坏性变更在 v0.2 内通过新增端点完成。
10. 默认上传门槛为每任务 50 个文件、100 MB；限制可配置，安全校验先于解析和抽取。

## 阶段边界

M0 只交付契约文档。数据库迁移器、表结构、服务、端点和 UI 分别在 M1–M5 实现，并由对应阶段的测试和验收确认。
