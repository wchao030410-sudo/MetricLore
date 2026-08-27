# 从 v0.1 升级到 v0.2

v0.2 增加 Wiki Builder、多轮会话、实时运行事件和 Agent Workbench。现有语义模型、Wiki Markdown 与 `/api/chat`、`/api/query` 接口可以继续使用。

## 1. 备份本地内容

升级前保存数据库、Wiki 和环境变量：

```bash
cp data/metriclore.db data/metriclore.v0.1.backup.db
cp -R wiki wiki.v0.1.backup
cp .env .env.v0.1.backup
```

数据库与备份文件保持在本地，不需要提交到 Git。

## 2. 更新代码和依赖

```bash
git pull --ff-only
npm ci
```

v0.2 需要 Node.js 22.13 或更高版本。

## 3. 启动并执行迁移

```bash
npm start
```

服务启动时按顺序执行 `data/migrations/001` 至 `005`。迁移增加摄入、审核发布、会话、运行事件和结果快照表，不会修改 `daily_metrics` 事实数据或覆盖现有 Wiki 页面。每个迁移带 checksum，相同版本只执行一次。

## 4. 验证升级

```bash
npm run verify
```

然后在浏览器检查三条链路：

1. 在「智能问答」连续发送“近 14 天收入怎么样？”和“那按地区拆一下”。
2. 在「Wiki 构建」导入 `examples/wiki-builder/ecommerce-growth`，审核并发布候选。
3. 在「Wiki 浏览」打开新页面，检查来源和本体关系。

## 5. 模型配置

确定性模式无需模型密钥。需要 LLM 工具调用或辅助知识抽取时，在 `.env` 中配置：

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your_api_key
LLM_MODEL=gpt-4.1-mini
```

`llm_assisted` 会把待抽取文本发送到所配置的模型端点；规则抽取保留在本地。

## 回滚

停止服务后，用升级前的数据库和 Wiki 备份恢复：

```bash
cp data/metriclore.v0.1.backup.db data/metriclore.db
rm -rf wiki
cp -R wiki.v0.1.backup wiki
```

切回 v0.1 代码后再启动服务。v0.2 新表不会被 v0.1 使用，恢复备份可以保持运行状态一致。

