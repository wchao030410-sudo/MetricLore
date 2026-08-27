# MetricLore 升级路线图

## 1. 产品定位

MetricLore 是一个本地优先、证据驱动的数据知识与分析智能体。它把业务概念、指标口径、数据资产、血缘关系和分析方法组织为可治理知识，再通过可解释的 Agent 工具循环完成知识问答、语义发现、受控问数与分析。

项目的核心不在于复刻一个庞大的指标管理后台，而在于回答四个更难的问题：

1. Agent 如何判断用户需要知识、数据还是分析？
2. Agent 如何通过本体和 Wiki 理解指标、业务过程与数据资产之间的关系？
3. Agent 如何在受控工具边界内完成多步任务，并留下可检查的执行轨迹？
4. 如何用客观评测证明路由、检索、数值、引用和安全边界有效？

## 2. 当前状态与目标差距

| 维度 | 当前 v0.1 | 目标状态 |
|---|---|---|
| Agent | 关键词规则路由，一次执行 | LLM 工具循环、Skill 选择、状态与预算控制 |
| Skill | 能力固化在代码中 | 可发现、可组合、可测试的 Skill Package |
| Tool | 进程内函数 | 带 JSON Schema、权限、超时和审计的 Tool Registry |
| 本体 | 指标和维度 JSON | 实体类型、关系类型、约束和图谱遍历 |
| Wiki | 6 篇 Markdown、关键词检索 | 结构化页面、Frontmatter、来源、置信度、图谱和混合检索 |
| 摄入 | 手工编辑 Wiki | Raw → Extract → Validate → Review → Publish 流水线 |
| 问数 | 单表基础聚合 | 语义发现、消歧、期间对比、维度拆分和范围回显 |
| 分析 | 首末值变化描述 | 描述、诊断假设、证据边界、报告校验与风险披露 |
| 评测 | 6 个代码测试 | 路由、工具、检索、数值、引用、拒答和一致性评测 |
| 可解释性 | 最终答案和来源 | 公开执行轨迹、工具参数、证据账本和失败原因 |

## 3. 目标架构

```text
┌────────────────────────────────────────────────────────────┐
│ Web UI                                                     │
│ Chat · Wiki Explorer · Ontology Graph · Trace · Eval       │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│ Agent Runtime                                               │
│ Intent → Capability → Skill → Tool Loop → Validate → Answer │
│ budgets · timeouts · state · evidence ledger · trace        │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
┌──────────────▼─────────────┐   ┌─────────────▼──────────────┐
│ Skill Registry             │   │ Tool Registry              │
│ wiki-answer                │   │ wiki_search/entity/trace   │
│ semantic-discovery         │   │ ontology_neighbors         │
│ metric-query               │   │ semantic_catalog/query     │
│ comparative-analysis       │   │ compare/dimension_breakdown│
│ knowledge-ingest           │   │ evidence_submit            │
└──────────────┬─────────────┘   └─────────────┬──────────────┘
               │                               │
┌──────────────▼───────────────────────────────▼──────────────┐
│ Knowledge and Data Plane                                    │
│ Raw Sources → Ontology → Wiki Pages → Search Index → Graph   │
│ Semantic Model → Governed SQL → SQLite / optional connectors │
└─────────────────────────────────────────────────────────────┘
```

### 编排原则

- **LLM 负责理解与选择，确定性代码负责执行与约束。**
- **Skill 定义方法，Tool 提供能力。** Skill 不能绕过 Tool 直接访问数据库。
- **先消歧，再执行。** 指标或业务对象存在多个候选时，Agent 必须澄清或展示候选。
- **证据先于表达。** 最终声明必须绑定 Wiki 来源或数据查询结果。
- **公开轨迹不展示私有推理。** UI 展示 Skill、工具、参数、耗时、结果摘要和引用，不展示模型隐藏思维链。
- **失败可恢复。** 工具超时、知识不足、数据为空和模型失败均有明确状态与降级策略。

## 4. Skill Package 设计

每个 Skill 使用独立目录，包含机器可读配置和面向模型的方法说明：

```text
skills/wiki-answer/
├── skill.json
├── SKILL.md
├── references/
│   └── answer-contract.md
└── evals/
    └── cases.jsonl
```

`skill.json` 至少包含：

