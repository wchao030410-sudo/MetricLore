---
key: metric-orders
type: Metric
title: 订单量
status: verified
aliases: [订单, 单量]
sources: [config/semantic-model.json, data/seed.sql]
relations: [measures:process-ordering, slicedBy:dimension-region, slicedBy:dimension-channel, storedIn:asset-daily-metrics, governedBy:rule-paid-order, sourcedFrom:source-semantic-model]
---

支付成功且未取消的订单数。演示计算为 `SUM(orders)`。
