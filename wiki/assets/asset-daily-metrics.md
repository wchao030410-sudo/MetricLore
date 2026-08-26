---
key: asset-daily-metrics
type: DataAsset
title: 日经营事实表
status: verified
sources: [data/seed.sql]
relations: [contains:field-date, contains:field-region, contains:field-channel, contains:field-revenue, contains:field-orders, contains:field-visitors, governedBy:rule-daily-grain, sourcedFrom:source-synthetic-dataset]
---

`daily_metrics` 是按日期、地区和渠道汇总的演示事实表。所有数值均为合成数据。
