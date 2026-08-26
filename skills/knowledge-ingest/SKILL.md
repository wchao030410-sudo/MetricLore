# Knowledge Ingest

## 适用场景

处理公开文档、SQL 样例或数据字典，生成候选 Wiki 实体。当前本地 CLI 支持从带有 `Metric:`、`Dimension:`、`BusinessProcess:` 或 `BusinessRule:` 标题的 Markdown 提取候选。

## 流程

`raw source → candidate JSON → ontology validation → review queue → explicit publish → health check`

候选内容默认状态为 `candidate`。只有显式执行带 `--approve` 的发布命令才能写入 Wiki，且禁止覆盖已存在页面。

## 输出契约

候选必须保留原始来源、类型、Key、标题和校验错误。校验失败或来源缺失时进入拒绝队列，不能发布为 `verified`。
