---
key: metric-revenue
type: Metric
title: 收入
status: verified
aliases: [销售额, 营收, GMV]
sources: [config/semantic-model.json, data/seed.sql]
relations: [measures:process-ordering, slicedBy:dimension-region, slicedBy:dimension-channel, storedIn:asset-daily-metrics, governedBy:rule-daily-grain, sourcedFrom:source-semantic-model]
---

支付成功订单产生的含税收入。演示计算为 `SUM(revenue)`。