```json
{
  "name": "wiki-answer",
  "version": "0.1.0",
  "description": "回答指标口径、业务规则、表字段与血缘问题",
  "triggers": ["definition", "lineage", "business_rule"],
  "allowedTools": ["wiki_search", "wiki_entity", "wiki_trace"],
  "maxSteps": 5,
  "outputSchema": "schemas/wiki-answer.schema.json"
}
```

`SKILL.md` 统一包含：

1. 适用场景和禁止场景。
2. 输入前置条件与消歧规则。
3. 可调用工具及调用顺序建议。
4. 证据和引用要求。
5. 输出结构。
6. 失败、拒答和降级策略。
7. 典型正例、反例和边界例。

### 首批核心 Skill

| Skill | 主要职责 | 允许工具 | 关键边界 |
|---|---|---|---|
| `wiki-answer` | 口径、规则、字段、来源、血缘问答 | Wiki 与图谱工具 | 没有来源时不能补全事实 |
| `semantic-discovery` | 识别指标、维度、业务过程并消歧 | 目录、实体、邻居查询 | 相似指标不得自动混用 |
| `metric-query` | 单点值、趋势、期间对比、维度拆分 | 语义查询工具 | 不接收任意 SQL，不做原因归因 |
| `comparative-analysis` | 描述变化、定位贡献维度、形成待验证假设 | 对比、拆分、Wiki | 相关性不能写成确定因果 |
| `knowledge-ingest` | 把公开样例文档和 SQL 转为候选实体 | 解析、校验、冲突检测 | 未审查内容不能直接发布 |
| `answer-review` | 发布前检查数字、范围、引用和过度表述 | 证据账本、Schema 校验 | 不引入新数据或新结论 |

## 5. Tool Registry 设计

工具全部使用 JSON Schema 描述输入输出，并由宿主管理权限、超时、结果大小和审计。

### 知识工具

- `wiki_search(query, entityTypes, limit)`：混合检索候选页面。
- `wiki_entity(key)`：读取单个规范实体及来源。
- `wiki_trace(startKey, relationTypes, depth)`：查看血缘或业务关系路径。
- `ontology_neighbors(key, direction, relationTypes)`：查询图谱邻居。

### 数据工具

- `semantic_catalog(query)`：发现指标、维度与别名。
- `metric_query(metrics, dimensions, filters, range, grain)`：受控指标查询。
- `compare_periods(metric, currentRange, baselineRange, dimensions)`：确定性期间对比。
- `dimension_breakdown(metric, dimension, range, limit)`：维度贡献拆分。

### 治理工具

- `submit_evidence(claims, sources)`：建立声明与证据的映射。
- `validate_answer(answerPacket)`：检查数字、范围、引用和禁用表达。
- `knowledge_validate(entity)`：按本体约束校验候选知识。

工具返回统一信封：

```json
{
  "status": "ok",
  "data": {},
  "evidence": [],
  "warnings": [],
  "scope": {},
  "traceId": "..."
}
```

## 6. 本体设计

本体是 LLM Wiki 的结构基础，不应只是目录标签。首版建议控制在 9 类实体和 16 类关系，保证样例可理解、图谱可展示、评测可覆盖。

### 实体类型

| 实体 | 作用 | 示例 |
|---|---|---|
| `BusinessDomain` | 业务范围 | 电商经营 |
| `BusinessProcess` | 业务过程 | 访问、下单、支付 |
| `Metric` | 可计算业务度量 | 收入、客单价 |
| `Dimension` | 分析切片 | 地区、渠道 |
| `DataAsset` | 表或数据集 | `daily_metrics` |
| `DataField` | 字段及语义 | `revenue`、`orders` |
| `BusinessRule` | 口径、约束、枚举 | 有效订单规则 |
| `Dashboard` | 展示或消费入口 | 经营概览 |
| `Source` | 原始证据 | 文档、SQL、数据字典 |

### 关系类型

```text
BusinessProcess --occursIn--> BusinessDomain
Metric          --measures--> BusinessProcess
Metric          --slicedBy--> Dimension
Metric          --storedIn--> DataAsset
Metric          --derivedFrom--> Metric
Metric          --governedBy--> BusinessRule
DataAsset       --contains--> DataField
DataAsset       --readsFrom--> DataAsset
Dashboard       --displays--> Metric
WikiEntity      --sourcedFrom--> Source
```

