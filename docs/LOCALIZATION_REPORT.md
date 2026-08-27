# 本地化报告

## 可运行能力

- 本地 SQLite 自动初始化与合成数据。
- 五个示例指标：收入、订单量、访客数、客单价、转化率。
- 地区、渠道和日期维度，日/周/月粒度。
- 参数化查询 API、Wiki 搜索 API 和统一 Agent API。
- 无模型离线回答，以及可选的 OpenAI 兼容模型表达。
- 指标目录、语义模型、Wiki 搜索和问答 Web 页面。
- 核心测试和内部标识扫描。

## 从企业实现到开源实现的替换

| 企业实现 | 本地实现 |
|---|---|
| 内部 Java 多模块和中间件 | Node 服务（核心标准库 + 少量开源文档解析依赖） |
| Doris/Hive/内部数据访问层 | SQLite |
| 内部指标与 Wiki MCP | 进程内 SemanticLayer / WikiIndex |
| 内部 SSO 与权限接口 | 本地单用户演示 |
| 私有 React 组件库 | 原生 HTML/CSS/JavaScript |
| 企业知识和业务元数据 | 六篇通用示例 Wiki 页面 |
| 内部模型网关 | 可配置 OpenAI-compatible endpoint |

## 后续适合公开演进的方向

- 增加 PostgreSQL、DuckDB 和 ClickHouse 连接器。
- 把语义模型扩展为多事实表、Join、累计去重和同比/环比。
- 增加 Wiki 摄入 CLI、向量检索与知识健康检查。
- 增加 OAuth、租户隔离、行列权限、查询预算和审计日志。
- 增加图表生成、可下载分析报告和可解释的查询计划。
