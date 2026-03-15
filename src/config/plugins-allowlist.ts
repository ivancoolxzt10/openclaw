// 这是一个非常小而简单的实用工具文件。
// 它的唯一目的就是确保一个给定的 `pluginId` 存在于配置的 `plugins.allow` 列表中。

import type { OpenClawConfig } from "./config.js";

/**
 * 确保一个插件ID存在于 `plugins.allow` 白名单中。
 * @param cfg OpenClaw 配置对象。
 * @param pluginId 要确保存在的插件 ID。
 * @returns 如果需要，返回一个已更新 `allow` 列表的新配置对象；否则返回原始配置对象。
 */
export function ensurePluginAllowlisted(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  const allow = cfg.plugins?.allow;

  // 1. 检查 `plugins.allow` 是否是一个数组。
  //    如果它不是一个数组（例如，未定义），这意味着没有白名单限制，
  //    所有插件都被隐式允许，因此无需做任何事。
  // 2. 检查 `pluginId` 是否已经存在于 `allow` 数组中。
  //    如果已存在，也无需做任何事。
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }

  // 只有当 `allow` 列表存在且 `pluginId` 不在其中时，才执行操作：
  // 创建一个新的配置对象，并将 `pluginId` 添加到 `allow` 数组中。
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}
