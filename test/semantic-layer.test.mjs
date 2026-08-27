import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { closeDatabase, openDatabase } from "../lib/database.mjs";
import { runMigrations } from "../lib/migrations.mjs";
import { SemanticLayer } from "../lib/semantic-layer.mjs";

test("builds a governed parameterized query", () => {
  const layer = new SemanticLayer();
  const plan = layer.buildQuery({
    metrics: ["revenue", "aov"],
    dimensions: ["region"],
    filters: { channel: ["会员"] },
    startDate: "2026-08-01",
    endDate: "2026-08-26",
  });
  assert.match(plan.sql, /SUM\("revenue"\)/);
  assert.match(plan.sql, /NULLIF\(SUM\("orders"\), 0\)/);
  assert.equal(plan.sql.includes("会员"), false);
  assert.deepEqual(plan.params, ["2026-08-01", "2026-08-26", "会员"]);
});

test("rejects unknown metrics and dimensions", () => {
  const layer = new SemanticLayer();
  assert.throws(() => layer.buildQuery({ metrics: ["secret_metric"] }), /未知指标/);
  assert.throws(() => layer.buildQuery({ filters: { ungoverned: ["x"] } }), /未注册/);
});

test("recognizes Chinese aliases", () => {
  const layer = new SemanticLayer();
  assert.deepEqual(layer.findMetrics("近 7 天 GMV 和客单价"), ["revenue", "aov"]);
  assert.deepEqual(layer.findDimensions("按大区拆分"), ["region"]);
});

test("registers, queries and reloads a custom metric from SQLite", () => {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-semantic-")), "test.db"));
  try {
    runMigrations(db);
    const layer = new SemanticLayer(undefined, db);
    const registered = layer.registerMetric({
      key: "revenue_per_visitor",
      label: "收入访客价值",
      description: "支付成功收入除以同期访客数",
      type: "derived",
      numerator: "revenue",
      denominator: "visitors",
      scale: 1,
      format: "currency",
      aliases: ["单访价值", "RPV"],
    });

    assert.equal(registered.source, "custom");
    assert.equal(layer.catalog().registry.customMetricKeys.includes("revenue_per_visitor"), true);
    assert.deepEqual(layer.findMetrics("帮我看一下单访价值"), ["revenue_per_visitor"]);
    assert.deepEqual(layer.findMetrics("收入访客价值的口径是什么"), ["revenue_per_visitor"]);
    assert.deepEqual(layer.findMetrics("比较收入和收入访客价值"), ["revenue", "revenue_per_visitor"]);
    const result = layer.execute(db, { metrics: ["revenue_per_visitor"] });
    assert.equal(result.rows.length, 1);
    assert.ok(result.rows[0].revenue_per_visitor > 0);
    assert.throws(() => layer.registerMetric({
      key: "revenue_per_visitor", label: "重复指标", description: "重复", type: "atomic", column: "revenue",
    }), (error) => error.code === "METRIC_ALREADY_EXISTS");
    assert.throws(() => layer.registerMetric({
      key: "gmv", label: "另一个指标", description: "key 与现有别名冲突", type: "atomic", column: "revenue",
    }), (error) => error.code === "METRIC_ALIAS_CONFLICT");

    const reloaded = new SemanticLayer(undefined, db);
    assert.equal(reloaded.catalog().metrics.revenue_per_visitor.description, "支付成功收入除以同期访客数");
  } finally {
    closeDatabase();
  }
});

test("creates multiple semantic models and switches the Agent model", () => {
  const db = openDatabase(resolve(mkdtempSync(resolve(tmpdir(), "ml-models-")), "test.db"));
  try {
    runMigrations(db);
    const layer = new SemanticLayer(undefined, db);
    const created = layer.registerModel({
      id: "regional_commerce",
      label: "区域经营模型",
      description: "按区域查看经营指标",
      table: "daily_metrics",
      timeColumn: "date",
      dimensionColumns: ["region", "channel"],
    });
    assert.equal(created.ready, false);
    assert.equal(layer.catalog("regional_commerce").registry.selectedModelId, "regional_commerce");
    assert.equal(layer.catalog("regional_commerce").registry.physicalColumns.length, 6);

    layer.registerMetric({
      modelId: "regional_commerce", key: "regional_orders", label: "区域订单量",
      description: "区域内支付成功且未取消的订单数", type: "atomic", column: "orders", aggregation: "SUM", format: "integer",
    });
    const activated = layer.activateModel("regional_commerce");
    assert.equal(activated.active, true);
    assert.equal(layer.model.model, "regional_commerce");
    assert.ok(layer.execute(db, { metrics: ["regional_orders"], dimensions: ["region"] }).rows.length > 0);

    const reloaded = new SemanticLayer(undefined, db);
    assert.equal(reloaded.activeModelId, "regional_commerce");
    assert.equal(reloaded.catalog().metrics.regional_orders.label, "区域订单量");
    assert.equal(reloaded.catalog().registry.models.length, 2);
  } finally {
    closeDatabase();
  }
});
