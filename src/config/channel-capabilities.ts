// 本文件用于解析特定渠道（channel）和账户（account）的“能力（capabilities）”。
// “能力”似乎是一个功能或权限的列表（表示为字符串数组），可以在不同级别上进行配置
// （例如，在渠道级别全局配置，或为渠道内的特定账户配置）。
// 该模块实现了能力的层级查找：账户级别的配置会覆盖渠道级别的配置。

import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { SlackCapabilitiesConfig } from "./types.slack.js";
import type { TelegramCapabilitiesConfig } from "./types.telegram.js";

/**
 * 能力配置的联合类型，可以是 Telegram 或 Slack 的特定配置。
 */
type CapabilitiesConfig = TelegramCapabilitiesConfig | SlackCapabilitiesConfig;

/**
 * 类型保护函数，检查一个未知值是否为字符串数组。
 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * 规范化“能力”配置。
 * 它接收一个能力配置，并将其清理为格式统一的字符串数组。
 * 它会修剪每个条目的空格并移除空条目。
 * 注意：此函数会有意忽略对象格式的能力（例如 `{ inlineButtons: "dm" }`），
 * 因为这些由特定渠道的处理器（如 `resolveTelegramInlineButtonsScope`）单独处理。
 * @param capabilities 原始的能力配置。
 * @returns 清理和过滤后的字符串数组，如果输入无效或为空，则返回 `undefined`。
 */
function normalizeCapabilities(capabilities: CapabilitiesConfig | undefined): string[] | undefined {
  if (!isStringArray(capabilities)) {
    return undefined;
  }
  const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 解析给定账户的能力。
 * 它在渠道配置中查找特定账户的配置，如果找到则使用该账户的特定能力，
 * 否则回退到渠道级别的能力。
 * @param params 包含配置和账户ID的对象。
 *   - `cfg`: 渠道级别的配置，可能包含 `accounts` 字段。
 *   - `accountId`: 要查找的账户ID。
 * @returns 一个能力字符串数组，或 `undefined`。
 */
function resolveAccountCapabilities(params: {
  cfg?: { accounts?: Record<string, { capabilities?: CapabilitiesConfig }> } & {
    capabilities?: CapabilitiesConfig;
  };
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(params.accountId);

  const accounts = cfg.accounts;
  if (accounts && typeof accounts === "object") {
    // 在 `accounts`对象中查找与`accountId`匹配的条目。
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    if (match) {
      // 如果找到匹配项，则优先使用该账户的能力。
      // 如果账户特定能力无效，则回退到渠道级别的能力。
      return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
    }
  }

  // 如果没有找到匹配的账户，则使用渠道级别的能力。
  return normalizeCapabilities(cfg.capabilities);
}

/**
 * 解析给定渠道和账户的最终生效的能力列表。
 * 这是本模块导出的主要函数。
 * @param params 包含全局配置、渠道ID和账户ID的对象。
 *   - `cfg`: OpenClaw 的全局配置对象。
 *   - `channel`: 渠道的ID。
 *   - `accountId`: 账户的ID。
 * @returns 一个最终生效的能力字符串数组，或 `undefined`。
 */
export function resolveChannelCapabilities(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  const channel = normalizeChannelId(params.channel);
  if (!cfg || !channel) {
    return undefined;
  }

  // 从全局配置中找到特定渠道的配置块。
  const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = (channelsConfig?.[channel] ?? (cfg as Record<string, unknown>)[channel]) as
    | {
        accounts?: Record<string, { capabilities?: CapabilitiesConfig }>;
        capabilities?: CapabilitiesConfig;
      }
    | undefined;

  // 使用渠道配置和账户ID来解析最终的能力。
  return resolveAccountCapabilities({
    cfg: channelConfig,
    accountId: params.accountId,
  });
}
