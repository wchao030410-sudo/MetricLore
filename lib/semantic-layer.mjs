import { resolve } from "node:path";

import { ROOT, readJson } from "./config.mjs";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_KEY = /^[a-z][a-z0-9_]*$/;
const AGGREGATIONS = new Set(["SUM", "AVG", "MIN", "MAX", "COUNT"]);
const FORMATS = new Set(["currency", "integer", "percent", "number"]);
const TIME_GRAINS = new Set(["day", "week", "month"]);
const OPERATIONAL_TABLE = /^(schema_migrations|semantic_|ingestion_|document_chunks$|knowledge_candidates$|review_decisions$|wiki_|conversations$|messages$|conversation_context$|agent_|tool_calls$|evidence_records$|idempotency_keys$|evaluation_|data_sources$)/;

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
    this.models = new Map([[this.baseModel.model, structuredClone(this.baseModel)]]);
    this.customMetricKeysByModel = new Map([[this.baseModel.model, new Set()]]);
    this.activeModelId = this.baseModel.model;
    this.model = this.models.get(this.activeModelId);
    this.db = null;
    this.validate();
    if (db) this.attachDatabase(db);
  }

  validateModel(model) {
    quoteIdentifier(model.model);
    quoteIdentifier(model.table);
    quoteIdentifier(model.timeColumn);
    for (const [key, metric] of Object.entries(model.metrics || {})) {
      quoteIdentifier(key);
      metricExpression(metric, model);
    }
    for (const [key, dimension] of Object.entries(model.dimensions || {})) {
      quoteIdentifier(key);
      quoteIdentifier(dimension.column);
    }
    for (const grain of model.timeGrains || []) if (!TIME_GRAINS.has(grain)) throw new Error(`不支持的时间粒度: ${grain}`);
    if (model.defaultMetric && !model.metrics?.[model.defaultMetric]) throw new Error(`默认指标未注册: ${model.defaultMetric}`);
    return model;
  }

  validate() {
    for (const model of this.models.values()) this.validateModel(model);
  }

  modelFor(modelId = this.activeModelId) {
    const model = this.models.get(modelId);
    if (!model) throw semanticError(`语义模型不存在: ${modelId}`, "SEMANTIC_MODEL_NOT_FOUND", 404);
    return model;
  }

  listModels() {
    return [...this.models.values()].map((model) => ({
      id: model.model,
      label: model.label,
      description: model.description || "",
      table: model.table,
      timeColumn: model.timeColumn,
      metricCount: Object.keys(model.metrics || {}).length,
      dimensionCount: Object.keys(model.dimensions || {}).length,
      source: model.source || (model.model === this.baseModel.model ? "base" : "custom"),
      active: model.model === this.activeModelId,
      ready: Boolean(model.defaultMetric && Object.keys(model.metrics || {}).length),
    }));
  }

  listAllMetrics() {
    const out = [];
    for (const [modelId, model] of this.models) {
      const custom = this.customMetricKeysByModel.get(modelId) || new Set();
      for (const [key, metric] of Object.entries(model.metrics || {})) {
        const formula = metric.type === "atomic"
          ? `${metric.aggregation}(${metric.column})`
          : `${metric.numerator} / ${metric.denominator}${metric.scale ? ` × ${metric.scale}` : ""}`;
        out.push({
          modelId,
          modelLabel: model.label,
          modelActive: modelId === this.activeModelId,
          key,
          label: metric.label,
          description: metric.description || "",
          type: metric.type,
          formula,
          format: metric.format,
          source: custom.has(key) ? "custom" : "base",
        });
      }
    }
    return out.sort((a, b) => a.modelLabel.localeCompare(b.modelLabel) || a.key.localeCompare(b.key));
  }

  catalog(modelId = this.activeModelId) {
    const model = this.modelFor(modelId);
    const customMetricKeys = this.customMetricKeysByModel.get(model.model) || new Set();
    const metrics = Object.fromEntries(Object.entries(model.metrics || {}).map(([key, metric]) => [key, {
      ...metric,
      source: customMetricKeys.has(key) ? "custom" : "base",
    }]));
    return {
      ...model,
      metrics,
      registry: {
        writable: Boolean(this.db),
        activeModelId: this.activeModelId,
        selectedModelId: model.model,
        models: this.listModels(),
        customMetricKeys: [...customMetricKeys],
        physicalColumns: this.physicalColumns(model),
        databaseTables: this.databaseTables(),
      },
    };
  }

  attachDatabase(db) {
    this.db = db;
    this.models = new Map([[this.baseModel.model, structuredClone(this.baseModel)]]);
    this.customMetricKeysByModel = new Map([[this.baseModel.model, new Set()]]);
    this.activeModelId = this.baseModel.model;
    const registry = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_models'").get();
    if (!registry) {
      this.model = this.models.get(this.activeModelId);
      return this;
    }

    const modelRows = db.prepare("SELECT * FROM semantic_models ORDER BY created_at, id").all();
    for (const row of modelRows) {
      if (row.id !== this.baseModel.model) {
        this.models.set(row.id, {
          model: row.id,
          label: row.label,
          description: row.description || "",
          table: row.table_name,
          timeColumn: row.time_column,
          defaultMetric: row.default_metric || null,
          timeGrains: JSON.parse(row.time_grains_json || "[]"),
          metrics: {},
          dimensions: {},
          source: row.source || "custom",
        });
        this.customMetricKeysByModel.set(row.id, new Set());
      }
      if (row.is_active) this.activeModelId = row.id;
    }

    const dimensionRows = db.prepare("SELECT model_id, key, definition_json FROM semantic_dimensions ORDER BY model_id, key").all();
    for (const row of dimensionRows) {
      const model = this.models.get(row.model_id);
      if (model && row.model_id !== this.baseModel.model) model.dimensions[row.key] = JSON.parse(row.definition_json);
    }
    const rows = db.prepare("SELECT model_id, key, definition_json FROM semantic_metrics ORDER BY model_id, created_at, key").all();
    for (const row of rows) {
      const model = this.models.get(row.model_id);
      if (!model) continue;
      const metric = JSON.parse(row.definition_json);
      model.metrics[row.key] = metric;
      this.customMetricKeysByModel.get(row.model_id)?.add(row.key);
    }
    for (const row of modelRows) {
      const model = this.models.get(row.id);
      if (model && row.id !== this.baseModel.model) model.defaultMetric = row.default_metric || Object.keys(model.metrics)[0] || null;
    }
    if (!this.models.has(this.activeModelId)) this.activeModelId = this.baseModel.model;
    this.model = this.models.get(this.activeModelId);
    this.validate();
    return this;
  }

  databaseTables() {
    if (!this.db) return [];
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map((row) => row.name)
      .filter((name) => !OPERATIONAL_TABLE.test(name))
      .map((name) => ({ name, columns: this.tableColumns(name) }));
  }

  tableColumns(table) {
    if (!this.db) return [];
    return this.db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => {
      const type = String(row.type || "").toUpperCase();
      return { name: row.name, type: type || "UNKNOWN", numeric: /(INT|REAL|NUM|DEC|DOUBLE|FLOAT)/.test(type) };
    });
  }

  physicalColumns(model = this.model) {
    if (!this.db) return [];
    const rows = this.tableColumns(model.table);
    const dimensionColumns = new Set(Object.values(model.dimensions || {}).map((item) => item.column));
    const metricColumns = new Set(Object.values(model.metrics || {}).filter((item) => item.type === "atomic").map((item) => item.column));
    return rows.map((row) => {
      let role = "attribute";
      if (row.name === model.timeColumn) role = "time";
      else if (dimensionColumns.has(row.name)) role = "dimension";
      else if (metricColumns.has(row.name)) role = "measure";
      return { ...row, role };
    });
  }

  registerModel(input = {}) {
    if (!this.db) throw semanticError("语义模型管理需要可写数据库", "SEMANTIC_REGISTRY_UNAVAILABLE", 503);
    const id = String(input.id || input.key || "").trim().toLowerCase();
    const label = String(input.label || "").trim();
    const description = String(input.description || "").trim();
    const table = String(input.table || "").trim();
    const timeColumn = String(input.timeColumn || "").trim();
    const grains = [...new Set(Array.isArray(input.timeGrains) && input.timeGrains.length ? input.timeGrains : ["day", "week", "month"])];
    if (!METRIC_KEY.test(id)) throw semanticError("模型 ID 必须使用小写字母、数字和下划线，并以字母开头", "INVALID_SEMANTIC_MODEL");
    if (!label || label.length > 80) throw semanticError("模型名称不能为空且不能超过 80 个字符", "INVALID_SEMANTIC_MODEL");
    if (description.length > 500) throw semanticError("模型说明不能超过 500 个字符", "INVALID_SEMANTIC_MODEL");
    if (this.models.has(id)) throw semanticError(`语义模型已存在: ${id}`, "SEMANTIC_MODEL_ALREADY_EXISTS", 409);
    if (grains.some((grain) => !TIME_GRAINS.has(grain))) throw semanticError("时间粒度只支持 day、week、month", "INVALID_SEMANTIC_MODEL");
    const columns = this.tableColumns(table);
    if (!columns.length) throw semanticError(`数据库中不存在事实表: ${table}`, "INVALID_SEMANTIC_MODEL");
    if (!columns.some((column) => column.name === timeColumn)) throw semanticError(`事实表中不存在时间字段: ${timeColumn}`, "INVALID_SEMANTIC_MODEL");

    const requestedDimensions = Array.isArray(input.dimensionColumns) ? input.dimensionColumns.map(String) : [];
    const dimensionColumns = requestedDimensions.length
      ? requestedDimensions
      : columns.filter((column) => column.name !== timeColumn && !column.numeric).map((column) => column.name);
    for (const column of dimensionColumns) {
      if (!columns.some((item) => item.name === column)) throw semanticError(`事实表中不存在维度字段: ${column}`, "INVALID_SEMANTIC_MODEL");
      quoteIdentifier(column);
    }
    const dimensions = {
      date: { label: "日期", column: timeColumn, type: "date", aliases: ["时间", "天"] },
    };
    for (const column of dimensionColumns.filter((item) => item !== timeColumn)) {
      const physical = columns.find((item) => item.name === column);
      dimensions[column] = { label: column, column, type: physical?.numeric ? "number" : "string", aliases: [] };
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO semantic_models
        (id, label, description, table_name, time_column, default_metric, time_grains_json, source, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, 'custom', 0, ?, ?)`)
        .run(id, label, description, table, timeColumn, JSON.stringify(grains), now, now);
      const insertDimension = this.db.prepare("INSERT INTO semantic_dimensions (model_id, key, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
      for (const [key, definition] of Object.entries(dimensions)) insertDimension.run(id, key, JSON.stringify(definition), now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const model = { model: id, label, description, table, timeColumn, defaultMetric: null, timeGrains: grains, metrics: {}, dimensions, source: "custom" };
    this.validateModel(model);
    this.models.set(id, model);
    this.customMetricKeysByModel.set(id, new Set());
    return this.listModels().find((item) => item.id === id);
  }

  activateModel(modelId) {
    if (!this.db) throw semanticError("语义模型管理需要可写数据库", "SEMANTIC_REGISTRY_UNAVAILABLE", 503);
    const model = this.modelFor(modelId);
    if (!model.defaultMetric || !Object.keys(model.metrics || {}).length) {
      throw semanticError("至少注册一个指标后才能设为 Agent 当前模型", "SEMANTIC_MODEL_NOT_READY", 409);
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE semantic_models SET is_active = 0, updated_at = ? WHERE is_active = 1").run(now);
      const result = this.db.prepare("UPDATE semantic_models SET is_active = 1, updated_at = ? WHERE id = ?").run(now, modelId);
      if (!result.changes) throw semanticError(`语义模型不存在: ${modelId}`, "SEMANTIC_MODEL_NOT_FOUND", 404);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.activeModelId = modelId;
    this.model = model;
    return this.listModels().find((item) => item.id === modelId);
  }

  registerMetric(input = {}, requestedModelId = input.modelId || this.activeModelId) {
    if (!this.db) throw semanticError("语义指标注册需要可写数据库", "SEMANTIC_REGISTRY_UNAVAILABLE", 503);
    const model = this.modelFor(requestedModelId);
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
    if (model.metrics[key]) throw semanticError(`指标 key 已存在: ${key}`, "METRIC_ALREADY_EXISTS", 409);

    const newTerms = [key, label, ...aliases].map((item) => item.toLowerCase());
    for (const [existingKey, metric] of Object.entries(model.metrics)) {
      const terms = [existingKey, metric.label, ...(metric.aliases || [])].map((item) => String(item).toLowerCase());
      const overlap = newTerms.find((item) => terms.includes(item));
      if (overlap) throw semanticError(`名称或别名“${overlap}”已被指标 ${existingKey} 使用`, "METRIC_ALIAS_CONFLICT", 409);
    }

    let metric;
    if (type === "atomic") {
      const column = String(input.column || "").trim();
      const aggregation = String(input.aggregation || "SUM").toUpperCase();
      const physical = this.physicalColumns(model).find((item) => item.name === column);
      if (!physical) throw semanticError(`事实表中不存在字段: ${column}`);
      if (!physical.numeric) throw semanticError(`字段 ${column} 不是数值字段，不能注册为指标`);
      if (!AGGREGATIONS.has(aggregation)) throw semanticError(`不支持的聚合方式: ${aggregation}`);
      metric = { label, description, type, aggregation, column, format, aliases };
    } else {
      const numerator = String(input.numerator || "").trim();
      const denominator = String(input.denominator || "").trim();
      const scale = Number(input.scale ?? 1);
      if (!model.metrics[numerator]) throw semanticError(`分子指标未注册: ${numerator}`);
      if (!model.metrics[denominator]) throw semanticError(`分母指标未注册: ${denominator}`);
      if (model.metrics[numerator].type !== "atomic" || model.metrics[denominator].type !== "atomic") {
        throw semanticError("派生指标的分子和分母必须是已注册原子指标");
      }
      if (!Number.isFinite(scale) || scale <= 0 || scale > 10000) throw semanticError("缩放系数必须大于 0 且不超过 10000");
      metric = { label, description, type, numerator, denominator, scale, format, aliases };
    }

    metricExpression(metric, { ...model, metrics: { ...model.metrics, [key]: metric } });
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO semantic_metrics (model_id, key, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(model.model, key, JSON.stringify(metric), now, now);
    model.metrics[key] = metric;
    this.customMetricKeysByModel.get(model.model)?.add(key);
    if (!model.defaultMetric) {
      model.defaultMetric = key;
      this.db.prepare("UPDATE semantic_models SET default_metric = ?, updated_at = ? WHERE id = ?").run(key, now, model.model);
    }
    return { key, modelId: model.model, ...metric, source: "custom", createdAt: now };
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
    const model = this.modelFor(input.modelId || this.activeModelId);
    if (!model.defaultMetric) throw semanticError(`语义模型 ${model.model} 尚未注册指标`, "SEMANTIC_MODEL_NOT_READY", 409);
    const metricKeys = Array.isArray(input.metrics) && input.metrics.length ? [...new Set(input.metrics)] : [model.defaultMetric];
    const dimensionKeys = Array.isArray(input.dimensions) ? [...new Set(input.dimensions)] : [];
    const grain = input.timeGrain || null;
    const filters = input.filters && typeof input.filters === "object" ? input.filters : {};
    const startDate = input.startDate || null;
    const endDate = input.endDate || null;

    const select = [];
    const groups = [];
    if (grain) {
      if (!model.timeGrains.includes(grain)) throw new Error(`未知时间粒度: ${grain}`);
      const expr = timeExpression(model.timeColumn, grain);
      select.push(`${expr} AS "period"`);
      groups.push(expr);
    }
    for (const key of dimensionKeys) {
      const dimension = model.dimensions[key];
      if (!dimension || key === "date") throw new Error(`未知维度: ${key}`);
      const expr = quoteIdentifier(dimension.column);
      select.push(`${expr} AS ${quoteIdentifier(key)}`);
      groups.push(expr);
    }
    for (const key of metricKeys) {
      const metric = model.metrics[key];
      if (!metric) throw new Error(`未知指标: ${key}`);
      select.push(`${metricExpression(metric, model)} AS ${quoteIdentifier(key)}`);
    }

    const where = [];
    const params = [];
    if (startDate) {
      if (!DATE.test(startDate)) throw new Error("startDate 必须是 YYYY-MM-DD");
      where.push(`${quoteIdentifier(model.timeColumn)} >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      if (!DATE.test(endDate)) throw new Error("endDate 必须是 YYYY-MM-DD");
      where.push(`${quoteIdentifier(model.timeColumn)} <= ?`);
      params.push(endDate);
    }
    for (const [key, rawValues] of Object.entries(filters)) {
      const dimension = model.dimensions[key];
      if (!dimension || key === "date") throw new Error(`筛选维度未注册: ${key}`);
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      if (!values.length || values.length > 50) throw new Error("每个维度须提供 1 到 50 个筛选值");
      where.push(`${quoteIdentifier(dimension.column)} IN (${values.map(() => "?").join(",")})`);
      params.push(...values.map(String));
    }

    const sql = [
      `SELECT ${select.join(", ")}`,
      `FROM ${quoteIdentifier(model.table)}`,
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      groups.length ? `GROUP BY ${groups.join(", ")}` : "",
      groups.length ? `ORDER BY ${groups.join(", ")} ASC` : "",
      "LIMIT 500",
    ].filter(Boolean).join("\n");
    return { sql, params, modelId: model.model, metrics: metricKeys, dimensions: dimensionKeys, timeGrain: grain };
  }

  execute(db, input) {
    const plan = this.buildQuery(input);
    const rows = db.prepare(plan.sql).all(...plan.params);
    return { ...plan, rows };
  }
}
