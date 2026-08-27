import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "../lib/config.mjs";
import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";

function quote(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`非法字段: ${value}`);
  return `"${value}"`;
}

function aggregateAtomic(metric, rows) {
  const values = rows.map((row) => row[metric.column]).filter((value) => value !== null && value !== undefined).map(Number);
  if (metric.aggregation === "COUNT") return values.length;
  if (!values.length) return null;
  if (metric.aggregation === "SUM") return values.reduce((sum, value) => sum + value, 0);
  if (metric.aggregation === "AVG") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (metric.aggregation === "MIN") return Math.min(...values);
  if (metric.aggregation === "MAX") return Math.max(...values);
  throw new Error(`不支持的聚合: ${metric.aggregation}`);
}

function metricValue(key, model, rows) {
  const metric = model.metrics[key];
  if (metric.type === "atomic") return aggregateAtomic(metric, rows);
  const numerator = metricValue(metric.numerator, model, rows);
  const denominator = metricValue(metric.denominator, model, rows);
  return denominator === 0 || denominator === null ? null : (numerator / denominator) * Number(metric.scale || 1);
}

function sameNumber(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  const a = Number(actual); const e = Number(expected);
  return Number.isFinite(a) && Number.isFinite(e) && Math.abs(a - e) <= Math.max(1e-8, Math.abs(e) * 1e-9);
}

function groupRows(rows, dimensions, model) {
  const groups = new Map();
  for (const row of rows) {
    const values = dimensions.map((key) => row[model.dimensions[key].column]);
    const key = JSON.stringify(values);
    if (!groups.has(key)) groups.set(key, { values, rows: [] });
    groups.get(key).rows.push(row);
  }
  if (!groups.size && !dimensions.length) groups.set("[]", { values: [], rows: [] });
  return groups;
}

const db = openDatabase();
runMigrations(db);
const semantic = new SemanticLayer(undefined, db);
const model = semantic.model;
const metricKeys = Object.keys(model.metrics);
const rawRows = db.prepare(`SELECT * FROM ${quote(model.table)}`).all();
const dates = rawRows.map((row) => row[model.timeColumn]).filter(Boolean).sort();
const endDate = dates.at(-1);
const last30Start = new Date(`${endDate}T00:00:00Z`); last30Start.setUTCDate(last30Start.getUTCDate() - 29);
const firstDimension = Object.keys(model.dimensions).find((key) => key !== "date");
const firstDimensionValue = firstDimension ? rawRows[0]?.[model.dimensions[firstDimension].column] : null;
const scenarios = [
  { id: "all-data", dimensions: [], filters: {} },
  { id: "last-30-days", dimensions: [], filters: {}, startDate: last30Start.toISOString().slice(0, 10), endDate },
  { id: "dimension-breakdown", dimensions: firstDimension ? [firstDimension] : [], filters: {} },
  { id: "dimension-filter", dimensions: [], filters: firstDimension ? { [firstDimension]: [firstDimensionValue] } : {} },
];

const failures = [];
let valueCheckCount = 0;
let passedChecks = 0;
const queryLatencies = [];
for (const scenario of scenarios) {
  const filtered = rawRows.filter((row) => {
    const date = row[model.timeColumn];
    if (scenario.startDate && date < scenario.startDate) return false;
    if (scenario.endDate && date > scenario.endDate) return false;
    return Object.entries(scenario.filters).every(([key, values]) => values.includes(row[model.dimensions[key].column]));
  });
  const expectedGroups = groupRows(filtered, scenario.dimensions, model);
  const started = performance.now();
  const actual = semantic.execute(db, {
    modelId: model.model, metrics: metricKeys, dimensions: scenario.dimensions, filters: scenario.filters,
    startDate: scenario.startDate, endDate: scenario.endDate,
  }).rows;
  queryLatencies.push(performance.now() - started);
  const actualIndex = new Map(actual.map((row) => [JSON.stringify(scenario.dimensions.map((key) => row[key])), row]));
  for (const [groupKey, group] of expectedGroups) {
    const actualRow = actualIndex.get(groupKey);
    for (const metricKey of metricKeys) {
      valueCheckCount += 1;
      const expected = metricValue(metricKey, model, group.rows);
      const value = actualRow?.[metricKey] ?? null;
      if (actualRow && sameNumber(value, expected)) passedChecks += 1;
      else failures.push({ scenario: scenario.id, group: group.values, metric: metricKey, expected, actual: value });
    }
  }
}
closeDatabase();

const sorted = [...queryLatencies].sort((a, b) => a - b);
const report = {
  generatedAt: new Date().toISOString(),
  modelId: model.model,
  queryCount: scenarios.length,
  metricCount: metricKeys.length,
  valueCheckCount,
  passedChecks,
  failedChecks: valueCheckCount - passedChecks,
  accuracy: valueCheckCount ? passedChecks / valueCheckCount : 0,
  averageQueryMs: queryLatencies.reduce((sum, value) => sum + value, 0) / queryLatencies.length,
  p95QueryMs: sorted[Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)],
  failures,
};
mkdirSync(resolve(ROOT, "outputs/evals"), { recursive: true });
writeFileSync(resolve(ROOT, "outputs/evals/data-latest.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ modelId: report.modelId, queryCount: report.queryCount, valueCheckCount, passedChecks, accuracy: report.accuracy, averageQueryMs: report.averageQueryMs, output: "outputs/evals/data-latest.json" }, null, 2));
if (report.failedChecks) process.exitCode = 1;

