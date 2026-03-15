// 本文件实现了一个对配置应用“运行时覆盖（runtime overrides）”的系统。
// 这些“覆盖”是在配置加载过程的最后阶段，在内存中应用的更改。
// 它们的优先级最高，会覆盖 `openclaw.json` 文件中的所有设置，但它们不会被持久化到磁盘。
//
// **使用场景**:
// 这很可能用于临时的、动态的配置更改，例如通过命令行标志（如 `--set gateway.port=9000`）、
// 调试命令或仅用于单次运行的环境变量来应用的设置。

import { isPlainObject } from "../utils.js";
import { parseConfigPath, setConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import type { OpenClawConfig } from "./types.js";

type OverrideTree = Record<string, unknown>;

/**
 * 一个全局的、内存中的记录，用于存储所有覆盖值。
 */
let overrides: OverrideTree = {};

/**
 * 一个安全函数，在将值放入 `overrides` 对象之前对其进行清理。
 * 它会递归地遍历值，移除所有 `undefined` 属性，并剥离任何被阻止的键（如 `__proto__`），
 * 以防止原型链污染漏洞。它还能处理循环引用。
 */
function sanitizeOverrideValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOverrideValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (seen.has(value)) return {}; // 处理循环引用
  seen.add(value);

  const sanitized: OverrideTree = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    sanitized[key] = sanitizeOverrideValue(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}

/**
 * 一个递归函数，用于将 `overrides` 对象深度合并到基础配置对象上。
 * 在 `overrides` 中的属性会覆盖 `base` 中的同名属性。
 */
function mergeOverrides(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const next: OverrideTree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    next[key] = mergeOverrides((base as OverrideTree)[key], value);
  }
  return next;
}

/**
 * 获取当前的覆盖对象。
 */
export function getConfigOverrides(): OverrideTree {
  return overrides;
}

/**
 * 清空所有覆盖值，可能用于测试或重置状态。
 */
export function resetConfigOverrides(): void {
  overrides = {};
}

/**
 * 公共函数，用于添加一个覆盖项。
 * @param pathRaw 点分表示法的路径。
 * @param value 要设置的值。
 */
export function setConfigOverride(
  pathRaw: string,
  value: unknown,
): { ok: boolean; error?: string } {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok || !parsed.path) {
    return { ok: false, error: parsed.error ?? "路径无效。" };
  }
  // 在存入前，对值进行安全清理
  setConfigValueAtPath(overrides, parsed.path, sanitizeOverrideValue(value));
  return { ok: true };
}

/**
 * 公共函数，用于移除一个覆盖项。
 * @param pathRaw 点分表示法的路径。
 */
export function unsetConfigOverride(pathRaw: string): {
  ok: boolean;
  removed: boolean;
  error?: string;
} {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok || !parsed.path) {
    return { ok: false, removed: false, error: parsed.error ?? "路径无效。" };
  }
  const removed = unsetConfigValueAtPath(overrides, parsed.path);
  return { ok: true, removed };
}

/**
 * 应用运行时覆盖。
 * 这是配置加载流程的最后一步，它将 `overrides` 对象合并到已加载的配置之上。
 * @param cfg 已加载并规范化的配置对象。
 * @returns 应用了覆盖后的最终生效配置。
 */
export function applyConfigOverrides(cfg: OpenClawConfig): OpenClawConfig {
  if (!overrides || Object.keys(overrides).length === 0) {
    return cfg;
  }
  return mergeOverrides(cfg, overrides) as OpenClawConfig;
}
