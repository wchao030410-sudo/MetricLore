import { resolve } from "node:path";

import { ROOT, readJson } from "./config.mjs";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(value)) throw new Error(`非法字段标识: ${value}`);
  return `"${value}"`;
}

function metricExpression(metric, model) {
  if (metric.type === "atomic") {
    const aggregation = metric.aggregation?.toUpperCase();
    if (!new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]).has(aggregation)) {
      throw new Error(`不支持的聚合: ${aggregation}`);
    }
    return `${aggregation}(${quoteIdentifier(metric.column)})`;
  }
  if (metric.type === "derived") {
    const numerator = model.metrics[metric.numerator];
    const denominator = model.metrics[metric.denominator];
    if (!numerator || !denominator || numerator.type !== "atomic" || denominator.type !== "atomic") {
      throw new Error("复合指标只能引用已注册的原子指标");
    }
    const left = metricExpression(numerator, model);
    const right = metricExpression(denominator, model);
    return `(1.0 * ${left} / NULLIF(${right}, 0)) * ${Number(metric.scale || 1)}`;
  }
  throw new Error(`未知指标类型: ${metric.type}`);
}

function timeExpression(column, grain) {
  const q = quoteIdentifier(column);
  if (grain === "day") return q;
  if (grain === "week") return `date(${q}, '-' || ((strftime('%w', ${q}) + 6) % 7) || ' days')`;
  if (grain === "month") return `strftime('%Y-%m-01', ${q})`;
  throw new Error(`不支持的时间粒度: ${grain}`);
}

export class SemanticLayer {
  constructor(modelPath = resolve(ROOT, "config/semantic-model.json")) {
    this.model = readJson(modelPath);
    this.validate();
  }

  validate() {
    quoteIdentifier(this.model.table);
    quoteIdentifier(this.model.timeColumn);
    for (const [key, metric] of Object.entries(this.model.metrics)) {
      quoteIdentifier(key);
      metricExpression(metric, this.model);
    }
    for (const [key, dimension] of Object.entries(this.model.dimensions)) {
      quoteIdentifier(key);
      quoteIdentifier(dimension.column);
    }
  }

  catalog() {
    return this.model;
  }

  findMetrics(text) {
    const lower = text.toLowerCase();
    return Object.entries(this.model.metrics)
      .filter(([key, value]) => [key, value.label, ...(value.aliases || [])].some((name) => lower.includes(String(name).toLowerCase())))
      .map(([key]) => key);
  }

  findDimensions(text) {
    const lower = text.toLowerCase();
    return Object.entries(this.model.dimensions)
      .filter(([key, value]) => [key, value.label, ...(value.aliases || [])].some((name) => lower.includes(String(name).toLowerCase())))
      .map(([key]) => key)
      .filter((key) => key !== "date");
  }

  buildQuery(input = {}) {
    const metricKeys = Array.isArray(input.metrics) && input.metrics.length ? [...new Set(input.metrics)] : [this.model.defaultMetric];
    const dimensionKeys = Array.isArray(input.dimensions) ? [...new Set(input.dimensions)] : [];
    const grain = input.timeGrain || null;
    const filters = input.filters && typeof input.filters === "object" ? input.filters : {};
    const startDate = input.startDate || null;
    const endDate = input.endDate || null;

    const select = [];
    const groups = [];
    if (grain) {
      if (!this.model.timeGrains.includes(grain)) throw new Error(`未知时间粒度: ${grain}`);
      const expr = timeExpression(this.model.timeColumn, grain);
      select.push(`${expr} AS "period"`);
      groups.push(expr);
    }
    for (const key of dimensionKeys) {
      const dimension = this.model.dimensions[key];
      if (!dimension || key === "date") throw new Error(`未知维度: ${key}`);
      const expr = quoteIdentifier(dimension.column);
      select.push(`${expr} AS ${quoteIdentifier(key)}`);
      groups.push(expr);
    }
    for (const key of metricKeys) {
      const metric = this.model.metrics[key];
      if (!metric) throw new Error(`未知指标: ${key}`);
      select.push(`${metricExpression(metric, this.model)} AS ${quoteIdentifier(key)}`);
    }

    const where = [];
    const params = [];
    if (startDate) {
      if (!DATE.test(startDate)) throw new Error("startDate 必须是 YYYY-MM-DD");
      where.push(`${quoteIdentifier(this.model.timeColumn)} >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      if (!DATE.test(endDate)) throw new Error("endDate 必须是 YYYY-MM-DD");
      where.push(`${quoteIdentifier(this.model.timeColumn)} <= ?`);
      params.push(endDate);
    }
    for (const [key, rawValues] of Object.entries(filters)) {
      const dimension = this.model.dimensions[key];
      if (!dimension || key === "date") throw new Error(`筛选维度未注册: ${key}`);
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      if (!values.length || values.length > 50) throw new Error("每个维度须提供 1 到 50 个筛选值");
      where.push(`${quoteIdentifier(dimension.column)} IN (${values.map(() => "?").join(",")})`);
      params.push(...values.map(String));
    }

    const sql = [
      `SELECT ${select.join(", ")}`,
      `FROM ${quoteIdentifier(this.model.table)}`,
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      groups.length ? `GROUP BY ${groups.join(", ")}` : "",
      groups.length ? `ORDER BY ${groups.join(", ")} ASC` : "",
      "LIMIT 500",
    ].filter(Boolean).join("\n");
    return { sql, params, metrics: metricKeys, dimensions: dimensionKeys, timeGrain: grain };
  }

  execute(db, input) {
    const plan = this.buildQuery(input);
    const rows = db.prepare(plan.sql).all(...plan.params);
    return { ...plan, rows };
  }
}
