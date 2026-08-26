---
key: metric-conversion-rate
type: Metric
title: 下单转化率
status: verified
aliases: [转化率, CVR]
sources: [config/semantic-model.json, wiki/metrics/conversion-rate.md]
relations: [measures:process-ordering, derivedFrom:metric-orders, derivedFrom:metric-visitors, slicedBy:dimension-region, slicedBy:dimension-channel, governedBy:rule-daily-grain, sourcedFrom:source-semantic-model]
---

订单量除以访客数再乘以 100%。由于访客数按日去重，跨日结果应明确标注为演示口径。
