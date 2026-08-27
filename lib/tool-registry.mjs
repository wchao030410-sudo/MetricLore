function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function dateRange(range) {
  if (!range || !range.startDate || !range.endDate) throw new Error("range 必须包含 startDate 和 endDate");
  return range;
}

export class ToolRegistry {
  constructor({ semantic, wiki, ontology, db }) {
    this.semantic = semantic;
    this.wiki = wiki;
    this.ontology = ontology;
    this.db = db;
    this.evidence = [];
    this.definitions = this.createDefinitions();
  }

  createDefinitions() {
    return {
      wiki_search: {
        description: "搜索已验证 Wiki 实体和页面，返回来源、关系、命中章节和摘要。",
        inputSchema: objectSchema({ query: { type: "string" }, entityTypes: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
      },
      wiki_entity: {
        description: "读取单个 Wiki 实体及其本体关系。",
        inputSchema: objectSchema({ key: { type: "string" } }, ["key"]),
      },
      wiki_trace: {
        description: "从一个实体出发沿本体关系追踪知识路径。",
        inputSchema: objectSchema({ startKey: { type: "string" }, relationTypes: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 1, maximum: 3 } }, ["startKey"]),
      },
      ontology_neighbors: {
        description: "查询实体的一跳本体邻居。",
        inputSchema: objectSchema({ key: { type: "string" }, direction: { type: "string", enum: ["outgoing", "incoming", "both"] }, relationTypes: { type: "array", items: { type: "string" } } }, ["key"]),
      },
      semantic_catalog: {
        description: "在受治理语义目录中发现指标和维度候选。",
        inputSchema: objectSchema({ query: { type: "string" } }, ["query"]),
      },
      metric_query: {
        description: "执行受控指标查询。禁止传入 SQL，只可传递已注册指标、维度、日期和筛选条件。",
        inputSchema: objectSchema({ metrics: { type: "array", items: { type: "string" }, minItems: 1 }, dimensions: { type: "array", items: { type: "string" } }, filters: { type: "object" }, range: objectSchema({ startDate: { type: "string" }, endDate: { type: "string" } }, ["startDate", "endDate"]), timeGrain: { type: "string", enum: ["day", "week", "month"] } }, ["metrics", "range"]),
      },
      compare_periods: {
        description: "对同一个注册指标在两个期间做确定性聚合对比。",
        inputSchema: objectSchema({ metric: { type: "string" }, currentRange: objectSchema({ startDate: { type: "string" }, endDate: { type: "string" } }, ["startDate", "endDate"]), baselineRange: objectSchema({ startDate: { type: "string" }, endDate: { type: "string" } }, ["startDate", "endDate"]), dimensions: { type: "array", items: { type: "string" } }, filters: { type: "object" } }, ["metric", "currentRange", "baselineRange"]),
      },
      dimension_breakdown: {
        description: "按照一个已注册维度拆分注册指标。",
        inputSchema: objectSchema({ metric: { type: "string" }, dimension: { type: "string" }, range: objectSchema({ startDate: { type: "string" }, endDate: { type: "string" } }, ["startDate", "endDate"]), filters: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["metric", "dimension", "range"]),
      },
      submit_evidence: {
        description: "把最终声明绑定到工具来源；只接受本轮已返回的来源键。",
        inputSchema: objectSchema({ claims: { type: "array", items: { type: "string" } }, sourceKeys: { type: "array", items: { type: "string" } } }, ["claims", "sourceKeys"]),
      },
      validate_answer: {
        description: "确定性检查答案是否具备来源、范围和安全边界。",
        inputSchema: objectSchema({ answer: { type: "string" }, mode: { type: "string" }, sourceKeys: { type: "array", items: { type: "string" } } }, ["answer", "mode", "sourceKeys"]),
      },
      knowledge_validate: {
        description: "按本体 Schema 校验候选实体。",
        inputSchema: objectSchema({ entity: { type: "object" } }, ["entity"]),
      },
    };
  }

  forModel(allowedToolNames) {
    return Object.entries(this.definitions)
      .filter(([name]) => allowedToolNames.includes(name))
      .map(([name, definition]) => ({ type: "function", function: { name, description: definition.description, parameters: definition.inputSchema } }));
  }

  async execute(name, args) {
    if (!this.definitions[name]) throw new Error(`未注册工具: ${name}`);
    let data;
    if (name === "wiki_search") data = { results: this.wiki.search(args.query, args.limit || 5, args.entityTypes || []) };
    else if (name === "wiki_entity") data = { entity: this.wiki.entity(args.key) };
    else if (name === "wiki_trace") data = { paths: this.wiki.trace(args.startKey, args.relationTypes || [], args.depth || 2) };
    else if (name === "ontology_neighbors") data = { neighbors: this.wiki.neighbors(args.key, args.direction || "both", args.relationTypes || []) };
    else if (name === "semantic_catalog") data = this.catalog(args.query);
    else if (name === "metric_query") data = this.metricQuery(args);
    else if (name === "compare_periods") data = this.comparePeriods(args);
    else if (name === "dimension_breakdown") data = this.dimensionBreakdown(args);
    else if (name === "submit_evidence") data = this.submitEvidence(args);
    else if (name === "validate_answer") data = this.validateAnswer(args);
    else if (name === "knowledge_validate") data = this.validateKnowledge(args);
    return { status: "ok", data, evidence: this.evidenceFor(name, data), warnings: [], scope: data.scope || {} };
  }

  catalog(query) {
    const metrics = this.semantic.findMetrics(query);
    const dimensions = this.semantic.findDimensions(query);
    return {
      metrics: metrics.map((key) => ({ key, ...this.semantic.model.metrics[key] })),
      dimensions: dimensions.map((key) => ({ key, ...this.semantic.model.dimensions[key] })),
      scope: { model: this.semantic.model.model },
    };
  }

  metricQuery(args) {
    const range = dateRange(args.range);
    const result = this.semantic.execute(this.db, { metrics: args.metrics, dimensions: args.dimensions || [], filters: args.filters || {}, startDate: range.startDate, endDate: range.endDate, timeGrain: args.timeGrain || null });
    return { rows: result.rows, metrics: result.metrics, dimensions: result.dimensions, timeGrain: result.timeGrain, scope: { range, filters: args.filters || {}, rowCount: result.rows.length } };
  }

  comparePeriods(args) {
    const currentRange = dateRange(args.currentRange);
    const baselineRange = dateRange(args.baselineRange);
    const input = (range) => this.semantic.execute(this.db, { metrics: [args.metric], dimensions: args.dimensions || [], filters: args.filters || {}, startDate: range.startDate, endDate: range.endDate });
    const current = input(currentRange).rows;
    const baseline = input(baselineRange).rows;
    const key = args.metric;
    const index = (rows) => new Map(rows.map((row) => [(args.dimensions || []).map((dimension) => row[dimension]).join("|") || "total", row]));
    const currentIndex = index(current); const baselineIndex = index(baseline);
    const rows = [...new Set([...currentIndex.keys(), ...baselineIndex.keys()])].map((group) => {
      const now = Number(currentIndex.get(group)?.[key] || 0); const previous = Number(baselineIndex.get(group)?.[key] || 0);
      return { group, current: now, baseline: previous, delta: now - previous, rate: previous === 0 ? null : (now - previous) / Math.abs(previous) };
    });
    return { metric: key, rows, scope: { currentRange, baselineRange, dimensions: args.dimensions || [], filters: args.filters || {} } };
  }

  dimensionBreakdown(args) {
    const result = this.metricQuery({ metrics: [args.metric], dimensions: [args.dimension], filters: args.filters || {}, range: args.range });
    return { ...result, rows: result.rows.sort((a, b) => Number(b[args.metric]) - Number(a[args.metric])).slice(0, args.limit || 20) };
  }

  submitEvidence(args) {
    const record = { claims: args.claims, sourceKeys: args.sourceKeys };
    this.evidence.push(record);
    return { accepted: true, record };
  }

  validateKnowledge(args) {
    const entity = args.entity || {};
    return { valid: this.ontology.validateEntity(entity).length === 0, errors: this.ontology.validateEntity(entity) };
  }

  validateAnswer(args) {
    const findings = [];
    if (!args.answer?.trim()) findings.push("答案为空");
    if (["knowledge", "definition", "data", "analysis", "discovery"].includes(args.mode) && !args.sourceKeys?.length) findings.push("缺少可公开来源");
    if (/\b(drop\s+table|insert\s+into|delete\s+from)\b/i.test(args.answer)) findings.push("答案包含危险 SQL");
    if (args.mode === "analysis" && /导致|根因就是|必然因为/.test(args.answer)) findings.push("分析答案包含未经验证的因果表达");
    return { valid: findings.length === 0, findings };
  }

  evidenceFor(name, data) {
    if (name === "wiki_search") return (data.results || []).map((item) => ({ key: item.key, path: item.path }));
    if (name === "wiki_entity") return data.entity ? [{ key: data.entity.key, path: data.entity.path }] : [];
    if (name === "wiki_trace" || name === "ontology_neighbors") return [{ key: `wiki:${name}`, path: "wiki/" }];
    if (name === "semantic_catalog" && ((data.metrics || []).length || (data.dimensions || []).length)) {
      return [{ key: "query:semantic_catalog", scope: data.scope }];
    }
    if (["metric_query", "compare_periods", "dimension_breakdown"].includes(name)) return [{ key: `query:${name}`, scope: data.scope }];
    return [];
  }
}
