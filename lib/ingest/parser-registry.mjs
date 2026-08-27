/**
 * Parser 契约：
 *   parse(input) -> Promise<ParseResult>
 *   input = { buffer: Buffer, extension, mediaType, relativePath }
 *   ParseResult = {
 *     text: string,                          // 全文（用于兜底与检索）
 *     segments: [{ text, locator }],         // 带来源定位的分段，供 chunker 使用
 *     hints: [ ... ],                        // 可选结构化抽取提示，供规则抽取器使用
 *     locatorCapabilities: string[],         // 该格式支持的定位维度
 *     metadata?: object                      // 标题、工作表名等附加信息
 *   }
 */
export class ParserRegistry {
  constructor() {
    this.parsers = [];
  }

  register(parser) {
    if (!parser || !parser.id || typeof parser.parse !== "function") throw new Error("Parser 必须提供 id 和 parse 方法");
    this.parsers.push(parser);
    return this;
  }

  find(input) {
    const extension = (input.extension || "").toLowerCase();
    const mediaType = (input.mediaType || "").toLowerCase();
    return (
      this.parsers.find((parser) => parser.extensions.includes(extension)) ||
      this.parsers.find((parser) => parser.mediaTypes.includes(mediaType))
    );
  }

  supports(input) {
    return Boolean(this.find(input));
  }

  async parse(input) {
    const parser = this.find(input);
    if (!parser) {
      throw new Error(`不支持的文件类型: ${input.extension || input.mediaType || "unknown"}`);
    }
    return parser.parse(input);
  }
}
