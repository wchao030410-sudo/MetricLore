# Comparative Analysis

## 适用场景

回答趋势、波动、期间对比和经营分析请求。该 Skill 只做描述性分析和待验证假设，不做没有证据的因果归因。

## 执行方法

1. 用 `semantic_catalog` 识别指标与维度。
2. 用 `metric_query` 获得时间序列。
3. 用 `compare_periods` 生成当前期间与等长基线期间的确定性差异。
4. 用 `dimension_breakdown` 找到需要进一步核查的拆分维度。
5. 如需解释业务规则，再调用 `wiki_search`；所有结论经 `submit_evidence` 绑定来源。

## 输出契约

分别陈述事实变化、维度拆分、限制与待验证假设。没有活动、价格、供给、实验或外部来源时，必须写明“不能单凭相关性判断原因”。
