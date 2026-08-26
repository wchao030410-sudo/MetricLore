import assert from "node:assert/strict";
import test from "node:test";

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
