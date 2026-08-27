function boundaryOf(contentType) {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  return (match?.[1] || match?.[2] || "").trim();
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.toString("utf8").split("\r\n")) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    headers[name] = value;
  }
  return headers;
}

function dispositionField(disposition, field) {
  const match = new RegExp(`(?:^|;)\\s*${field}=(?:"([^"]*)"|([^;]*))`, "i").exec(disposition || "");
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/**
 * 解析 multipart/form-data 请求体（不落地流式，直接对缓冲区分段）。
 * 返回 { fields: {name: value}, files: [{ fieldName, filename, mediaType, buffer }] }。
 */
export function parseMultipart(buffer, contentType) {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error("multipart 缺少 boundary");
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let offset = body.indexOf(delimiter);
  if (offset < 0) throw new Error("multipart 格式错误");

  const closing = `${delimiter.toString("latin1")}--`;
  while (offset >= 0) {
    // 结束标记 "--boundary--"
    if (body.slice(offset, offset + closing.length).toString("latin1") === closing) break;

    offset += delimiter.length;
    if (body.slice(offset, offset + 2).toString("latin1") === "\r\n") offset += 2;
    else if (body[offset] === 0x0a) offset += 1;

    const headerEnd = body.indexOf("\r\n\r\n", offset);
    if (headerEnd < 0) break;
    const headers = parseHeaders(body.slice(offset, headerEnd));
    offset = headerEnd + 4;

    const nextDelimiter = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), offset);
    if (nextDelimiter < 0) break;
    const part = body.slice(offset, nextDelimiter);
    offset = nextDelimiter + 2; // 指向下一个 boundary 的 "--"

    const disposition = headers["content-disposition"] || "";
    const name = dispositionField(disposition, "name");
    const filename = dispositionField(disposition, "filename");
    if (filename) {
      files.push({ fieldName: name, filename, mediaType: headers["content-type"] || "application/octet-stream", buffer: part });
    } else {
      fields[name] = part.toString("utf8");
    }
  }
  return { fields, files };
}
