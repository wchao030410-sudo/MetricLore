import { generateGroundedAnswer, llmEnabled } from "./llm.mjs";

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function dateRange(text, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const number = Number(text.match(/近\s*(\d+)\s*天/)?.[1] || text.match(/last\s+(\d+)\s+days/i)?.[1] || 30);
  const days = Math.max(1, Math.min(number, 366));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: iso(start), endDate: iso(end) };
}

function display(value, format) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (format === "currency") return `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
  if (format === "percent") return `${n.toFixed(2)}%`;
  if (format === "integer") return Math.round(n).toLocaleString("zh-CN");
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function summarizeRows(result, model) {
  if (!result.rows.length) return "所选范围内没有数据。";
  const lines = [];
  for (const metricKey of result.metrics) {
    const metric = model.metrics[metricKey];
    const values = result.rows.map((row) => Number(row[metricKey])).filter(Number.isFinite);
    if (!values.length) continue;
    if (result.timeGrain && values.length > 1) {
      const first = values[0];
      const last = values.at(-1);
      const change = first === 0 ? null : ((last - first) / Math.abs(first)) * 100;
      lines.push(`${metric.label}从 ${display(first, metric.format)} 变为 ${display(last, metric.format)}${change === null ? "" : `，变化 ${change.toFixed(1)}%`}`);
    } else {
      lines.push(`${metric.label}：${display(values[0], metric.format)}`);
    }
  }
  return lines.length ? `${lines.join("；")}。` : `返回 ${result.rows.length} 行结果。`;
}

function metricDefinitionAnswer(metricKey, model) {
  const metric = model.metrics[metricKey];
  if (!metric) return null;
  if (metric.type === "atomic") {
    return `**${metric.label}**：${metric.description}。聚合方式为 ${metric.aggregation}，物理字段为 \`${metric.column}\`。`;
  }
  const numerator = model.metrics[metric.numerator]?.label || metric.numerator;
  const denominator = model.metrics[metric.denominator]?.label || metric.denominator;
  return `**${metric.label}**：${metric.description}。计算方式为 ${numerator} ÷ ${denominator}${metric.scale ? ` × ${metric.scale}` : ""}。`;
}

export class DataAgent {
  constructor({ semantic, wiki, db }) {
    this.semantic = semantic;
    this.wiki = wiki;
    this.db = db;
  }

  async answer(message) {
    if (typeof message !== "string" || !message.trim()) throw new Error("message 不能为空");
    if (message.length > 4000) throw new Error("message 不能超过 4000 字符");
    const metricKeys = this.semantic.findMetrics(message);
    const dimensionKeys = this.semantic.findDimensions(message);
    const evidence = this.wiki.search(message, 4);
    const asksDefinition = /口径|定义|怎么算|计算方式|是什么/.test(message);
    let result = null;
    let answer;
    let mode = "wiki";

    if (metricKeys.length && asksDefinition) {
      answer = metricKeys.map((key) => metricDefinitionAnswer(key, this.semantic.model)).join("\n\n");
    } else if (metricKeys.length) {
      mode = /分析|趋势|变化|波动|增长|下降|对比|为什么/.test(message) ? "analysis" : "data";
      const range = dateRange(message);
      result = this.semantic.execute(this.db, {
        metrics: metricKeys,
        dimensions: dimensionKeys,
        timeGrain: mode === "analysis" || /每天|每日|趋势/.test(message) ? "day" : null,
        ...range,
      });
      answer = `${summarizeRows(result, this.semantic.model)}\n\n查询范围：${range.startDate} 至 ${range.endDate}；返回 ${result.rows.length} 行。`;
      if (/为什么|原因|归因/.test(message)) answer += "\n\n当前数据只能描述变化，不能单凭相关性判断原因；需要活动、价格、供给等额外证据后才能归因。";
    } else if (evidence.length) {
      answer = `我找到以下相关知识：\n\n${evidence.map((item) => `- **${item.title}**：${item.snippet}`).join("\n")}`;
    } else {
      answer = "知识库和指标目录中没有找到足够证据。请补充指标名称、时间范围或业务对象。";
    }

    let provider = "deterministic";
    if (llmEnabled()) {
      try {
        const generated = await generateGroundedAnswer({ question: message, evidence, data: result?.rows || [] });
        if (generated) {
          answer = generated;
          provider = "llm";
        }
      } catch (error) {
        answer += `\n\n> 模型不可用，已返回本地规则结果：${error.message}`;
      }
    }
    return {
      mode,
      answer,
      sources: evidence.map(({ title, path, score }) => ({ title, path, score })),
      data: result ? { rows: result.rows, metrics: result.metrics, dimensions: result.dimensions, timeGrain: result.timeGrain } : null,
      provider,
    };
  }
}
