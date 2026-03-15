// 本文件提供了将旧版（legacy）配置文件迁移到新格式的主要入口点。
// 它负责协调整个迁移过程，并确保迁移后的配置是有效的。

import { applyLegacyMigrations } from "./legacy.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

/**
 * 迁移一个旧版配置对象。
 * @param raw 从旧版配置文件中读取的、未经处理的原始对象。
 * @returns 返回一个对象，包含：
 *   - `config`: 迁移并验证成功后的新配置对象；如果迁移或验证失败，则为 `null`。
 *   - `changes`: 一个描述迁移过程中所做更改的字符串数组（例如 "已将 'gateway.token' 移动到 'gateway.auth.token'"）。
 */
export function migrateLegacyConfig(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  // 1. 应用所有迁移规则，转换配置结构。
  const { next, changes } = applyLegacyMigrations(raw);
  if (!next) {
    // 如果迁移过程没有返回任何结果，则直接失败。
    return { config: null, changes: [] };
  }

  // 2. 验证迁移后的配置。
  // 这是一个关键步骤，确保自动迁移的结果符合当前的配置规范。
  const validated = validateConfigObjectWithPlugins(next);
  if (!validated.ok) {
    // 如果验证失败，告知用户需要手动修复剩余问题。
    changes.push("迁移已应用，但配置仍然无效；请手动修复剩余问题。");
    return { config: null, changes };
  }

  // 3. 如果验证成功，返回最终的、有效的配置和所做的更改列表。
  return { config: validated.config, changes };
}
