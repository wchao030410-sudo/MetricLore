# Contributing

欢迎提交新的公开样例、实体页面、Skill、工具和评测用例。

提交前请运行：

```bash
npm test
npm run health
npm run eval
npm run audit
```

新增 Wiki 实体必须符合 `ontology/schema.json`，包含来源，并使用 `candidate` 或 `verified` 状态。新增 Skill 必须包含 `skill.json`、`SKILL.md` 和相应评测用例。禁止提交真实业务数据、凭证、内部链接或未获授权材料。
