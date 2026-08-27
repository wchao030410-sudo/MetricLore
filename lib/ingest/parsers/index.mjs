import { ParserRegistry } from "../parser-registry.mjs";
import { registerCsvParser } from "./csv.mjs";
import { registerDocxParser } from "./docx.mjs";
import { registerHtmlParser } from "./html.mjs";
import { registerPdfParser } from "./pdf.mjs";
import { registerTextParsers } from "./text.mjs";
import { registerXlsxParser } from "./xlsx.mjs";

export function defaultParsers() {
  const registry = new ParserRegistry();
  registerTextParsers(registry);
  registerCsvParser(registry);
  registerHtmlParser(registry);
  registerPdfParser(registry);
  registerDocxParser(registry);
  registerXlsxParser(registry);
  return registry;
}

export { ParserRegistry };
export { parseCsv } from "./csv.mjs";
export { extractPdfText } from "./pdf.mjs";
export { parseDocx } from "./docx.mjs";
export { parseXlsx } from "./xlsx.mjs";
export { sectionsFromHtml } from "./html.mjs";
