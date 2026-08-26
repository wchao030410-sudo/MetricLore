# Evaluation Suite

`cases.mjs` 公开生成 120 条完全合成的回归用例，覆盖指标定义、问数、分析、知识问答和安全拒答。评分器检查 Skill 路由、必要工具、状态、禁用表述和执行轨迹，并对每条用例重复运行三次，比较公开结果一致性；数值测试由语义层集成测试保证精确性。

运行：

```bash
npm run eval
```

报告写入 `outputs/evals/latest.json`，该目录不进入 Git 历史。
