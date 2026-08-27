/**
 * RFC 4180 CSV 解析器，处理引号字段、内嵌逗号与换行。
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else { field += char; }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      field += char;
    }
    i += 1;
  }
  if (field.length || row.length) pushRow();
  return rows.filter((row) => row.some((cell) => cell.trim() !== ""));
}

export function csvParser() {
  return {
    id: "csv",
    extensions: ["csv", "tsv"],
    mediaTypes: ["text/csv", "text/tab-separated-values"],
    parse(input) {
      const text = input.buffer.toString("utf8");
      const rows = parseCsv(text);
      const header = rows[0] || [];
      const dataRows = rows.slice(1);
      const records = dataRows.map((cells) => {
        const record = {};
        header.forEach((name, index) => { record[name.trim()] = (cells[index] ?? "").trim(); });
        return record;
      });
      const segments = records.length
        ? [{ text: [header.join(", "), ...records.map((record) => header.map((name) => `${name}: ${record[name] ?? ""}`).join("；"))].join("\n"), locator: { sheet: "csv", startRow: 1, endRow: rows.length } }]
        : [];
      const hints = records.length ? [{ kind: "tabular", format: "csv", header: header.map((h) => h.trim()), rows: records, locator: { sheet: "csv", startRow: 2, endRow: rows.length } }] : [];
      return { text, segments, hints, locatorCapabilities: ["row"], metadata: { header } };
    },
  };
}

export function registerCsvParser(registry) {
  registry.register(csvParser());
  return registry;
}
