import { parse } from "node-html-parser";

const DROP_TAGS = new Set(["script", "style", "noscript", "iframe", "svg", "object", "embed", "link", "meta", "template", "head", "form", "button", "input", "select", "textarea"]);
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "li", "ul", "ol", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "br", "pre", "blockquote", "dt", "dd", "header", "footer", "main", "aside"]);

function sanitize(root) {
  for (const el of root.querySelectorAll([...DROP_TAGS].join(","))) {
    if (el && el.parentNode) el.remove();
  }
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Object.keys(el.attributes || {})) {
      const name = attr.toLowerCase();
      if (name.startsWith("on") || name === "style" || (["src", "href", "action", "xlink:href"].includes(name) && name !== "href")) {
        el.removeAttribute(attr);
      }
    }
  }
  return root;
}

function blockText(node) {
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    const type = n.nodeType;
    if (type === 3) { parts.push(n.rawText ?? n.text ?? ""); return; }
    if (type !== 1) return;
    const tag = (n.tagName || "").toLowerCase();
    if (tag === "br") { parts.push("\n"); return; }
    for (const child of n.childNodes || []) walk(child);
    if (BLOCK_TAGS.has(tag)) parts.push("\n");
  };
  walk(node);
  return parts.join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function sectionsFromHtml(html) {
  const root = sanitize(parse(html));
  const segments = [];
  let current = null;
  const flush = () => { if (current && current.text.trim()) segments.push(current); current = null; };

  for (const node of root.childNodes || []) {
    if (node.nodeType !== 1) continue;
    const tag = (node.tagName || "").toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      flush();
      current = { text: "", locator: { section: blockText(node) } };
    } else if (current) {
      current.text += blockText(node) + "\n";
    } else {
      const text = blockText(node);
      if (text.trim()) segments.push({ text, locator: {} });
    }
  }
  flush();
  return {
    segments,
    text: segments.map((segment) => segment.text).join("\n\n"),
    title: root.querySelector("title")?.text?.trim() || null,
  };
}

export function htmlParser() {
  return {
    id: "html",
    extensions: ["html", "htm"],
    mediaTypes: ["text/html", "application/xhtml+xml"],
    parse(input) {
      const html = input.buffer.toString("utf8");
      const { text, segments, title } = sectionsFromHtml(html);
      return { text, segments, hints: [], locatorCapabilities: ["section"], metadata: { title } };
    },
  };
}

export function registerHtmlParser(registry) {
  registry.register(htmlParser());
  return registry;
}
