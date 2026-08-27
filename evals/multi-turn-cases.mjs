const metrics = [
  { key: "revenue", label: "收入" },
  { key: "orders", label: "订单量" },
  { key: "visitors", label: "访客数" },
  { key: "aov", label: "客单价" },
  { key: "conversion_rate", label: "转化率" },
];

const ranges = [7, 14, 21, 28, 35, 60];

export const multiTurnCases = metrics.flatMap((metric) => ranges.map((days) => ({
  id: `multi-${metric.key}-${days}d`,
  title: `${metric.label} ${days} 天连续分析`,
  turns: [
    {
      question: `近 ${days} 天${metric.label}怎么样？`,
      expected: {
        capability: "data",
        skill: "metric-query",
        tools: ["metric_query"],
        context: { metrics: [metric.key], dimensions: [], rangeDays: days, filters: {} },
      },
    },
    {
      question: "那按地区拆一下。",
      expected: {
        capability: "data",
        skill: "metric-query",
        tools: ["metric_query"],
        context: { metrics: [metric.key], dimensions: ["region"], rangeDays: days, filters: {} },
      },
    },
    {
      question: "华东为什么变化？",
      expected: {
        capability: "analysis",
        skill: "comparative-analysis",
        tools: ["metric_query", "compare_periods", "dimension_breakdown"],
        context: { metrics: [metric.key], dimensions: ["region"], rangeDays: days, filters: { region: ["华东"] } },
      },
    },
    {
      question: "这个指标口径是什么？",
      expected: {
        capability: "definition",
        skill: "wiki-answer",
        tools: ["wiki_entity", "wiki_trace"],
        context: { metrics: [metric.key], dimensions: ["region"], rangeDays: days, filters: { region: ["华东"] } },
      },
    },
  ],
})));

