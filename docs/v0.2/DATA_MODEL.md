# v0.2 SQLite 数据模型契约

## 1. 存储边界

SQLite 保存运行状态；Markdown 保存已发布 Wiki 正文。

| 数据 | 存储 |
| --- | --- |
| 会话、消息、上下文 | SQLite |
| Agent Run、事件、工具调用、证据 | SQLite |
| 摄入任务、文件、分段、候选、审核决定 | SQLite |
| 已发布 Wiki 页面 | `wiki/**/*.md` |
| Wiki 版本与发布记录 | SQLite，引用 Markdown 内容哈希 |
| FTS 与图谱索引 | SQLite/内存索引，由 Markdown 发布事件刷新 |
| 界面注册的语义指标 | SQLite，启动时与基础语义模型合并 |
| 原始上传文件 | 本地工作目录，默认不进入 Git |

## 2. 通用约定

- ID：`<prefix>_<uuid>`，使用 `crypto.randomUUID()`。
- 时间：UTC ISO 8601 文本。
- JSON：TEXT 列，写入前序列化；对象包含 `schemaVersion`。
- 删除：核心记录使用状态字段和归档时间；文件清理由显式维护流程执行。
- 并发：候选实体使用 `revision` 乐观锁。
- 外键：启动后执行 `PRAGMA foreign_keys = ON`。

## 3. 语义指标注册

### semantic_metrics

基础指标和维度继续由 `config/semantic-model.json` 管理；用户在工作台新增的指标写入本表，并在启动时合并到运行时语义目录。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| key | TEXT | PK，小写 snake_case |
| definition_json | TEXT | 指标名称、定义、类型、字段或依赖、聚合、格式和别名 |
| created_at | TEXT | 非空 |
| updated_at | TEXT | 非空 |

注册在单次写入前完成物理字段、数值类型、别名冲突和派生依赖校验。当前派生指标采用两个已注册原子指标相除，并支持缩放系数。

## 4. 会话与 Agent Run

### idempotency_keys

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| scope | TEXT | 与 key 组成主键 |
| key | TEXT | `Idempotency-Key`，最长 200 字符 |
| response_json | TEXT | 首次创建返回的稳定响应 |
| created_at | TEXT | 非空 |

消息创建按会话划分 scope。相同 key 的网络重试返回同一组消息和 Run，不重复执行 Agent。

### conversations

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK，`conv_` |
| workspace_id | TEXT | v0.2 固定 `ws_local` |
| title | TEXT | 非空 |
| status | TEXT | `active/archived` |
| created_at | TEXT | 非空 |
| updated_at | TEXT | 非空 |
| last_message_at | TEXT | 可空 |

索引：`workspace_id, last_message_at DESC`。

### messages

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK，`msg_` |
| conversation_id | TEXT | FK conversations |
| run_id | TEXT | Assistant 消息关联 Agent Run，可空 |
| role | TEXT | `user/assistant/system` |
| content | TEXT | 非空 |
| status | TEXT | `pending/streaming/completed/failed/cancelled` |
| edited_from_id | TEXT | 可空 |
| created_at | TEXT | 非空 |

索引：`conversation_id, created_at`；`run_id` 唯一非空。

### conversation_context

每个会话一行，以 `version` 支持比较和回滚。

| 字段 | 类型 |
| --- | --- |
| conversation_id | TEXT PK |
| version | INTEGER |
| metrics_json | TEXT |
| dimensions_json | TEXT |
| time_range_json | TEXT |
| filters_json | TEXT |
| entities_json | TEXT |
| pending_clarification_json | TEXT |
| updated_at | TEXT |

### agent_runs

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | `run_` |
| conversation_id | TEXT | FK conversations |
| user_message_id | TEXT | 触发消息 |
| assistant_message_id | TEXT | 输出消息，可空直到创建 |
| status | TEXT | Agent 状态机 |
| capability | TEXT | knowledge/discovery/data/analysis/safety |
| provider | TEXT | deterministic/llm |
| context_before_json | TEXT | 本轮前结构化上下文 |
| context_after_json | TEXT | 本轮完成后的上下文 |
| plan_json | TEXT | Skill Plan |
| budget_json | TEXT | 步数与超时 |
| validation_json | TEXT | Answer Review 结果 |
| result_json | TEXT | 受治理查询结果快照，用于图表与表格恢复 |
| error_json | TEXT | 统一错误 |
| started_at | TEXT | 可空 |
| completed_at | TEXT | 可空 |
| created_at | TEXT | 非空 |

状态转换：

```text
queued → planning → running → validating → completed
                   ↘ needs_clarification → running
queued/planning/running/validating → failed | cancelled
```

### agent_run_events

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | `evt_` |
| run_id | TEXT | FK agent_runs |
| sequence | INTEGER | 每个 Run 从 1 递增 |
| event_type | TEXT | SSE event name |
| payload_json | TEXT | 公开载荷 |
| created_at | TEXT | 非空 |

唯一索引：`run_id, sequence`。事件不可更新，用于 SSE 重连和审计。

### tool_calls

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK |
| run_id | TEXT |
| sequence | INTEGER |
| skill_name | TEXT |
| tool_name | TEXT |
| args_json | TEXT |
| result_summary_json | TEXT |
| status | TEXT |
| started_at | TEXT |
| completed_at | TEXT |

工具结果只持久化公开摘要和范围；大结果留在查询结果存储或证据引用中。

