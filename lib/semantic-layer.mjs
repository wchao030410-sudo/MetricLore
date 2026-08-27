import { resolve } from "node:path";

import { ROOT, readJson } from "./config.mjs";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_KEY = /^[a-z][a-z0-9_]*$/;
const AGGREGATIONS = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]);
const FORMATS = new Set(["currency", "integer", "percent", "number"]);

function semanticError(message, code = "INVALID_METRIC", status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

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
  constructor(modelPath = resolve(ROOT, "config/semantic-model.json"), db = null) {
    this.modelPath = modelPath || resolve(ROOT, "config/semantic-model.json");
    this.baseModel = readJson(this.modelPath);
    this.model = structuredClone(this.baseModel);
    this.customMetricKeys = new Set();
    this.db = null;
    this.validate();
    if (db) this.attachDatabase(db);
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
    const metrics = Object.fromEntries(Object.entries(this.model.metrics).map(([key, metric]) => [key, {
      ...metric,
      source: this.customMetricKeys.has(key) ? "custom" : "base",
    }]));
    return {
      ...this.model,
      metrics,
      registry: {
        writable: Boolean(this.db),
        customMetricKeys: [...this.customMetricKeys],
        physicalColumns: this.physicalColumns(),
      },
    };
  }

  attachDatabase(db) {
    this.db = db;
    this.model = structuredClone(this.baseModel);
    this.customMetricKeys = new Set();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_metrics'").get();
    if (!table) return this;
    const rows = db.prepare("SELECT key, definition_json FROM semantic_metrics ORDER BY created_at, key").all();
    for (const row of rows) {
      const metric = JSON.parse(row.definition_json);
      this.model.metrics[row.key] = metric;
      this.customMetricKeys.add(row.key);
    }
    this.validate();
    return this;
  }

  physicalColumns() {
    if (!this.db) return [];
    const rows = this.db.prepare(`PRAGMA table_info(${quoteIdentifier(this.model.table)})`).all();
    const dimensionColumns = new Set(Object.values(this.model.dimensions).map((item) => item.column));
    const metricColumns = new Set(Object.values(this.model.metrics).filter((item) => item.type === "atomic").map((item) => item.column));
    return rows.map((row) => {
      const type = String(row.type || "").toUpperCase();
      const numeric = /(INT|REAL|NUM|DEC|DOUBLE|FLOAT)/.test(type);
      let role = "attribute";
      if (row.name === this.model.timeColumn) role = "time";
      else if (dimensionColumns.has(row.name)) role = "dimension";
      else if (metricColumns.has(row.name)) role = "measure";
      return { name: row.name, type: type || "UNKNOWN", numeric, role };
    });
  }

  registerMetric(input = {}) {
    if (!this.db) throw semanticError("语义指标注册需要可写数据库", "SEMANTIC_REGISTRY_UNAVAILABLE", 503);
    const key = String(input.key || "").trim().toLowerCase();
    const label = String(input.label || "").trim();
    const description = String(input.description || "").trim();
    const type = String(input.type || "atomic");
    const format = String(input.format || "number");
    const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : String(input.aliases || "").split(/[,，]/))
      .map((item) => String(item).trim()).filter(Boolean))].slice(0, 20);

    if (!METRIC_KEY.test(key)) throw semanticError("指标 key 必须使用小写字母、数字和下划线，并以字母开头");
    if (!label || label.length > 80) throw semanticError("指标名称不能为空且不能超过 80 个字符");
    if (!description || description.length > 1000) throw semanticError("指标定义不能为空且不能超过 1000 个字符");
    if (!["atomic", "derived"].includes(type)) throw semanticError(`不支持的指标类型: ${type}`);
    if (!FORMATS.has(format)) throw semanticError(`不支持的展示格式: ${format}`);
    if (this.model.metrics[key]) throw semanticError(`指标 key 已存在: ${key}`, "METRIC_ALREADY_EXISTS", 409);

    const newTerms = [key, label, ...aliases].map((item) => item.toLowerCase());
    for (const [existingKey, metric] of Object.entries(this.model.metrics)) {
      const terms = [existingKey, metric.label, ...(metric.aliases || [])].map((item) => String(item).toLowerCase());
      const overlap = newTerms.find((item) => terms.includes(item));
      if (overlap) throw semanticError(`名称或别名“${overlap}”已被指标 ${existingKey} 使用`, "METRIC_ALIAS_CONFLICT", 409);
    }

    let metric;
    if (type === "atomic") {
      const column = String(input.column || "").trim();
      const aggregation = String(input.aggregation || "SUM").toUpperCase();
      const physical = this.physicalColumns().find((item) => item.name === column);
      if (!physical) throw semanticError(`事实表中不存在字段: ${column}`);
      if (!physical.numeric) throw semanticError(`字段 ${column} 不是数值字段，不能注册为指标`);
      if (!AGGREGATIONS.has(aggregation)) throw semanticError(`不支持的聚合方式: ${aggregation}`);
      metric = { label, description, type, aggregation, column, format, aliases };
    } else {
      const numerator = String(input.numerator || "").trim();
      const denominator = String(input.denominator || "").trim();
      const scale = Number(input.scale ?? 1);
      if (!this.model.metrics[numerator]) throw semanticError(`分子指标未注册: ${numerator}`);
      if (!this.model.metrics[denominator]) throw semanticError(`分母指标未注册: ${denominator}`);
      if (this.model.metrics[numerator].type !== "atomic" || this.model.metrics[denominator].type !== "atomic") {
        throw semanticError("派生指标的分子和分母必须是已注册原子指标");
      }
      if (!Number.isFinite(scale) || scale <= 0 || scale > 10000) throw semanticError("缩放系数必须大于 0 且不超过 10000");
      metric = { label, description, type, numerator, denominator, scale, format, aliases };
    }

    metricExpression(metric, { ...this.model, metrics: { ...this.model.metrics, [key]: metric } });
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO semantic_metrics (key, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(key, JSON.stringify(metric), now, now);
    this.model.metrics[key] = metric;
    this.customMetricKeys.add(key);
    return { key, ...metric, source: "custom", createdAt: now };
  }

  findMetrics(text) {
    const lower = text.toLowerCase();
    const matches = [];
    for (const [key, value] of Object.entries(this.model.metrics)) {
      const terms = [...new Set([key, value.label, ...(value.aliases || [])].map((name) => String(name).toLowerCase()).filter(Boolean))];
      for (const term of terms) {
        let start = lower.indexOf(term);
        while (start >= 0) {
          matches.push({ key, term, start, end: start + term.length });
          start = lower.indexOf(term, start + 1);
        }
      }
    }
    const specific = matches.filter((match) => !matches.some((other) => other.key !== match.key
      && other.term.length > match.term.length && other.start <= match.start && other.end >= match.end));
    const keys = new Set(specific.map((match) => match.key));
    return Object.keys(this.model.metrics).filter((key) => keys.has(key));
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
