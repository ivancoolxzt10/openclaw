// 本文件是一个索引文件，用于组合所有旧版配置的“迁移（migration）”函数。
//
// 它从多个“部分”文件（`part-1`, `part-2`, `part-3`）中导入迁移规则数组，
// 然后将它们合并成一个单一的、有序的 `LEGACY_CONFIG_MIGRATIONS` 数组。
//
// 将迁移规则拆分成多个部分的目的，很可能是为了控制它们的执行顺序。
// 某些迁移可能需要先于其他迁移运行，以避免冲突或确保正确性。
// 例如，你可能需要先将一个顶层键（如 `discord: {}`）移动到其新位置
// （如 `channels: { discord: {} }`），然后另一个迁移才能去修改
// `channels.discord` 内部的某个键。
//
// 这个文件就是组装器，它创建了将由 `legacy.ts` 执行的最终、完整的迁移列表。

import { LEGACY_CONFIG_MIGRATIONS_PART_1 } from "./legacy.migrations.part-1.js";
import { LEGACY_CONFIG_MIGRATIONS_PART_2 } from "./legacy.migrations.part-2.js";
import { LEGACY_CONFIG_MIGRATIONS_PART_3 } from "./legacy.migrations.part-3.js";

/**
 * 一个包含了所有旧版配置迁移规则的、有序的数组。
 */
export const LEGACY_CONFIG_MIGRATIONS = [
  ...LEGACY_CONFIG_MIGRATIONS_PART_1,
  ...LEGACY_CONFIG_MIGRATIONS_PART_2,
  ...LEGACY_CONFIG_MIGRATIONS_PART_3,
];
