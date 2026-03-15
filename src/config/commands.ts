// 本文件用于解析与“命令”相关的配置设置，特别是针对不同渠道提供商
//（如 Discord、Slack 等）的“原生命令”和“原生技能”。
// 它根据配置的层级（提供商特定设置 > 全局设置 > 平台默认值）来决定这些功能是否启用。

import { normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.js";
import { isPlainObject } from "../infra/plain-object.js";
import type { CommandsConfig, NativeCommandsSetting } from "./types.js";

/**
 * 一个映射类型，用于从 `CommandsConfig` 中提取值为布尔类型的键。
 * 这创建了一种类型安全的方式来引用像 `restart` 这样的命令标志。
 */
export type CommandFlagKey = {
  [K in keyof CommandsConfig]-?: Exclude<CommandsConfig[K], undefined> extends boolean ? K : never;
}[keyof CommandsConfig];

/**
 * 根据提供商 ID 解析“自动”默认值。
 * 某些平台（如 Discord）默认启用原生命令，而其他平台则默认禁用。
 * @param providerId 渠道提供商的 ID。
 * @returns 如果该平台默认启用，则为 `true`。
 */
function resolveAutoDefault(providerId?: ChannelId): boolean {
  const id = normalizeChannelId(providerId);
  if (!id) {
    return false;
  }
  if (id === "discord" || id === "telegram") {
    return true; // Discord 和 Telegram 默认启用
  }
  if (id === "slack") {
    return false; // Slack 默认禁用
  }
  return false;
}

/**
 * 解析原生技能（native skills）是否为给定提供商启用。
 * 这是 `resolveNativeCommandSetting` 的别名。
 */
export function resolveNativeSkillsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  return resolveNativeCommandSetting(params);
}

/**
 * 解析原生命令（native commands）是否为给定提供商启用。
 * 这是 `resolveNativeCommandSetting` 的别名。
 */
export function resolveNativeCommandsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  return resolveNativeCommandSetting(params);
}

/**
 * 解析原生命令设置的核心逻辑。
 * 它遵循以下优先级顺序来确定最终的设置：
 * 1. `providerSetting` (提供商特定设置，例如 `config.channels.slack.commands.native`)
 * 2. `globalSetting` (全局设置, 例如 `config.commands.native`)
 * 3. `resolveAutoDefault(providerId)` (对应平台的默认值)
 * @returns 如果原生命令应被启用，则为 `true`。
 */
function resolveNativeCommandSetting(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  const { providerId, providerSetting, globalSetting } = params;
  // 如果 providerSetting 未定义，则使用 globalSetting
  const setting = providerSetting === undefined ? globalSetting : providerSetting;
  if (setting === true) {
    return true;
  }
  if (setting === false) {
    return false;
  }
  // 如果设置为 "auto" 或未定义，则使用平台默认值
  return resolveAutoDefault(providerId);
}

/**
 * 检查原生命令是否在提供商或全局级别被明确禁用（设置为 `false`）。
 * @returns 如果被明确禁用，则为 `true`。
 */
export function isNativeCommandsExplicitlyDisabled(params: {
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  const { providerSetting, globalSetting } = params;
  // 提供商级别明确禁用
  if (providerSetting === false) {
    return true;
  }
  // 如果提供商级别未设置，检查全局级别
  if (providerSetting === undefined) {
    return globalSetting === false;
  }
  return false;
}

/**
 * 从配置对象中安全地获取特定命令标志的值。
 * @param config 可能包含 `commands` 字段的配置对象。
 * @param key 要获取的命令标志的键。
 * @returns 标志的值，如果不存在则为 `undefined`。
 */
function getOwnCommandFlagValue(
  config: { commands?: unknown } | undefined,
  key: CommandFlagKey,
): unknown {
  const { commands } = config ?? {};
  if (!isPlainObject(commands) || !Object.hasOwn(commands, key)) {
    return undefined;
  }
  return commands[key];
}

/**
 * 检查特定的命令标志是否被设置为 `true`。
 * @param config 配置对象。
 * @param key 要检查的命令标志。
 * @returns 如果标志值为 `true`，则返回 `true`。
 */
export function isCommandFlagEnabled(
  config: { commands?: unknown } | undefined,
  key: CommandFlagKey,
): boolean {
  return getOwnCommandFlagValue(config, key) === true;
}

/**
 * 检查 `restart` 命令是否启用。
 * 默认情况下是启用的，除非明确设置为 `false`。
 * @param config 配置对象。
 * @returns 如果 `restart` 命令未被禁用，则为 `true`。
 */
export function isRestartEnabled(config?: { commands?: unknown }): boolean {
  return getOwnCommandFlagValue(config, "restart") !== false;
}
