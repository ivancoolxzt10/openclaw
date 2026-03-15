// 本文件实现了一个复杂的、分层的“群组策略（Group Policy）”系统。
// 该系统主要用于控制在一个渠道（Channel）内的特定群组（Group）中，
// 机器人应该如何行为。它主要控制两件事：
// 1. `requireMention`: 机器人是否需要被明确提及（@）才会响应。
// 2. `tools` 和 `toolsBySender`: 允许在该群组或由特定发件人使用的工具集。
//
// 策略的解析遵循一个明确的层级，从最具体到最通用：
// 账户级群组配置 > 渠道级群组配置 > 账户级策略模式 > 渠道级策略模式。
// 在工具策略内部，也存在层级：按发件人策略 > 按群组策略。

import type { ChannelId } from "../channels/plugins/types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import {
  parseToolsBySenderTypedKey,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ToolsBySenderKeyType,
} from "./types.tools.js";

export type GroupPolicyChannel = ChannelId;

/**
 * 定义一个渠道内群组的配置结构。
 */
export type ChannelGroupConfig = {
  requireMention?: boolean; // 是否需要提及
  tools?: GroupToolPolicyConfig; // 该群组的工具策略
  toolsBySender?: GroupToolPolicyBySenderConfig; // 按发件人区分的更精细的工具策略
};

/**
 * 定义解析后的渠道群组策略的结果。
 */
export type ChannelGroupPolicy = {
  allowlistEnabled: boolean; // 是否启用了白名单模式
  allowed: boolean; // 当前交互是否被允许
  groupConfig?: ChannelGroupConfig; // 匹配到的特定群组的配置
  defaultConfig?: ChannelGroupConfig; // 通配符“*”群组的配置
};

type ChannelGroups = Record<string, ChannelGroupConfig>;

/**
 * 从群组配置中解析特定 groupId 的配置。
 */
function resolveChannelGroupConfig(
  groups: ChannelGroups | undefined,
  groupId: string,
  caseInsensitive = false, // 是否不区分大小写匹配
): ChannelGroupConfig | undefined {
  if (!groups) return undefined;
  // 直接匹配
  const direct = groups[groupId];
  if (direct) return direct;
  // 不区分大小写匹配
  if (!caseInsensitive) return undefined;
  const target = groupId.toLowerCase();
  const matchedKey = Object.keys(groups).find((key) => key !== "*" && key.toLowerCase() === target);
  return matchedKey ? groups[matchedKey] : undefined;
}

export type GroupToolPolicySender = {
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

// --- “按发件人工具策略 (toolsBySender)” 的复杂逻辑 ---
// 这部分是为了实现非常精细的权限控制，即同一个群组里的不同用户可以使用不同的工具。

type SenderKeyType = "id" | "e164" | "username" | "name";

/**
 * “已编译”的发件人策略。这是一个优化，避免在每次请求时都重新解析配置。
 * 它将配置按发件人标识符的类型（id, e164 等）分桶存储。
 */
type CompiledSenderPolicy = {
  buckets: SenderPolicyBuckets;
  wildcard?: GroupToolPolicyConfig;
};

const warnedLegacyToolsBySenderKeys = new Set<string>();
// 使用 WeakMap 缓存已编译的策略，键是配置对象本身。
const compiledToolsBySenderCache = new WeakMap<
  GroupToolPolicyBySenderConfig,
  CompiledSenderPolicy
>();

type ParsedSenderPolicyKey =
  | { kind: "wildcard" }
  | { kind: "typed"; type: SenderKeyType; key: string };

type SenderPolicyBuckets = Record<ToolsBySenderKeyType, Map<string, GroupToolPolicyConfig>>;

/**
 * 规范化发件人标识符（去除空格、转小写、处理@符号）。
 */
function normalizeSenderKey(value: string, options: { stripLeadingAt?: boolean } = {}): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutAt = options.stripLeadingAt && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}

function normalizeTypedSenderKey(value: string, type: SenderKeyType): string {
  return normalizeSenderKey(value, { stripLeadingAt: type === "username" });
}

function normalizeLegacySenderKey(value: string): string {
  return normalizeSenderKey(value, { stripLeadingAt: true });
}

/**
 * 对使用旧版（无前缀）toolsBySender 键的用户发出弃用警告。
 */
