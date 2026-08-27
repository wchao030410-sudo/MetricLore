const ENTITY_TYPES = ["BusinessDomain", "BusinessProcess", "Metric", "Dimension", "DataAsset", "DataField", "BusinessRule", "Dashboard", "Source"];

function parseJsonResponse(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  return JSON.parse(cleaned);
}

/**
 * OpenAI-compatible 抽取适配器。密钥未配置时返回空，不发起请求。
 * fetchFn 可注入用于测试；返回的候选与规则抽取使用相同的草稿结构。
 */
export function createLlmExtractor({ fetchFn = fetch, baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1", apiKey = process.env.LLM_API_KEY, model = process.env.LLM_MODEL } = {}) {
  const enabled = Boolean(apiKey && model);

  async function extract({ parseResult, fileId, relativePath }) {
    if (!enabled) return [];
    const text = (parseResult.text || "").slice(0, 20000);
    if (!text.trim()) return [];
    const system = `你是知识抽取助手。从文档中抽取业务实体（类型限 ${ENTITY_TYPES.join("/")}），只输出 JSON 数组，元素字段：key（小写 kebab-case 或 null）、type、title、definition、aliases（字符串数组）、relations（对象）。没有把握的实体不要输出；不要编造。`;
    const response = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: `文件：${relativePath}\n\n${text}` }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`模型抽取失败 (${response.status})`);
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content;
    if (!content) return [];
    const items = parseJsonResponse(content);
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => ({
        entityKey: item.key || null,
        entityType: ENTITY_TYPES.includes(item.type) ? item.type : null,
        title: item.title || null,
        definition: item.definition || null,
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        relations: item.relations && typeof item.relations === "object" ? item.relations : {},
        sources: [{ fileId, path: relativePath, locator: {} }],
        extraction: { mode: "llm_assisted", method: "llm", confidence: 0.6, rules: ["llm"] },
      }))
      .filter((item) => item.title);
  }

  return { enabled, extract };
}
