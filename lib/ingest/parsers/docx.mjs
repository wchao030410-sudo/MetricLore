import mammoth from "mammoth";

import { sectionsFromHtml } from "./html.mjs";

export async function parseDocx(buffer) {
  const result = await mammoth.convertToHtml({ buffer }, { includeDefaultStyleMap: true });
  const html = result.value;
  const { text, segments, title } = sectionsFromHtml(html);
  return { text, segments, title, messages: result.messages.map((message) => message.message) };
}

export function docxParser() {
  return {
    id: "docx",
    extensions: ["docx"],
    mediaTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    async parse(input) {
      const { text, segments, title } = await parseDocx(input.buffer);
      return { text, segments, hints: [], locatorCapabilities: ["section"], metadata: { title } };
    },
  };
}

export function registerDocxParser(registry) {
  registry.register(docxParser());
  return registry;
}
