# v0.2 API 与事件契约

## 1. 通用协议

- Base path：`/api`
- JSON Content-Type：`application/json; charset=utf-8`
- SSE Content-Type：`text/event-stream; charset=utf-8`
- Schema version：`0.2`
- 时间：UTC ISO 8601
- 创建型请求支持 `Idempotency-Key` 请求头。
- 列表接口使用 `limit` 和 `cursor`，默认 20，最大 100。
- 请求体默认上限 1 MB；文件上传使用独立限制。

成功信封：

```json
{
  "schemaVersion": "0.2",
  "data": {},
  "meta": {"requestId": "req_<uuid>"}
}
```

错误信封：

```json
{
  "schemaVersion": "0.2",
  "error": {
    "code": "CANDIDATE_REVISION_CONFLICT",
    "message": "候选内容已被更新，请刷新后重试。",
    "retryable": true,
    "userAction": "refresh",
    "details": {},
    "requestId": "req_<uuid>"
  }
}
```

错误响应不包含服务器路径、SQL、密钥、私有提示词和模型原始推理。

## 2. Conversation API

### POST /api/conversations

Request：

```json
{"title":"收入分析"}
```

Response `201`：

```json
{
  "schemaVersion":"0.2",
  "data":{"conversation":{"id":"conv_<uuid>","title":"收入分析","status":"active"}},
  "meta":{"requestId":"req_<uuid>"}
}
```

### GET /api/conversations

Query：`status`、`limit`、`cursor`。按 `lastMessageAt DESC` 排序。

### GET /api/conversations/:id

返回会话、消息摘要、结构化上下文和最近运行；消息支持游标分页。

### PATCH /api/conversations/:id

允许更新 `title` 和 `status`。Body 至少包含一个字段。

### DELETE /api/conversations/:id

删除会话、消息、运行和关联事件。UI 必须即时确认，成功返回 `204`。

### POST /api/conversations/:id/messages

Request：

```json
{
  "content":"那按地区拆一下",
  "contextPatch":{},
  "clientMessageId":"client_<uuid>"
}
```

Response `202`：

```json
{
  "schemaVersion":"0.2",
  "data":{
    "userMessage":{"id":"msg_<uuid>","status":"completed"},
    "assistantMessage":{"id":"msg_<uuid>","status":"pending"},
    "run":{
      "id":"run_<uuid>",
      "status":"queued",
      "eventsUrl":"/api/conversations/conv_<uuid>/runs/run_<uuid>/events"
    }
  },
  "meta":{"requestId":"req_<uuid>"}
}
```

同一个 `Idempotency-Key` 返回同一组消息和 Run。

### POST /api/runs/:runId/cancel

将可取消的 Run 标记为 `cancelled`，工具通过 AbortSignal 接收取消。已提交的数据查询结果保持只读证据记录。

### POST /api/messages/:messageId/retry

以原用户消息和当时上下文创建新 Run，旧 Run 保留。

### POST /api/runs/:runId/clarifications

Request：

```json
{"optionId":"metric-revenue"}
```

校验 `pending_clarification` 后恢复原计划。该请求沿用原 Run 和原事件订阅 URL，返回 `202`；后续事件 sequence 接续递增。等待选择期间 SSE 可保持连接，连接断开后客户端使用 `Last-Event-ID` 重连。

## 3. Agent SSE

### GET /api/conversations/:conversationId/runs/:runId/events

请求可包含 `Last-Event-ID`。服务端按 sequence 发送缺失事件，然后订阅新事件。连接每 15 秒发送注释心跳。

事件格式：

```text
id: evt_<uuid>
event: tool.started
data: {"schemaVersion":"0.2","runId":"run_<uuid>","sequence":4,"at":"2026-08-27T00:00:00.000Z","payload":{}}
```

### 事件顺序

| Event | Payload | 是否持久化 |
| --- | --- | --- |
| `run.started` | conversationId、messageId、provider | 是 |
| `plan.created` | goal、contextUsed、steps、budget | 是 |
| `skill.started` | stepId、skill、maxSteps | 是 |
| `skill.completed` | stepId、skill、status、outputSummary | 是 |
| `tool.started` | stepId、callId、tool、publicArgs | 是 |
| `tool.completed` | callId、status、elapsedMs、resultSummary、scope | 是 |
| `evidence.added` | evidenceId、sourceType、sourceKey、locator | 是 |
| `answer.delta` | delta、offset | 是 |
| `validation.completed` | valid、findings、evidenceCount | 是 |
| `clarification.required` | prompt、options、context | 是 |
| `run.completed` | assistantMessageId、status、contextAfter | 是 |
| `run.failed` | error envelope | 是 |
| `run.cancelled` | completedStepCount | 是 |

`plan.created` 和工具事件只包含可公开、可验证的信息。`publicArgs` 过滤密钥、原始文件全文、SQL 和私有提示词。

