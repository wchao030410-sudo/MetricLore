# Data Agent

一个可独立本地部署、证据驱动的数据知识与分析 Agent。它统一提供：

- **指标平台**：指标目录、口径、原子指标与复合指标。
- **数据语义层**：受治理的指标、维度、时间粒度和筛选条件。
- **LLM Wiki 与本体**：结构化实体、来源、关系、血缘追踪和关键词/别名检索。
- **Skill 编排**：声明式 Skill Package、Tool Registry、步数预算、公开执行轨迹和证据账本。
- **问数与分析**：自然语言识别指标，执行受控查询，并限制无证据归因。
- **公开评测**：120 条合成回归用例，覆盖路由、工具、知识、问数、分析和安全拒答。

项目默认使用合成的电商示例数据，不包含企业内部数据、域名、账号、接口或中间件依赖。没有模型密钥也能演示完整的确定性 Skill 工作流；配置 OpenAI 兼容模型后，运行时会让模型在当前 Skill 允许的工具内执行函数调用循环。

## 5 分钟启动

要求 Node.js 22.5 或更高版本，无需安装第三方 npm 包。

```bash
cp .env.example .env
npm start
```

浏览器打开 <http://127.0.0.1:3000>。首次启动会自动创建 `data/data_agent.db` 并写入合成数据。

也可以使用 Docker：

```bash
docker compose up --build
```

## 示例问题

- “近 14 天收入趋势怎么样？”
- “按地区看订单量，并分析变化”
- “客单价的口径是什么？”
- “语义层为什么禁止模型直接拼 SQL？”
- “客单价可以追溯到哪些指标、规则和数据资产？”
- “执行 SQL: SELECT * FROM daily_metrics”

## API

### 查询指标

```bash
curl -X POST http://127.0.0.1:3000/api/query \
  -H 'Content-Type: application/json' \
  -d '{"metrics":["revenue","aov"],"dimensions":["region"],"startDate":"2026-07-01","endDate":"2026-08-26"}'
```

### Agent 问答

```bash
curl -X POST http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"近14天收入趋势怎么样？"}'
```

其他接口：

- `GET /api/health`
- `GET /api/catalog`
- `GET /api/skills`
- `GET /api/ontology`
- `GET /api/wiki/entity/:key`
- `GET /api/wiki/trace/:key`
- `GET /api/wiki/search?q=客单价`
- `POST /api/query`
- `POST /api/chat`

## 目录

```text
config/semantic-model.json   指标与维度的语义定义
data/seed.sql                合成演示数据
lib/                         语义查询、Wiki 检索、Agent 与模型适配器
skills/                      可发现、可约束、可测试的 Skill Package
ontology/                    实体、关系和校验 Schema
raw/                         公开合成的摄入样例
evals/                       120 条公开合成回归用例
public/                      无构建步骤的 Web 界面
wiki/                        可直接编辑的 Markdown 知识库
docs/                        架构、来源审阅与本地化说明
test/                        核心测试
```

架构与演进说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`docs/AGENT_EVOLUTION_ROADMAP.md`](docs/AGENT_EVOLUTION_ROADMAP.md)。路线图中标为后续的能力与门槛不代表当前版本已经实现。

## 验证与评测

```bash
npm test       # 单元与集成测试
npm run health # Wiki 本体、关系与来源校验
npm run ingest # 从公开样例生成候选实体
npm run review # 生成候选知识 Review Queue
npm run eval   # 运行 120 条 Agent 回归用例
npm run audit  # 内部标识与密钥模式扫描
```

每次 Agent 回答都会返回 Skill、工具调用、来源和不含私有推理的 `publicTrace`。Web 界面的“Agent Trace”和“知识本体”页面可直接查看这些结构。

## 安全边界

- SQL 只由服务端语义层生成；前端和 LLM 不能提交任意 SQL。
- 指标、维度和排序字段必须来自语义模型白名单。
- 查询使用参数绑定，数据库连接只执行读取语句。
- 模型密钥只在服务端读取，不会传到浏览器。
- Wiki 回答附带本地来源路径；找不到证据时会明确说明。
- Agent 每个 Skill 都有工具白名单、最大调用步数和重复调用拦截。
- 任意 SQL、数据修改、提示词与密钥请求会进入安全拒答，不会触发数据工具。

## 替换成自己的数据

1. 将事实表导入 SQLite，或实现 `lib/database.mjs` 中相同的查询接口。
2. 在 `config/semantic-model.json` 注册物理表、指标表达式、维度和别名。
3. 用企业已授权公开的内容替换 `wiki/` 示例页面。
4. 运行 `npm test` 和 `npm run audit`。

当前版只支持单事实表、SQLite 方言和基础时间粒度，适合开源演示与二次开发。生产使用前需补充身份认证、行列权限、查询配额、审计存储和数据源连接器。

## 发布前提醒

本目录的实现与演示数据已做独立化处理，但公开到 GitHub 前，仍应由代码与数据权利人确认发布授权。详见 [`docs/OPEN_SOURCE_AUDIT.md`](docs/OPEN_SOURCE_AUDIT.md)。
