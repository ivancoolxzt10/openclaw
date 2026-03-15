// 本文件包含用于确定和评估“会话重置（Session Reset）”策略的所有逻辑。
// 会话重置是一种机制，用于在对话长时间不活动或到达每日指定时间后，
// 自动开始一个新的对话上下文。这对于管理 token 使用和保持对话的相关性至关重要。

import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { SessionConfig, SessionResetConfig } from "../types.base.js";
import { DEFAULT_IDLE_MINUTES } from "./types.js";

/**
 * 会话重置的模式。
 * - `daily`: 每天在指定的小时重置。
 * - `idle`: 在一段时间不活动后重置。
 */
export type SessionResetMode = "daily" | "idle";
/**
 * 会话的类型，不同的类型可以有不同的重置策略。
 */
export type SessionResetType = "direct" | "group" | "thread";

/**
 * 描述一个已解析的、完整的会话重置策略。
 */
export type SessionResetPolicy = {
  mode: SessionResetMode;
  atHour: number; // 当 mode 为 'daily' 时，在哪个小时重置 (0-23)
  idleMinutes?: number; // 当 mode 为 'idle' 时，在多少分钟不活动后重置
};

/**
 * 描述一个会话的“新鲜度”状态。
 */
export type SessionFreshness = {
  fresh: boolean; // 会话是否“新鲜”（即，不需要重置）
  dailyResetAt?: number; // 计算出的上一个每日重置时间点（毫秒时间戳）
  idleExpiresAt?: number; // 计算出的闲置过期时间点（毫秒时间戳）
};

// 默认的重置策略值
export const DEFAULT_RESET_MODE: SessionResetMode = "daily";
export const DEFAULT_RESET_AT_HOUR = 4; // 默认在凌晨4点重置

const THREAD_SESSION_MARKERS = [":thread:", ":topic:"];
const GROUP_SESSION_MARKERS = [":group:", ":channel:"];

/**
 * 检查一个会话密钥是否表示一个“话题（thread）”会话。
 */
