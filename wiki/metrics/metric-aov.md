---
key: metric-aov
type: Metric
title: 客单价
status: verified
aliases: [平均订单金额]
sources: [config/semantic-model.json, wiki/metrics/aov.md]
relations: [measures:process-ordering, derivedFrom:metric-revenue, derivedFrom:metric-orders, slicedBy:dimension-region, slicedBy:dimension-channel, governedBy:rule-daily-grain, sourcedFrom:source-semantic-model]
---

收入除以订单量。必须在相同筛选范围内先聚合分子和分母，再做除法。