### evidence_records

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK |
| run_id | TEXT |
| claim_index | INTEGER |
| source_type | TEXT |
| source_key | TEXT |
| source_path | TEXT |
| locator_json | TEXT |
| snippet | TEXT |
| created_at | TEXT |

来源定位示例：

```json
{"schemaVersion":"0.2","page":12,"section":"客单价","startLine":44,"endLine":48}
```

## 5. Wiki Builder

### ingestion_jobs

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`job_` |
| workspace_id | TEXT |
| name | TEXT |
| status | TEXT |
| extraction_mode | TEXT，`rules/llm_assisted` |
| options_json | TEXT |
| file_count | INTEGER |
| total_bytes | INTEGER |
| progress_json | TEXT |
| summary_json | TEXT |
| error_json | TEXT |
| created_at | TEXT |
| started_at | TEXT |
| completed_at | TEXT |

状态转换：

```text
queued → uploading → parsing → extracting → validating → awaiting_review
                                                      → publishing → completed
任意运行状态 → failed | cancelled
awaiting_review → publishing | cancelled
```

### ingestion_job_events

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| id | TEXT | PK，`jevt_` |
| job_id | TEXT | FK ingestion_jobs |
| sequence | INTEGER | 每个 Job 从 1 递增 |
| event_type | TEXT | Job SSE event name |
| payload_json | TEXT | 公开载荷 |
| created_at | TEXT | 非空 |

唯一索引：`job_id, sequence`。事件不可更新，用于任务页恢复、SSE 重连和摄入审计。

### ingestion_files

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`file_` |
| job_id | TEXT FK |
| relative_path | TEXT |
| media_type | TEXT |
| extension | TEXT |
| size_bytes | INTEGER |
| sha256 | TEXT |
| status | TEXT |
| locator_capabilities_json | TEXT |
| error_json | TEXT |
| created_at | TEXT |

唯一索引：`job_id, relative_path`；哈希索引用于同任务和跨任务重复检测。

### document_chunks

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`chunk_` |
| file_id | TEXT FK |
| ordinal | INTEGER |
| text | TEXT |
| locator_json | TEXT |
| token_count | INTEGER |
| sha256 | TEXT |

唯一索引：`file_id, ordinal`。

### knowledge_candidates

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`cand_` |
| job_id | TEXT FK |
| source_file_id | TEXT FK |
| entity_key | TEXT |
| entity_type | TEXT |
| title | TEXT |
| definition | TEXT |
| aliases_json | TEXT |
| relations_json | TEXT |
| sources_json | TEXT |
| extraction_json | TEXT |
| validation_json | TEXT |
| conflict_json | TEXT |
| status | TEXT |
| revision | INTEGER |
| created_at | TEXT |
| updated_at | TEXT |

状态：`extracted/needs_review/approved/rejected/merged/published`。

### review_decisions

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`review_` |
| candidate_id | TEXT FK |
| decision | TEXT |
| expected_revision | INTEGER |
| patch_json | TEXT |
| note | TEXT |
| created_at | TEXT |

Decision：`approve/reject/merge/request_changes`。记录不可更新。

### wiki_publications

一次发布操作对应一条不可变的批次记录。

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`pub_` |
| job_id | TEXT FK |
| version | INTEGER，工作区内递增 |
| status | TEXT，`publishing/completed/failed` |
| summary_json | TEXT |
| health_json | TEXT |
| index_refreshed_at | TEXT |
| created_at | TEXT |
| completed_at | TEXT |

### wiki_versions

| 字段 | 类型 |
| --- | --- |
| id | TEXT PK，`wver_` |
| entity_key | TEXT |
| version | INTEGER |
| action | TEXT，`create/update/merge/deprecate` |
| path | TEXT |
| content_sha256 | TEXT |
| source_candidate_id | TEXT |
| publication_id | TEXT FK wiki_publications |
| published_at | TEXT |

唯一索引：`entity_key, version`。

## 6. 状态与事务

- 一个文件的 parse/chunk 写入在单事务内完成。
- 候选批量生成以文件为事务边界，单文件失败不回滚其他文件。
- 单次发布批次在事务中写入版本记录；Markdown 使用临时文件写入后原子替换。
- FTS 与图谱刷新在发布成功后执行；刷新失败将任务标记为 `failed` 并保留可重试的发布摘要。
- SSE 事件与业务状态写入同一事务，避免 UI 收到未提交状态。
- `wiki_publications` 先以 `publishing` 写入；全部 Markdown 原子替换、版本记录和索引刷新成功后才转为 `completed`。

## 7. 迁移策略

1. 新增 `schema_migrations(version, name, applied_at, checksum)`。
2. 迁移文件使用递增编号并在事务内执行。
3. 启动时先校验 checksum，再执行未应用迁移。
4. v0.2 第一个迁移创建本文件定义的表，不修改现有 `daily_metrics`。
5. 测试对临时数据库执行从零迁移和重复启动，验证幂等性。
6. 回滚通过发布前数据库备份和前向修复迁移完成，不使用破坏性自动降级。

## 7. 保留与清理

- 会话与运行默认持久保留，用户可显式归档或删除。
- 原始上传文件保留策略由设置控制，默认保留到任务发布完成后 7 天。
- 事件和工具摘要随 Agent Run 保留。
- Wiki 版本记录长期保留；已发布 Markdown 通过 Git 提供额外版本历史。