function warnLegacyToolsBySenderKey(rawKey: string) {
  const trimmed = rawKey.trim();
  if (!trimmed || warnedLegacyToolsBySenderKeys.has(trimmed)) return;
  warnedLegacyToolsBySenderKeys.add(trimmed);
  process.emitWarning(
    `toolsBySender 的键 "${trimmed}" 已被弃用。请使用明确的前缀 (id:, e164:, username:, name:)。旧的无前缀键现在只作为 id 匹配。`,
    { type: "DeprecationWarning", code: "OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY" },
  );
}

/**
 * 解析 `toolsBySender` 配置中的单个键。
 */
function parseSenderPolicyKey(rawKey: string): ParsedSenderPolicyKey | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) return undefined;
  if (trimmed === "*") return { kind: "wildcard" };

  // 尝试解析带前缀的键，例如 "id:U12345"
  const typed = parseToolsBySenderTypedKey(trimmed);
  if (typed) {
    const key = normalizeTypedSenderKey(typed.value, typed.type);
    if (!key) return undefined;
    return { kind: "typed", type: typed.type, key };
  }

  // 向后兼容的后备方案：无前缀的键现在仅映射到不可变的 sender ID。
  warnLegacyToolsBySenderKey(trimmed);
  const key = normalizeLegacySenderKey(trimmed);
  if (!key) return undefined;
  return { kind: "typed", type: "id", key };
}

/**
 * 创建用于存储策略的空桶。
 */
function createSenderPolicyBuckets(): SenderPolicyBuckets {
  return {
    id: new Map(),
    e164: new Map(),
    username: new Map(),
    name: new Map(),
  };
}

/**
 * 编译 `toolsBySender` 策略。
 * 将配置解析并放入不同的桶中，以加快后续的查找速度。
 */
function compileToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) return undefined;

  const buckets = createSenderPolicyBuckets();
  let wildcard: GroupToolPolicyConfig | undefined;
  for (const [rawKey, policy] of entries) {
    if (!policy) continue;
    const parsed = parseSenderPolicyKey(rawKey);
    if (!parsed) continue;
    if (parsed.kind === "wildcard") {
      wildcard = policy;
      continue;
    }
    const bucket = buckets[parsed.type];
    if (!bucket.has(parsed.key)) {
      bucket.set(parsed.key, policy);
    }
  }
  return { buckets, wildcard };
}

/**
 * 获取（或编译并缓存）`toolsBySender` 策略。
 */
function resolveCompiledToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const cached = compiledToolsBySenderCache.get(toolsBySender);
  if (cached) return cached;
  const compiled = compileToolsBySenderPolicy(toolsBySender);
  if (!compiled) return undefined;
  // 配置只加载一次且被视为不可变；因此可以按对象标识缓存已编译的策略。
  compiledToolsBySenderCache.set(toolsBySender, compiled);
  return compiled;
}

function normalizeCandidate(value: string | null | undefined, type: SenderKeyType): string {
  const trimmed = value?.trim();
  return trimmed ? normalizeTypedSenderKey(trimmed, type) : "";
}

function normalizeSenderIdCandidates(value: string | null | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const typed = normalizeTypedSenderKey(trimmed, "id");
  const legacy = normalizeLegacySenderKey(trimmed);
  if (!typed) return legacy ? [legacy] : [];
  return !legacy || legacy === typed ? [typed] : [typed, legacy];
}

/**
 * 在已编译的策略中匹配发件人信息。
 * 查找顺序: id -> e164 -> username -> name -> wildcard
 */
function matchToolsBySenderPolicy(
  compiled: CompiledSenderPolicy,
  params: GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  for (const senderIdCandidate of normalizeSenderIdCandidates(params.senderId)) {
    const match = compiled.buckets.id.get(senderIdCandidate);
    if (match) return match;
  }
  const senderE164 = normalizeCandidate(params.senderE164, "e164");
  if (senderE164) {
    const match = compiled.buckets.e164.get(senderE164);
    if (match) return match;
  }
  const senderUsername = normalizeCandidate(params.senderUsername, "username");
  if (senderUsername) {
    const match = compiled.buckets.username.get(senderUsername);
    if (match) return match;
  }
  const senderName = normalizeCandidate(params.senderName, "name");
  if (senderName) {
    const match = compiled.buckets.name.get(senderName);
    if (match) return match;
  }
  return compiled.wildcard;
}

/**
 * 解析给定发件人的工具策略。
 */
