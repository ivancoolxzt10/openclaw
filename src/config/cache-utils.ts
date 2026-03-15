// 本文件提供了与缓存相关的实用工具函数。
// 主要功能包括解析缓存的生存时间（TTL）以及获取文件状态快照，
// 用于判断缓存是否有效或文件是否已更改。

import fs from "node:fs";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

/**
 * 解析缓存的生存时间（TTL），单位为毫秒。
 * 这个函数会首先尝试从环境变量中获取 TTL 值，如果环境变量无效或未设置，
 * 则回退到使用一个默认值。
 * @param params 包含环境变量值和默认 TTL 的对象。
 *   - `envValue`: 从环境变量中读取的字符串值。
 *   - `defaultTtlMs`: 默认的 TTL（毫秒）。
 * @returns 解析后的 TTL 值（毫秒）。
 */
export function resolveCacheTtlMs(params: {
  envValue: string | undefined;
  defaultTtlMs: number;
}): number {
  const { envValue, defaultTtlMs } = params;
  if (envValue) {
    // 尝试将环境变量值解析为严格的非负整数。
    const parsed = parseStrictNonNegativeInteger(envValue);
    if (parsed !== undefined) {
      // 如果解析成功，返回解析后的值。
      return parsed;
    }
  }
  // 如果环境变量无效或未提供，返回默认值。
  return defaultTtlMs;
}

/**
 * 检查缓存是否已启用。
 * 缓存被认为是启用的，如果其 TTL 大于 0。
 * @param ttlMs 缓存的 TTL（毫秒）。
 * @returns 如果缓存启用，则为 `true`。
 */
export function isCacheEnabled(ttlMs: number): boolean {
  return ttlMs > 0;
}

/**
 * 定义文件状态的快照类型。
 * 主要用于存储文件的修改时间和大小，以便后续比较。
 */
export type FileStatSnapshot = {
  /**
   * 文件的最后修改时间，以毫秒为单位的时间戳。
   */
  mtimeMs: number;
  /**
   * 文件的字节大小。
   */
  sizeBytes: number;
};

/**
 * 获取指定文件路径的文件状态快照。
 * 如果文件不存在或无法访问，则返回 `undefined`。
 * @param filePath 要获取状态的文件的路径。
 * @returns 一个 `FileStatSnapshot` 对象，或在出错时返回 `undefined`。
 */
export function getFileStatSnapshot(filePath: string): FileStatSnapshot | undefined {
  try {
    // 同步获取文件状态。
    const stats = fs.statSync(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
    };
  } catch {
    // 如果 `fs.statSync` 失败（例如，文件不存在），则捕获错误并返回 undefined。
    return undefined;
  }
}
