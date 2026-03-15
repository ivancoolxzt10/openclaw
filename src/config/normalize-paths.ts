// 本文件是一个“规范化器”，专门用于处理配置中的路径字符串。
// 它的主要目的是找到那些看起来像文件路径的配置值，并将其中代表用户主目录的 `~` 符号
// 扩展为其完整的、绝对的路径。

import { isPlainObject, resolveUserPath } from "../utils.js";
import type { OpenClawConfig } from "./types.js";

// 正则表达式，用于匹配以 `~/` 或 `~\` 开头的字符串。
const PATH_VALUE_RE = /^~(?=$|[\\/])/;

// 正则表达式，用于匹配以 `dir`, `path`, `paths`, `file`, `root`, `workspace` 结尾的键名。
// 这是一种启发式方法，用于猜测一个键是否可能包含路径值。
const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
// 一个明确的集合，包含已知是路径列表的键名。
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

/**
 * 规范化单个字符串值。
 * @param key 与此值关联的键名。
 * @param value 要规范化的字符串值。
 * @returns 规范化后的字符串，或者原始字符串。
 */
function normalizeStringValue(key: string | undefined, value: string): string {
  // 检查 1: 值的格式是否以 `~` 开头。如果不是，则无需处理。
  if (!PATH_VALUE_RE.test(value.trim())) {
    return value;
  }
  if (!key) {
    return value;
  }
  // 检查 2: 键的名称是否像一个路径键。
  if (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key)) {
    // 只有当值和键都符合条件时，才进行路径扩展。
    // 这可以防止意外地扩展一个实际上并非文件路径的值。
    return resolveUserPath(value);
  }
  return value;
}

/**
 * 一个递归函数，用于遍历整个配置对象并规范化路径。
 * 它会直接修改传入的对象/数组。
 * @param key 当前值的键名。
 * @param value 当前正在处理的值。
 * @returns 规范化后的值。
 */
function normalizeAny(key: string | undefined, value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeStringValue(key, value);
  }

  if (Array.isArray(value)) {
    // 如果键名是已知的路径列表键，则递归地规范化数组内的字符串元素。
    const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
    return value.map((entry) => {
      if (typeof entry === "string") {
        return normalizeChildren ? normalizeStringValue(key, entry) : entry;
      }
      if (isPlainObject(entry) || Array.isArray(entry)) {
        return normalizeAny(undefined, entry);
      }
      return entry;
    });
  }

  if (!isPlainObject(value)) {
    return value;
  }

  // 对于对象，遍历其所有键值对并递归调用。
  for (const [childKey, childValue] of Object.entries(value)) {
    const next = normalizeAny(childKey, childValue);
    if (next !== childValue) {
      value[childKey] = next;
    }
  }

  return value;
}

/**
 * 在配置对象中规范化所有类似路径的字段中的 "~" 符号。
 * 这是本模块导出的主函数。
 * @param cfg 要规范化的 OpenClaw 配置对象。
 * @returns 经过规范化处理的配置对象。
 */
export function normalizeConfigPaths(cfg: OpenClawConfig): OpenClawConfig {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  // 从根配置对象开始递归规范化。
  normalizeAny(undefined, cfg);
  return cfg;
}
