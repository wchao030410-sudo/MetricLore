import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ROOT } from "../config.mjs";

/**
 * 原始上传文件存储：服务器生成 fileId 作为实际存储名，逻辑路径保留在数据库。
 * 默认目录 data/uploads，不进入 Git。
 */
export class UploadStore {
  constructor(dir = resolve(ROOT, "data/uploads")) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  path(jobId, fileId) {
    return resolve(this.dir, jobId, fileId);
  }

  write(jobId, fileId, buffer) {
    const path = this.path(jobId, fileId);
    mkdirSync(resolve(this.dir, jobId), { recursive: true });
    writeFileSync(path, buffer);
    return path;
  }

  read(jobId, fileId) {
    const path = this.path(jobId, fileId);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  remove(jobId, fileId) {
    const path = this.path(jobId, fileId);
    if (existsSync(path)) rmSync(path, { force: true });
  }
}
