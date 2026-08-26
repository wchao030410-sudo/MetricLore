---
key: metric-visitors
type: Metric
title: 访客数
status: verified
aliases: [UV, 用户数, 访问人数]
sources: [config/semantic-model.json, data/seed.sql]
relations: [measures:process-ordering, slicedBy:dimension-region, slicedBy:dimension-channel, storedIn:asset-daily-metrics, governedBy:rule-daily-grain, sourcedFrom:source-semantic-model]
---

按日去重的访问用户数。演示计算为 `SUM(visitors)`。