每种关系定义：允许的起点、终点、是否必须有反向关系、是否允许多值以及证据要求。`ontology/schema.json` 是校验器的唯一事实源，脚本不硬编码实体和关系列表。

## 7. LLM Wiki 设计

### 分层

```text
knowledge/
├── raw/           # 只读公开样例：文档、SQL、数据字典
├── candidates/    # 自动抽取但未发布的实体
├── wiki/          # 已校验的规范页面
├── ontology/      # 实体、关系和约束
├── indexes/       # FTS、图谱和可选向量索引
└── outputs/       # 健康检查、冲突和摄入报告
```

### Wiki 页面契约

```yaml
---
key: metric-aov
type: Metric
title: 客单价
aliases: [平均订单金额]
status: verified
valid_from: 2026-01-01
relations:
  derivedFrom: [metric-revenue, metric-orders]
  slicedBy: [dimension-region, dimension-channel]
sources:
  - source: sources/metric-dictionary.md
    locator: section:aov
confidence: high
---
```

正文采用稳定章节：定义、计算、适用范围、维度、时间口径、数据来源、限制、示例查询、变更记录。

### 检索

首版使用无需外部服务的混合检索：

1. SQLite FTS5/BM25 召回正文。
2. 别名和实体 Key 精确匹配。
3. 本体关系扩展一跳候选。
4. 类型、有效期和来源可信度重排。
5. 可选 Embedding 作为增强，不作为唯一检索路径。

检索结果返回页面、命中章节、实体类型、关系、来源、有效期和置信度，而不是只返回文本片段。

### 摄入流水线

```text
Raw source
  → parse
  → entity extraction
  → normalize aliases and keys
  → validate ontology
  → detect duplicates/conflicts
  → human review queue
  → publish Wiki
  → rebuild FTS and graph
  → health check
```

自动抽取不能直接覆盖已验证页面。冲突必须进入 Review Queue，并保留来源差异。

## 8. Agent 工具循环

一次请求的公开状态机：

```text
RECEIVED
  → RESOLVING_CAPABILITY
  → SELECTING_SKILL
  → RUNNING_TOOL
  → COLLECTING_EVIDENCE
  → VALIDATING
  → COMPLETED | NEEDS_CLARIFICATION | NOT_ANSWERABLE | FAILED
```

运行时保留以下约束：

- 每轮最多 6 次工具调用。
- 单工具默认超时 10 秒，模型轮次默认超时 30 秒。
- 同一工具和相同参数不得重复调用。
- 数据查询每次重新校验指标、维度、日期和权限。
- 没有 `submit_evidence` 或引用校验失败时，答案不得标为 `verified`。
- 模型不可用时，Wiki 精确查询和结构化指标查询仍可降级运行。

最终返回 `answer packet`：

```json
{
  "answer": "...",
  "status": "verified",
  "skill": "metric-query",
  "sources": [],
  "data": {},
  "assumptions": [],
  "warnings": [],
  "publicTrace": []
}
```

## 9. 评测集设计

评测采用“确定性指标优先，模型裁判补充”的原则。首版目标为 120 条公开、合成、可复现问题。

### 数据集分层

| 子集 | 数量 | 评测内容 |
|---|---:|---|
| 路由与 Skill | 20 | 应选择的 Skill、是否澄清 |
| Wiki 检索 | 20 | 必须命中的实体、来源和关系 |
| 指标问数 | 25 | 指标、维度、日期、过滤和数值 |
| 对比与分析 | 20 | 基线范围、变化方向、假设边界 |
| 多轮对话 | 10 | 上下文继承和范围变更 |
| 拒答与安全 | 15 | 任意 SQL、未知口径、提示注入、越权 |
| 一致性 | 10 | 重复运行后的关键声明稳定性 |

### 单条评测格式

```json
{
  "id": "metric-query-001",
  "question": "近 7 天按地区看收入",
  "expected": {
    "skill": "metric-query",
    "tools": ["semantic_catalog", "metric_query"],
    "metric": "revenue",
    "dimensions": ["region"],
    "sourceKeys": ["metric-revenue"],
    "status": "verified"
  },
  "assertions": {
    "numericTolerance": 0.000001,
    "forbiddenClaims": ["地区导致收入变化"],
    "mustEchoScope": true
  }
}
```

### 核心指标