export function resolveToolsBySender(
  params: { toolsBySender?: GroupToolPolicyBySenderConfig } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const { toolsBySender } = params;
  if (!toolsBySender) return undefined;
  const compiled = resolveCompiledToolsBySenderPolicy(toolsBySender);
  return compiled ? matchToolsBySenderPolicy(compiled, params) : undefined;
}

// --- 主要解析逻辑 ---

/**
 * 解析给定渠道和账户的群组配置（`groups` 字段）。
 * 它会优先使用账户级别的配置。
 */
function resolveChannelGroups(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): ChannelGroups | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as | { accounts?: Record<string, { groups?: ChannelGroups }>; groups?: ChannelGroups } | undefined;
  if (!channelConfig) return undefined;
  const accountGroups = resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groups;
  return accountGroups ?? channelConfig.groups;
}

type ChannelGroupPolicyMode = "open" | "allowlist" | "disabled";

/**
 * 解析群组策略的模式（`groupPolicy` 字段）。
 */
function resolveChannelGroupPolicyMode(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): ChannelGroupPolicyMode | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as | { groupPolicy?: ChannelGroupPolicyMode; accounts?: Record<string, { groupPolicy?: ChannelGroupPolicyMode }> } | undefined;
  if (!channelConfig) return undefined;
  const accountPolicy = resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groupPolicy;
  return accountPolicy ?? channelConfig.groupPolicy;
}

/**
 * 解析给定渠道和群组的最终策略。
 * 这是检查群组交互是否被允许的主要入口点。
 */
export function resolveChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  hasGroupAllowFrom?: boolean; // 当上游配置了发件人级别的过滤时为 true
}): ChannelGroupPolicy {
  const { cfg, channel } = params;
  const groups = resolveChannelGroups(cfg, channel, params.accountId);
  const groupPolicy = resolveChannelGroupPolicyMode(cfg, channel, params.accountId);
  const hasGroups = Boolean(groups && Object.keys(groups).length > 0);
  
  // 白名单模式在 `groupPolicy` 为 "allowlist" 或定义了任何 `groups` 时启用。
  const allowlistEnabled = groupPolicy === "allowlist" || hasGroups;
  const normalizedId = params.groupId?.trim();
  const groupConfig = normalizedId ? resolveChannelGroupConfig(groups, normalizedId, params.groupIdCaseInsensitive) : undefined;
  const defaultConfig = groups?.["*"];
  const allowAll = allowlistEnabled && Boolean(groups && Object.hasOwn(groups, "*"));

  const senderFilterBypass = groupPolicy === "allowlist" && !hasGroups && Boolean(params.hasGroupAllowFrom);
  
  // 决定是否“允许”
  const allowed =
    groupPolicy === "disabled"
      ? false
      : !allowlistEnabled || allowAll || Boolean(groupConfig) || senderFilterBypass;
      
  return { allowlistEnabled, allowed, groupConfig, defaultConfig };
}

/**
 * 解析在群组中是否需要提及机器人。
 */
export function resolveChannelGroupRequireMention(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  requireMentionOverride?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean {
  const { requireMentionOverride, overrideOrder = "after-config" } = params;
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
  
  // 查找顺序：特定群组配置 -> 通配符群组配置
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultConfig?.requireMention === "boolean"
        ? defaultConfig.requireMention
        : undefined;

  if (overrideOrder === "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  if (typeof configMention === "boolean") {
    return configMention;
  }
  if (overrideOrder !== "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  
  // 最终默认值为 true
  return true;
}

/**
 * 解析给定群组和发件人的最终生效的工具策略。
 * 查找顺序:
 * 1. 特定群组的 `toolsBySender`
 * 2. 特定群组的 `tools`
 * 3. 通配符群组的 `toolsBySender`
 * 4. 通配符群组的 `tools`
 */
export function resolveChannelGroupToolsPolicy(
  params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
  
  const groupSenderPolicy = resolveToolsBySender({
    toolsBySender: groupConfig?.toolsBySender,
    ...params,
  });
  if (groupSenderPolicy) return groupSenderPolicy;
  if (groupConfig?.tools) return groupConfig.tools;

  const defaultSenderPolicy = resolveToolsBySender({
    toolsBySender: defaultConfig?.toolsBySender,
    ...params,
  });
  if (defaultSenderPolicy) return defaultSenderPolicy;
  if (defaultConfig?.tools) return defaultConfig.tools;

  return undefined;
}
