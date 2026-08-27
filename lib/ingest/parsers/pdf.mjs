import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPdfText(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await getDocument({
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ").replace(/\s{2,}/g, " ").trim();
    if (text) pages.push({ page: number, text });
    page.cleanup?.();
  }
  try { doc.destroy?.(); } catch { /* 释放由垃圾回收接管 */ }
  return pages;
}

export function pdfParser() {
  return {
    id: "pdf",
    extensions: ["pdf"],
    mediaTypes: ["application/pdf"],
    async parse(input) {
      const pages = await extractPdfText(input.buffer);
      return {
        text: pages.map((page) => page.text).join("\n\n"),
        segments: pages.map((page) => ({ text: page.text, locator: { page: page.page, startLine: 1, endLine: page.text.split("\n").length } })),
        hints: [],
        locatorCapabilities: ["page"],
        metadata: { pages: pages.length },
      };
    },
  };
}

export function registerPdfParser(registry) {
  registry.register(pdfParser());
  return registry;
}
