export function parseScalar(raw) {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean);
  }
  return value.replace(/^['\"]|['\"]$/g, "");
}

export function parseFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return { attributes: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { attributes: {}, body: content };
  const header = content.slice(4, end).replace(/\r/g, "");
  const attributes = {};
  let activeList = null;
  for (const line of header.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list && activeList) {
      attributes[activeList].push(parseScalar(list[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (!raw) {
      attributes[key] = [];
      activeList = key;
    } else {
      attributes[key] = parseScalar(raw);
      activeList = null;
    }
  }
  return { attributes, body: content.slice(end + 5).replace(/^\r?\n/, "") };
}