Terminal event：`run.completed`、`run.failed`、`run.cancelled`。发送 Terminal event 后关闭 SSE。

## 4. Ingestion API

### POST /api/knowledge/jobs

Content-Type：`multipart/form-data`。

Fields：

- `files[]`：多个文件、ZIP 或浏览器目录文件。
- `name`：任务名称。
- `extractionMode`：`rules` 或 `llm_assisted`。
- `options`：JSON，包含语言、允许实体类型和保留策略。

默认限制：

- 每任务 50 个文件。
- 上传总量 100 MB。
- 单文件 25 MB。
- ZIP 解压后 250 MB。
- ZIP 压缩比不超过 100:1。
- 相对路径深度不超过 20。

Response `202` 返回 `job` 和 `eventsUrl`。

### GET /api/knowledge/jobs

按创建时间倒序返回任务，支持 `status`、`limit`、`cursor`。

### GET /api/knowledge/jobs/:id

返回总体状态、文件摘要、阶段进度、候选和错误计数。

### GET /api/knowledge/jobs/:id/events

SSE 事件：

```text
job.started
file.accepted
file.parsing
file.parsed
file.failed
extraction.started
candidate.extracted
validation.completed
job.awaiting_review
publish.started
index.refreshed
job.completed
job.failed
job.cancelled
```

遵循与 Agent SSE 相同的 ID、sequence、持久化和重连规则。

### POST /api/knowledge/jobs/:id/retry

Request 可指定 `fileIds`。只重试失败文件和其下游候选。

### POST /api/knowledge/jobs/:id/cancel

取消上传后的解析/抽取任务。已产生候选保留并标记来源任务已取消。

## 5. Candidate and Review API

### GET /api/knowledge/jobs/:id/candidates

Filters：`status`、`type`、`sourceFileId`、`hasConflict`、`hasValidationErrors`、`limit`、`cursor`。

### GET /api/knowledge/candidates/:id

返回候选、来源预览、校验、冲突、可选关系目标和 revision。

### PATCH /api/knowledge/candidates/:id

Request：

```json
{
  "revision":3,
  "patch":{
    "title":"客单价",
    "aliases":["平均订单金额"],
    "relations":{"derivedFrom":["metric-revenue","metric-orders"]}
  }
}
```

revision 不匹配返回 `409 CANDIDATE_REVISION_CONFLICT`。

### POST /api/knowledge/candidates/:id/review

Request：

```json
{"revision":4,"decision":"approve","note":"来源和关系已核对"}
```

### POST /api/knowledge/candidates/batch-review

Request：

```json
{"items":[{"id":"cand_<uuid>","revision":2}],"decision":"approve"}
```

逐项返回成功或冲突，不因单条失败回滚其他决定。

### POST /api/knowledge/jobs/:id/publish

发布该任务所有 approved 候选。Response `202`，进度通过 Job SSE 发送。

发布完成返回：created、updated、merged、skipped、failed、publicationId、wikiVersion、health、indexRefreshedAt。`wikiVersion` 是工作区级递增发布版本，同一次发布产生的页面版本共享 `publicationId`。

## 6. Wiki API

### GET /api/wiki/pages

支持 `q`、`type`、`status`、`source`、`limit`、`cursor`。

### GET /api/wiki/pages/:key

返回正文、来源、版本、出边、入边和相关问题建议。

### GET /api/wiki/pages/:key/source

Query 使用 `sourceKey` 和 locator，返回允许展示的原文片段与定位信息。

### GET /api/wiki/graph

Query：`startKey`、`depth`、`entityTypes`、`relationTypes`、`status`。默认深度 1，最大 3，最大节点 200。

现有 `/api/wiki/search`、`/api/wiki/entity/:key` 和 `/api/wiki/trace/:key` 在 v0.2 保留。

## 7. 安全与隐私

- 上传文件先做扩展名、MIME、大小、路径和压缩包检查。
- 原始文件名保存为相对路径，服务器生成实际存储名。
- HTML 解析移除脚本、样式、外链资源和事件属性。
- PDF/DOCX 解析在进程隔离或有超时的任务执行器中运行。
- `llm_assisted` 请求创建前返回传输说明；UI 获取明确选择后开始抽取。
- API 响应和 SSE 只返回来源片段，不返回整份私有文件。
- 模型密钥保留在服务端环境变量。

## 8. 兼容与测试

- 现有 `/api/chat` 在 M3 前保持运行；M3 完成后内部适配到临时会话，不承担多轮持久化。
- 现有 `/api/query` 保持语义查询契约。
- 契约测试覆盖状态码、信封、ID 前缀、时间、分页、幂等、revision 冲突和 SSE 重连。
- 前端只依赖本文件声明的公开字段，不读取数据库内部列。
