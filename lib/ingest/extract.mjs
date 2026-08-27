const NAME_KEYS = ["name", "title", "名称", "指标", "指标名", "字段", "字段名", "column", "metric", "entity", "概念", "术语", "对象"];
const DEFINITION_KEYS = ["definition", "description", "desc", "定义", "描述", "说明", "口径", "释义", "计算公式", "formula", "计算方式", "含义"];
const ALIAS_KEYS = ["alias", "aliases", "别名", "同义词", "synonyms"];
const TYPE_KEYS = ["type", "entity_type", "实体类型", "entitytype", "种类", "类别"];
const KEY_KEYS = ["key", "entity_key", "code", "编码", "标识", "id"];

const TYPE_TOKENS = {
  Metric: ["metric", "指标", "度量"],
  Dimension: ["dimension", "维度"],
  DataField: ["field", "字段", "column", "列"],
  BusinessProcess: ["process", "过程"],
  BusinessRule: ["rule", "规则", "口径"],
  BusinessDomain: ["domain", "域"],
  DataAsset: ["asset", "table", "表", "资产", "数据集"],
  Dashboard: ["dashboard", "看板"],
  Source: ["source", "来源"],
};

export function slugify(value) {
  if (!value) return null;
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || null;
}

function normalizeType(value) {
  if (!value) return null;
  const raw = String(value).trim();
  for (const [type, tokens] of Object.entries(TYPE_TOKENS)) {
    if (tokens.some((token) => raw.toLowerCase() === token)) return type;
  }
  const title = raw.toLowerCase();
  const byName = Object.keys(TYPE_TOKENS).find((type) => type.toLowerCase() === title || `${type.toLowerCase()}s` === title);
  return byName || null;
}

function pick(row, keys) {
  const lower = new Map(Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase(), value]));
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
    const direct = lower.get(key.toLowerCase());
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") return String(direct).trim();
  }
  return null;
}

function splitList(value) {
  if (value === null || value === undefined) return [];
  return String(value).split(/[,;，；、]/).map((item) => item.trim()).filter(Boolean);
}

function inferTypeFromHeader(header) {
  const joined = header.map((h) => h.toLowerCase()).join(" ");
  for (const [type, tokens] of Object.entries(TYPE_TOKENS)) {
    if (tokens.some((token) => joined.includes(token))) return type;
  }
  return null;
}

function fromEntityHint(hint, fileId, relativePath) {
  const entity = hint.entity || {};
  return [{
    entityKey: entity.key || null,
    entityType: normalizeType(entity.type) || entity.type || null,
    title: entity.title || null,
    definition: entity.definition || null,
    aliases: entity.aliases || [],
    relations: entity.relations || {},
    sources: [{ fileId, path: relativePath, locator: hint.locator || {} }],
    extraction: { mode: "rules", method: "frontmatter", confidence: 1, rules: ["frontmatter-entity"], entityStatus: entity.status || null },
  }];
}

function fromTabular(hint, fileId, relativePath) {
  const { header = [], rows = [], locator = {}, sheet } = hint;
  const inferred = inferTypeFromHeader(header);
  return rows.map((row, index) => {
    const title = pick(row, NAME_KEYS);
    if (!title) return null;
    const type = normalizeType(pick(row, TYPE_KEYS)) || inferred;
    const definition = pick(row, DEFINITION_KEYS);
    const aliases = splitList(pick(row, ALIAS_KEYS));
    const key = pick(row, KEY_KEYS);
    return {
      entityKey: key || slugify(title),
      entityType: type,
      title,
      definition,
      aliases,
      relations: {},
      sources: [{ fileId, path: relativePath, locator: { ...locator, sheet, row: (locator.startRow || 2) + index } }],
      extraction: { mode: "rules", method: "data-dictionary", confidence: type ? 0.7 : 0.4, rules: ["tabular-row"] },
    };
  }).filter(Boolean);
}

function fromSqlTable(hint, fileId, relativePath) {
  const drafts = [];
  const tableKey = slugify(hint.table) ? `asset-${slugify(hint.table)}` : null;
  const fieldKeys = hint.columns.map((column) => slugify(column.name) ? `field-${slugify(hint.table)}-${slugify(column.name)}` : null);
  drafts.push({
    entityKey: tableKey,
    entityType: "DataAsset",
    title: hint.table,
    definition: `SQL 数据表 ${hint.table}`,
    aliases: [],
    relations: { contains: fieldKeys.filter(Boolean) },
    sources: [{ fileId, path: relativePath, locator: hint.locator }],
    extraction: { mode: "rules", method: "sql-create-table", confidence: 0.8, rules: ["sql-table"] },
  });
  hint.columns.forEach((column, index) => {
    drafts.push({
      entityKey: fieldKeys[index],
      entityType: "DataField",
      title: column.name,
      definition: `${hint.table}.${column.name}${column.type ? ` · ${column.type}` : ""}`,
      aliases: [],
      relations: {},
      sources: [{ fileId, path: relativePath, locator: hint.locator }],
      extraction: { mode: "rules", method: "sql-column", confidence: 0.8, rules: ["sql-column"] },
    });
  });
  return drafts;
}

const TERM_DEF = /^(?:[*_`]{1,3})?([^\n：:]{2,40}?)(?:[*_`]{1,3})?\s*[：:]\s*(\S[\s\S]{0,200}?)$/gm;

function fromTextSegments(segments, fileId, relativePath) {
  const drafts = [];
  for (const segment of segments || []) {
    for (const match of String(segment.text || "").matchAll(TERM_DEF)) {
      const term = match[1].trim();
      const definition = match[2].trim();
      if (!term || !definition) continue;
      const type = normalizeType(term) || normalizeType(definition) || inferTypeFromHeader([term, definition]);
      if (!type) continue;
      drafts.push({
        entityKey: slugify(term),
        entityType: type,
        title: term,
        definition,
        aliases: [],
        relations: {},
        sources: [{ fileId, path: relativePath, locator: segment.locator || {} }],
        extraction: { mode: "rules", method: "term-definition", confidence: 0.4, rules: ["term-definition"] },
      });
    }
  }
  return drafts;
}

export function extractRules(parseResult, { fileId, relativePath }) {
  const drafts = [];
  for (const hint of parseResult.hints || []) {
    if (hint.kind === "entity") drafts.push(...fromEntityHint(hint, fileId, relativePath));
    else if (hint.kind === "tabular") drafts.push(...fromTabular(hint, fileId, relativePath));
    else if (hint.kind === "sql_table") drafts.push(...fromSqlTable(hint, fileId, relativePath));
  }
  // 术语:定义 启发式只用于无结构化提示的纯文本格式，避免污染表格/SQL 抽取。
  if (!(parseResult.hints || []).length) drafts.push(...fromTextSegments(parseResult.segments, fileId, relativePath));
  return drafts;
}
