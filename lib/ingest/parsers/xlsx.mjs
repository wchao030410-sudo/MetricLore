import readXlsxFile from "read-excel-file/node";

export async function parseXlsx(buffer) {
  const sheets = await readXlsxFile(buffer);
  return sheets.map(({ sheet, data }) => ({ sheet, rows: data }));
}

export function xlsxParser() {
  return {
    id: "xlsx",
    extensions: ["xlsx"],
    mediaTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    async parse(input) {
      const sheets = await parseXlsx(input.buffer);
      const segments = [];
      const hints = [];
      for (const { sheet, rows } of sheets) {
        const header = (rows[0] || []).map((cell) => String(cell ?? "").trim());
        const dataRows = rows.slice(1).map((cells) => {
          const record = {};
          header.forEach((name, index) => { record[name] = cells[index] == null ? "" : String(cells[index]).trim(); });
          return record;
        });
        segments.push({ text: [header.join(", "), ...dataRows.map((record) => header.map((name) => `${name}: ${record[name] ?? ""}`).join("；"))].join("\n"), locator: { sheet, startRow: 1, endRow: rows.length } });
        hints.push({ kind: "tabular", format: "xlsx", sheet, header, rows: dataRows, locator: { sheet, startRow: 2, endRow: rows.length } });
      }
      const text = segments.map((segment) => segment.text).join("\n\n");
      return { text, segments, hints, locatorCapabilities: ["sheet", "row"], metadata: { sheets: sheets.map((sheet) => sheet.sheet) } };
    },
  };
}

export function registerXlsxParser(registry) {
  registry.register(xlsxParser());
  return registry;
}
