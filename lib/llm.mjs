export function llmEnabled() {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

export async function generateGroundedAnswer({ question, evidence, data }) {
  if (!llmEnabled()) return null;
  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "你是数据分析助手。只能使用给出的知识证据和查询结果；证据不足时明确说明。不要编造指标、原因或业务事实。回答简洁，引用来源路径。",
        },
        { role: "user", content: JSON.stringify({ question, evidence, data }) },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`模型请求失败 (${response.status})`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content?.trim() || null;
}