export function isThreadSessionKey(sessionKey?: string | null): boolean {
  const normalized = (sessionKey ?? "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return THREAD_SESSION_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * 根据上下文线索，解析出当前会话的重置类型（`direct`, `group`, 或 `thread`）。
 * 这对于应用正确的重置策略至关重要。
 */
export function resolveSessionResetType(params: {
  sessionKey?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType {
  if (params.isThread || isThreadSessionKey(params.sessionKey)) {
    return "thread";
  }
  if (params.isGroup) {
    return "group";
  }
  const normalized = (params.sessionKey ?? "").toLowerCase();
  if (GROUP_SESSION_MARKERS.some((marker) => normalized.includes(marker))) {
    return "group";
  }
  return "direct";
}

/**
 * 一个更全面的检查，用于判断当前上下文是否属于一个话题（thread）。
 */
export function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean {
  if (params.messageThreadId != null) {
    return true;
  }
  if (params.threadLabel?.trim()) {
    return true;
  }
  if (params.threadStarterBody?.trim()) {
    return true;
  }
  if (params.parentSessionKey?.trim()) {
    return true;
  }
  return isThreadSessionKey(params.sessionKey);
}

/**
 * 计算上一个“每日重置”时间点。
 * @param now - 当前时间的时间戳。
 * @param atHour - 在哪个小时重置。
 * @returns 上一个重置点的毫秒时间戳。
 */
export function resolveDailyResetAtMs(now: number, atHour: number): number {
  const normalizedAtHour = normalizeResetAtHour(atHour);
  const resetAt = new Date(now);
  resetAt.setHours(normalizedAtHour, 0, 0, 0);
  // 如果当前时间还没到今天的重置时间，那么上一个重置点应该是在昨天。
  if (now < resetAt.getTime()) {
    resetAt.setDate(resetAt.getDate() - 1);
  }
  return resetAt.getTime();
}

/**
 * 【核心】解析最终生效的会话重置策略。
 * 这是一个分层解析过程，优先级从高到低：
 * 1. `resetOverride` (最高优先级，通常用于测试或运行时覆盖)
 * 2. `sessionCfg.resetByType` (按类型 'direct'/'group'/'thread' 的特定配置)
 * 3. `sessionCfg.reset` (全局的基本重置配置)
 * 4. `sessionCfg.idleMinutes` (为了向后兼容的旧版闲置设置)
 * 5. `DEFAULT_RESET_MODE` 和 `DEFAULT_RESET_AT_HOUR` (硬编码的最终默认值)
 */
export function resolveSessionResetPolicy(params: {
  sessionCfg?: SessionConfig;
  resetType: SessionResetType;
  resetOverride?: SessionResetConfig;
}): SessionResetPolicy {
  const sessionCfg = params.sessionCfg;
  const baseReset = params.resetOverride ?? sessionCfg?.reset;
  // 向后兼容：接受旧的 "dm" 键作为 "direct" 的别名
  const typeReset = params.resetOverride
    ? undefined
    : (sessionCfg?.resetByType?.[params.resetType] ??
      (params.resetType === "direct"
        ? (sessionCfg?.resetByType as { dm?: SessionResetConfig } | undefined)?.dm
        : undefined));
  const hasExplicitReset = Boolean(baseReset || sessionCfg?.resetByType);
  const legacyIdleMinutes = params.resetOverride ? undefined : sessionCfg?.idleMinutes;
  
  const mode =
    typeReset?.mode ??
    baseReset?.mode ??
    (!hasExplicitReset && legacyIdleMinutes != null ? "idle" : DEFAULT_RESET_MODE);
  
  const atHour = normalizeResetAtHour(
    typeReset?.atHour ?? baseReset?.atHour ?? DEFAULT_RESET_AT_HOUR,
  );
  
  const idleMinutesRaw = typeReset?.idleMinutes ?? baseReset?.idleMinutes ?? legacyIdleMinutes;

  let idleMinutes: number | undefined;
  if (idleMinutesRaw != null) {
    const normalized = Math.floor(idleMinutesRaw);
    if (Number.isFinite(normalized)) {
      idleMinutes = Math.max(normalized, 1);
    }
  } else if (mode === "idle") {
    // 如果模式是 'idle' 但没有提供分钟数，则使用默认值
    idleMinutes = DEFAULT_IDLE_MINUTES;
  }

  return { mode, atHour, idleMinutes };
}

/**
 * 解析特定于渠道的重置配置覆盖。
 */
export function resolveChannelResetConfig(params: {
  sessionCfg?: SessionConfig;
  channel?: string | null;
}): SessionResetConfig | undefined {
  const resetByChannel = params.sessionCfg?.resetByChannel;
  if (!resetByChannel) {
    return undefined;
  }
  const normalized = normalizeMessageChannel(params.channel);
  const fallback = params.channel?.trim().toLowerCase();
  const key = normalized ?? fallback;
  if (!key) {
    return undefined;
  }
  return resetByChannel[key] ?? resetByChannel[key.toLowerCase()];
}

/**
 * 【核心】评估一个会话的新鲜度。
 * @param params - 包含会话最后更新时间、当前时间和已解析的重置策略。
 * @returns 一个 `SessionFreshness` 对象，其中的 `fresh` 字段指示会话是否需要重置。
 */
export function evaluateSessionFreshness(params: {
  updatedAt: number;
  now: number;
  policy: SessionResetPolicy;
}): SessionFreshness {
  // 计算每日重置时间点
  const dailyResetAt =
    params.policy.mode === "daily"
      ? resolveDailyResetAtMs(params.now, params.policy.atHour)
      : undefined;
  // 计算闲置过期时间点
  const idleExpiresAt =
    params.policy.idleMinutes != null
      ? params.updatedAt + params.policy.idleMinutes * 60_000
      : undefined;
  // 判断是否已“过期”
  const staleDaily = dailyResetAt != null && params.updatedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;
  return {
    fresh: !(staleDaily || staleIdle),
    dailyResetAt,
    idleExpiresAt,
  };
}

/**
 * 规范化“重置小时”的值，确保它在 0-23 之间。
 */
function normalizeResetAtHour(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RESET_AT_HOUR;
  }
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized)) {
    return DEFAULT_RESET_AT_HOUR;
  }
  if (normalized < 0) {
    return 0;
  }
  if (normalized > 23) {
    return 23;
  }
  return normalized;
}