- Skill 路由准确率。
- Tool 选择准确率与不必要调用率。
- 实体 Recall@5、来源 Recall@5。
- 数值 Exact Match / 容差内准确率。
- 日期、维度、过滤范围一致率。
- 引用支持率：公开声明是否能映射到证据。
- 不支持声明率与因果越界率。
- 正确拒答率和错误拒答率。
- P50/P95 延迟、平均工具调用数和单请求成本。
- 重复 3 次运行的关键声明一致率。

### 初始发布门槛

以下是目标门槛，不代表当前已经达到：

- 数值查询准确率：100%。
- 未注册指标和任意 SQL 拒绝率：100%。
- Skill 路由准确率：≥ 90%。
- Wiki 实体 Recall@5：≥ 90%。
- 关键声明引用支持率：≥ 95%。
- 因果越界率：0%。
- P95 工具循环次数：≤ 5。

评测报告同时输出机器可读 JSON 和静态 HTML，展示版本、模型、数据快照、失败标签和回归差异。

## 10. 实施阶段

### Phase 1：Agent Runtime 与 Skill Registry（P0）

交付：

- `skills/` 契约、加载器和能力索引。
- Schema 化 Tool Registry。
- OpenAI-compatible Tool Calling 循环。
- 步数、超时、重复调用、错误和降级控制。
- 公共 Trace API 和基础 Trace UI。

验收：模型能在 Wiki 问答、指标问数和分析之间动态选择 Skill 与 Tool；断开模型后结构化查询仍能降级运行。

### Phase 2：Ontology 与结构化 Wiki（P0）

交付：

- `ontology/schema.json`。
- 9 类实体、核心关系和校验器。
- 20–30 个完全合成的 Wiki 实体页面。
- FTS5 + 别名 + 图谱扩展检索。
- Wiki Explorer 与 Ontology Graph 页面。

验收：可从“客单价”追踪到分子、分母、维度、数据表、字段、业务过程和来源。

### Phase 3：知识摄入与治理（P1）

交付：

- 文档、SQL、数据字典解析器。
- 候选实体生成、规范化、去重、冲突检测。
- Review Queue 和发布命令。
- Wiki 健康检查与索引重建。

验收：导入新的公开样例数据字典后，可生成候选实体，未经确认不能进入 verified Wiki。

### Phase 4：问数与分析 Skill（P0）

交付：

- 语义目录发现与相似指标消歧。
- 单点、趋势、期间对比、维度拆分工具。
- 分析假设和因果语言约束。
- Answer Review 与证据账本。

验收：同一个对话中可以先查口径，再问数据，再按维度分析；所有数字回显实际范围并绑定查询结果。

### Phase 5：评测与回归平台（P0）

交付：

- 120 条版本化评测集。
- 确定性评分器、重复一致性测试和补充模型裁判。
- 静态 HTML 报告、失败标签和版本对比。
- CI 回归门禁。

验收：任何 Skill、Ontology、Prompt 或 Tool 变更都能生成可比较结果；核心安全和数值门禁失败时 CI 阻断。

### Phase 6：开源体验与示例（P1）

交付：

- 一条命令启动、Docker、环境诊断。
- 架构图、演示脚本、公开 Trace 示例和评测结果。
- 示例数据生成器和数据源扩展接口。
- Security、Contributing、Roadmap 和版本发布说明。

验收：新用户只使用公开仓库和文档即可复现 Wiki 问答、问数、分析和评测报告。

## 11. 优先级建议

第一轮开发应只做 P0 闭环：

1. Skill Registry 和真实 Tool Calling。
2. Ontology Schema 和结构化 Wiki。
3. Wiki、Ontology、Semantic 三类工具。
4. 60 条最小评测集，随后扩展到 120 条。
5. Trace 页面和评测报告。

指标后台的编辑、审批、组织权限和复杂看板暂不扩展。指标平台只保留语义模型、指标目录、受控查询和口径映射，确保它服务于 Agent 演示，而不成为项目主体。

## 12. 内容与合规原则

- 仓库只保留通用产品叙事，不写个人用途。
- 使用完全合成的数据、文档、实体、评测问题和结果。
- 不复制原工程的企业名称、内部 Skill 文案、内部评测集、接口、域名和部署说明。
- 每项能力只在实现并通过测试后写入 README 的“已支持”部分；未完成内容进入 Roadmap。
- 发布结果区分“当前结果”和“目标门槛”，避免把规划指标写成已验证效果。
