---
key: dimension-date
type: Dimension
title: 日期
status: verified
aliases: [时间, 天]
sources: [config/semantic-model.json]
relations: [storedIn:asset-daily-metrics, sourcedFrom:source-semantic-model]
---

日、周、月时间粒度的基础维度。当前项目仅支持受治理的日、周、月分桶。
