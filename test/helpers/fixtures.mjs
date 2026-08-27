import JSZip from "jszip";

export const mdEntity = (overrides = {}) => `---
key: ${overrides.key || "metric-gmv"}
type: ${overrides.type || "Metric"}
title: ${overrides.title || "成交总额"}
status: ${overrides.status || "verified"}
aliases: [${(overrides.aliases || ["GMV", "销售额"]).join(", ")}]
relations: [${(overrides.relations || ["measures:process-ordering"]).join(", ")}]
sources: [dict.md]
---

成交总额是支付成功订单的含税收入，计算为 SUM(revenue)。
`;

export const csvDict = () => "name,definition,type,aliases\n客单价,收入除以订单量,Metric,平均订单金额\n转化率,订单量除以访客数,Metric,CVR\n";

export const sqlDdl = () => "CREATE TABLE daily_metrics (\n  revenue REAL,\n  orders INTEGER\n);\n";

export const htmlDoc = () => `<html><head><title>指标词典</title><script>alert(1)</script></head><body><h1>收入</h1><p>支付成功订单的含税收入。</p></body></html>`;

export const txtDoc = () => "这是第一行。\n这是第二行。\n";

export function makeDocx(blocks = [{ heading: "收入口径" }, { paragraph: "收入是支付成功订单的含税收入。" }]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = blocks.map((block) => {
    if (block.heading) return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${block.heading}</w:t></w:r></w:p>`;
    return `<w:p><w:r><w:t>${block.paragraph || ""}</w:t></w:r></w:p>`;
  }).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

export function makeXlsx(rows = [["name", "definition"], ["客单价", "收入除以订单量"]]) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  const colName = (index) => String.fromCharCode(65 + index);
  const sheet = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => `<c r="${colName(colIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

export function makePdf(lines = ["Hello", "Metrics"]) {
  const header = "%PDF-1.4\n";
  const objects = [];
  const content = "BT /F1 24 Tf 100 700 Td (" + lines.join(" ") + ") Tj ET";
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n");
  objects.push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  objects.push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  let out = header;
  const offsets = [];
  for (const obj of objects) { offsets.push(out.length); out += obj; }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

export function makeZip(entries = { "a.md": mdEntity(), "b.csv": csvDict() }) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: "nodebuffer" });
}
