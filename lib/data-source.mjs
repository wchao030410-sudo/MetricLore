import { randomUUID } from "node:crypto";

import { parseCsv } from "./ingest/parsers/csv.mjs";
import { parseXlsx } from "./ingest/parsers/xlsx.mjs";
import { json, newId, nowIso } from "./ingest/util.mjs";

const DATE_PATTERNS = [/^\d{4}-\d{1,2}-\d{1,2}$/, /^\d{4}\/\d{1,2}\/\d{1,2}$/, /^\d{4}-\d{2}-\d{2}T/, /^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/];
const TYPES = new Set(["INTEGER", "REAL", "TEXT"]);
const ROLES = new Set(["time", "dimension", "measure", "attribute"]);

function sanitizeColumnName(name, used) {
  let base = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base) base = "column";
  if (!/^[a-z_]/i.test(base)) base = `col_${base}`;
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) candidate = `${base}_${index++}`;
  used.add(candidate);
  return candidate;
}

function inferType(values) {
  const sample = values.filter((value) => value !== null && value !== undefined && value !== "").slice(0, 200);
  if (!sample.length) return "TEXT";
  const numbers = sample.map((value) => Number(value));
  const allNumeric = numbers.every(Number.isFinite);
  if (allNumeric) return numbers.every(Number.isInteger) ? "INTEGER" : "REAL";
  const strings = sample.map((value) => String(value).trim());
  return strings.every((value) => DATE_PATTERNS.some((pattern) => pattern.test(value))) ? "DATE" : "TEXT";
}

function isDateColumn(values) {
  const sample = values.filter((value) => value !== null && value !== undefined && value !== "").slice(0, 50);
  if (!sample.length) return false;
  return sample.every((value) => DATE_PATTERNS.some((pattern) => pattern.test(String(value).trim())));
}

export function inferColumns(rows) {
  const header = (rows[0] || []).map((cell, index) => (cell === null || cell === undefined ? `列${index + 1}` : String(cell)));
  const data = rows.slice(1);
  const used = new Set();
  return header.map((original, index) => {
    const name = sanitizeColumnName(original, used);
    const values = data.map((row) => row[index]);
    const type = inferType(values);
    let role = "attribute";
    if (/^(date|time|day|dt|timestamp|日期|时间|天)$/i.test(name) || isDateColumn(values)) role = "time";
    else if (type === "TEXT") role = "dimension";
    else role = "measure";
    return { name, original, type, role };
  });
}

function coerce(value, type) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return ["REAL", "INTEGER"].includes(type) ? value.getTime() : value.toISOString().slice(0, 10);
  if (type === "INTEGER") {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? number : String(value);
  }
  if (type === "REAL") {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  return String(value);
}

function normalizeType(type) {
  const upper = String(type || "TEXT").toUpperCase();
  return TYPES.has(upper) ? upper : "TEXT";
}

export class DataSourceService {
  constructor({ db }) {
    this.db = db;
  }

  async parseUpload(buffer, filename) {
    const extension = String(filename || "").split(".").pop()?.toLowerCase();
    if (extension === "csv") return { rows: parseCsv(buffer.toString("utf8")) };
    if (extension === "xlsx") {
      const sheets = await parseXlsx(buffer);
      return { rows: sheets[0]?.rows || [] };
    }
    throw new Error("仅支持 CSV 或 XLSX 文件");
  }

