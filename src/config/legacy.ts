// 本文件是旧版（legacy）配置处理系统的中央协调器。
// 它有两个主要职责：
// 1. 在配置对象中“发现”不推荐使用的旧版键或结构。
// 2. 应用“迁移”规则来修复它们，即将旧结构转换为新结构。

import { LEGACY_CONFIG_MIGRATIONS } from "./legacy.migrations.js";
import { LEGACY_CONFIG_RULES } from "./legacy.rules.js";
import type { LegacyConfigIssue } from "./types.js";

/**
 * 一个简单的工具函数，用于通过路径数组（例如 `['gateway', 'token']`）从对象中获取嵌套值。
 */
function getPathValue(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * 在配置对象中查找所有旧版配置问题。
 * 这是一个“检测器”，它只发现问题，不进行修改。
 * @param raw - 已解析的配置对象。
 * @param sourceRaw - （可选）从磁盘直接读取的、未经任何处理的原始配置对象。
 * @returns 一个 `LegacyConfigIssue` 数组，描述了所有发现的问题。
 */
export function findLegacyConfigIssues(raw: unknown, sourceRaw?: unknown): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const root = raw as Record<string, unknown>;
  const sourceRoot =
    sourceRaw && typeof sourceRaw === "object" ? (sourceRaw as Record<string, unknown>) : root;
  const issues: LegacyConfigIssue[] = [];

  // 遍历所有预定义的旧版配置规则
  for (const rule of LEGACY_CONFIG_RULES) {
    const cursor = getPathValue(root, rule.path);
    // 如果路径存在，并且满足可选的 `match` 条件
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      // `requireSourceLiteral` 是一个重要的检查。
      // 它确保只有当旧版键存在于原始源文件中时，规则才会被触发。
      // 这可以防止因为其他默认值填充逻辑引入了某个键而导致的误报。
      if (rule.requireSourceLiteral) {
        const sourceCursor = getPathValue(sourceRoot, rule.path);
        if (sourceCursor === undefined || (rule.match && !rule.match(sourceCursor, sourceRoot))) {
          continue;
        }
      }
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}

/**
 * 应用所有旧版配置迁移规则来更新配置对象。
 * 这是一个“执行器”，它会实际修改配置。
 * @param raw 原始配置对象。
 * @returns 返回一个对象，包含：
 *   - `next`: 修改后的新配置对象；如果没有进行任何更改，则为 `null`。
 *   - `changes`: 一个描述所做更改的字符串数组。
 */
export function applyLegacyMigrations(raw: unknown): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { next: null, changes: [] };
  }
  // 创建一个深克隆，以避免修改原始输入对象。
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];

  // 遍历并应用所有迁移函数
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }

  if (changes.length === 0) {
    // 如果没有应用任何更改，则表示无需迁移。
    return { next: null, changes: [] };
  }
  return { next, changes };
}
