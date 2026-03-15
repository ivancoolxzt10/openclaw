// 本文件用于解析在不同渠道中应如何渲染 Markdown 表格的配置。
// 由于某些聊天客户端不完全支持原生 Markdown 表格，此模块允许配置不同的
// “模式”来优雅地处理它们（例如，将表格转换为项目符号列表）。

import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { MarkdownTableMode } from "./types.base.js";

// 定义一个可能包含 Markdown 配置的条目类型。
type MarkdownConfigEntry = {
  markdown?: {
    tables?: MarkdownTableMode; // 表格渲染模式
  };
};

// 定义一个 Markdown 配置节的类型，它可以包含针对不同账户的特定配置。
type MarkdownConfigSection = MarkdownConfigEntry & {
  accounts?: Record<string, MarkdownConfigEntry>;
};

/**
 * 一个 Map，定义了特定渠道的默认表格渲染模式。
 * 例如，Signal 和 WhatsApp 不支持表格，因此默认转换为项目符号列表 (`"bullets"`)。
 * Mattermost 默认关闭表格渲染 (`"off"`)。
 * 其他所有渠道则默认将表格放入代码块 (`"code"`) 中渲染。
 */
export const DEFAULT_TABLE_MODES = new Map<string, MarkdownTableMode>([
  ["signal", "bullets"],
  ["whatsapp", "bullets"],
  ["mattermost", "off"],
]);

/**
 * 类型保护函数，检查一个值是否是有效的 `MarkdownTableMode`。
 */
const isMarkdownTableMode = (value: unknown): value is MarkdownTableMode =>
  value === "off" || value === "bullets" || value === "code";

/**
 * 在一个配置节（例如特定渠道的配置）内，根据账户ID解析 Markdown 模式。
 * 这是一个分层查找：优先使用账户特定配置，如果不存在，则回退到渠道级别配置。
 * @param section - 渠道的配置节。
 * @param accountId - 用户的账户ID。
 * @returns 解析出的 `MarkdownTableMode`，如果都未配置，则返回 `undefined`。
 */
function resolveMarkdownModeFromSection(
  section: MarkdownConfigSection | undefined,
  accountId?: string | null,
): MarkdownTableMode | undefined {
  if (!section) return undefined;

  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = section.accounts;
  if (accounts && typeof accounts === "object") {
    // 1. 检查特定账户的配置
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    const matchMode = match?.markdown?.tables;
    if (isMarkdownTableMode(matchMode)) {
      return matchMode;
    }
  }

  // 2. 如果没有账户特定配置，则回退到渠道级别的配置
  const sectionMode = section.markdown?.tables;
  return isMarkdownTableMode(sectionMode) ? sectionMode : undefined;
}

/**
 * 解析最终生效的 Markdown 表格渲染模式。
 * 这是本模块导出的主要函数。
 * @param params - 包含配置、渠道ID和账户ID的对象。
 * @returns 最终生效的 `MarkdownTableMode`。
 */
export function resolveMarkdownTableMode(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): MarkdownTableMode {
  const channel = normalizeChannelId(params.channel);
  // 1. 确定该渠道的平台特定默认模式
  const defaultMode = channel ? (DEFAULT_TABLE_MODES.get(channel) ?? "code") : "code";
  if (!channel || !params.cfg) {
    return defaultMode;
  }

  // 2. 找到该渠道的配置节
  const channelsConfig = params.cfg.channels as Record<string, unknown> | undefined;
  const section = (channelsConfig?.[channel] ??
    (params.cfg as Record<string, unknown> | undefined)?.[channel]) as
    | MarkdownConfigSection
    | undefined;

  // 3. 在该配置节内进行分层查找，如果找到则使用，否则返回第1步确定的默认模式
  return resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
}