  async preview({ buffer, filename }) {
    const { rows } = await this.parseUpload(buffer, filename);
    if (!rows.length) throw new Error("文件没有可读取的数据行");
    if (rows.length > 100_000) throw new Error("数据行数超过 100,000 行限制");
    return {
      suggestedName: String(filename || "").replace(/\.(csv|xlsx)$/i, "").slice(0, 100) || "未命名数据源",
      totalRows: rows.length - 1,
      columns: inferColumns(rows),
      preview: rows.slice(1, 51).map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))),
    };
  }

  async create({ name, buffer, filename, columns }) {
    const { rows } = await this.parseUpload(buffer, filename);
    if (!rows.length) throw new Error("文件没有可读取的数据行");
    const inferred = inferColumns(rows);
    const used = new Set();
    const spec = (Array.isArray(columns) && columns.length ? columns : inferred).map((column) => {
      const normalized = sanitizeColumnName(column.name || column.original, used);
      const type = normalizeType(column.type);
      const role = ROLES.has(column.role) ? column.role : "attribute";
      return { name: normalized, type, role };
    });
    if (!spec.some((column) => column.role === "time")) spec[0] = { ...spec[0], role: "time" };
    const table = `user_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const createSql = `CREATE TABLE "${table}" (${spec.map((column) => `"${column.name}" ${column.type}`).join(", ")})`;
    this.db.exec(createSql);
    const insert = this.db.prepare(`INSERT INTO "${table}" (${spec.map((column) => `"${column.name}"`).join(", ")}) VALUES (${spec.map(() => "?").join(", ")})`);
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const row of rows.slice(1)) {
        if (row.every((cell) => cell === null || cell === undefined || cell === "")) continue;
        insert.run(...spec.map((column, index) => coerce(row[index], column.type)));
        inserted += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.exec(`DROP TABLE IF EXISTS "${table}"`);
      throw error;
    }

    const id = newId("src_");
    const now = nowIso();
    this.db.prepare("INSERT INTO data_sources (id, name, kind, table_name, source_file, row_count, columns_json, created_at, updated_at) VALUES (?, ?, 'uploaded', ?, ?, ?, ?, ?, ?)")
      .run(id, String(name || "未命名数据源").slice(0, 100), table, filename || null, inserted, json(spec), now, now);
    return this.get(id);
  }

  list() {
    return this.db.prepare(`SELECT ds.*, (SELECT COUNT(*) FROM semantic_models m WHERE m.table_name = ds.table_name) AS model_count
      FROM data_sources ds ORDER BY kind DESC, created_at ASC, id`).all()
      .map((row) => this.decorateSummary(row));
  }

  get(id) {
    const row = this.db.prepare(`SELECT ds.*, (SELECT COUNT(*) FROM semantic_models m WHERE m.table_name = ds.table_name) AS model_count
      FROM data_sources ds WHERE ds.id = ?`).get(id);
    if (!row) return null;
    const columns = JSON.parse(row.columns_json || "[]");
    let preview = [];
    try {
      preview = this.db.prepare(`SELECT * FROM "${row.table_name}" LIMIT 50`).all()
        .map((item) => columns.map((column) => item[column.name] ?? ""));
    } catch { /* 表可能已不可读 */ }
    const models = this.db.prepare("SELECT id, label, is_active FROM semantic_models WHERE table_name = ? ORDER BY is_active DESC, id").all(row.table_name)
      .map((model) => ({ id: model.id, label: model.label, active: Boolean(model.is_active) }));
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      table: row.table_name,
      sourceFile: row.source_file,
      rowCount: row.row_count,
      columns,
      modelCount: row.model_count,
      models,
      preview,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  remove(id) {
    const source = this.get(id);
    if (!source) return false;
    if (source.kind === "builtin") {
      const error = new Error("内置数据源不能删除");
      error.code = "BUILTIN_SOURCE_PROTECTED"; error.status = 409;
      throw error;
    }
    if (source.modelCount > 0) {
      const error = new Error(`数据源被 ${source.modelCount} 个语义模型引用，请先删除相关模型`);
      error.code = "SOURCE_REFERENCED_BY_MODEL"; error.status = 409;
      throw error;
    }
    this.db.exec(`DROP TABLE IF EXISTS "${source.table}"`);
    this.db.prepare("DELETE FROM data_sources WHERE id = ?").run(id);
    return true;
  }

  decorateSummary(row) {
    const columns = JSON.parse(row.columns_json || "[]");
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      table: row.table_name,
      sourceFile: row.source_file,
      rowCount: row.row_count,
      columnCount: columns.length,
      timeColumn: columns.find((column) => column.role === "time")?.name || null,
      modelCount: row.model_count,
      createdAt: row.created_at,
    };
  }
}
