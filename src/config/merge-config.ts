// 本文件提供了用于合并配置对象的通用和特定辅助函数。
// 当需要更新配置时（例如，从 Web UI 或命令行应用更改），这是一个常见的任务。

import type { OpenClawConfig } from "./config.js";
import type { WhatsAppConfig } from "./types.js";

/**
 * 合并函数的选项类型。
 */
export type MergeSectionOptions<T> = {
  /**
   * 一个键的数组。如果 `patch` 对象中某个键的值是 `undefined`，
   * 并且该键包含在这个数组中，那么这个键将从基础对象中被 *删除*。
   * 这提供了一种明确“取消设置”某个配置值的方法。
   */
  unsetOnUndefined?: Array<keyof T>;
};

/**
 * 一个通用的函数，用于将一个“补丁（patch）”对象合并到一个“基础（base）”对象中。
 * @param base 基础对象，可以为 undefined。
 * @param patch 包含更改的补丁对象。
 * @param options 合并选项。
 * @returns 合并后的新对象。
 */
export function mergeConfigSection<T extends Record<string, unknown>>(
  base: T | undefined,
  patch: Partial<T>,
  options: MergeSectionOptions<T> = {},
): T {
  // 1. 创建基础对象的浅拷贝，如果基础对象不存在，则从空对象开始。
  const next: Record<string, unknown> = { ...(base ?? undefined) };
  
  // 2. 遍历补丁对象中的所有条目。
  for (const [key, value] of Object.entries(patch) as [keyof T, T[keyof T]][]) {
    // 3. 处理值为 undefined 的情况
    if (value === undefined) {
      // 如果键在 `unsetOnUndefined` 列表中，则从结果中删除该键。
      if (options.unsetOnUndefined?.includes(key)) {
        delete next[key as string];
      }
      // 否则，什么也不做（保留 `base` 中的原始值）。
      continue;
    }
    // 4. 如果值不是 undefined，则在结果中设置或覆盖该键。
    next[key as string] = value as unknown;
  }
  return next as T;
}

/**
 * 一个特定的工具函数，使用 `mergeConfigSection` 来仅更新主配置对象中的 `whatsapp` 部分。
 * 它为这个常见操作提供了一种方便且类型安全的方式。
 * @param cfg 完整的 OpenClaw 配置对象。
 * @param patch 应用于 `whatsapp` 部分的补丁。
 * @param options 合并选项。
 * @returns 一个包含了已更新 `whatsapp` 配置的新 `OpenClawConfig` 对象。
 */
export function mergeWhatsAppConfig(
  cfg: OpenClawConfig,
  patch: Partial<WhatsAppConfig>,
  options?: MergeSectionOptions<WhatsAppConfig>,
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options),
    },
  };
}
