# Data Agent

一个可独立本地部署的数据智能助手示例，统一提供：

- **指标平台**：指标目录、口径、原子指标与复合指标。
- **数据语义层**：受治理的指标、维度、时间粒度和筛选条件。
- **LLM Wiki**：Markdown 知识库、检索、来源引用和口径说明。
- **Wiki Agent 问答**：先检索知识，再回答业务与口径问题。
- **问数与分析**：自然语言识别指标，执行只读查询并生成趋势解读。

项目默认使用合成的电商示例数据，不包含企业内部数据、域名、账号、接口或中间件依赖。没有模型密钥也能完整演示指标查询、Wiki 检索和规则分析；配置 OpenAI 兼容模型后，可由模型润色有证据的回答。

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
- `GET /api/wiki/search?q=客单价`
- `POST /api/query`
- `POST /api/chat`

## 目录

```text
config/semantic-model.json   指标与维度的语义定义
data/seed.sql                合成演示数据
lib/                         语义查询、Wiki 检索、Agent 与模型适配器
public/                      无构建步骤的 Web 界面
wiki/                        可直接编辑的 Markdown 知识库
docs/                        架构、来源审阅与本地化说明
test/                        核心测试
```

## 安全边界

- SQL 只由服务端语义层生成；前端和 LLM 不能提交任意 SQL。
- 指标、维度和排序字段必须来自语义模型白名单。
- 查询使用参数绑定，数据库连接只执行读取语句。
- 模型密钥只在服务端读取，不会传到浏览器。
- Wiki 回答附带本地来源路径；找不到证据时会明确说明。

## 替换成自己的数据

1. 将事实表导入 SQLite，或实现 `lib/database.mjs` 中相同的查询接口。
2. 在 `config/semantic-model.json` 注册物理表、指标表达式、维度和别名。
3. 用企业已授权公开的内容替换 `wiki/` 示例页面。
4. 运行 `npm test` 和 `npm run audit`。

当前版只支持单事实表、SQLite 方言和基础时间粒度，适合开源演示与二次开发。生产使用前需补充身份认证、行列权限、查询配额、审计存储和数据源连接器。

## 发布前提醒

本目录的实现与演示数据已做独立化处理，但公开到 GitHub 前，仍应由代码与数据权利人确认发布授权。详见 [`docs/OPEN_SOURCE_AUDIT.md`](docs/OPEN_SOURCE_AUDIT.md)。
