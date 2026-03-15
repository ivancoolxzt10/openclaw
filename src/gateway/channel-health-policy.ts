// 本文件定义了用于评估渠道（channel）连接“健康状况”的策略和核心逻辑。
// 它接收一个渠道状态的快照（snapshot），并根据一系列规则来判断该渠道是否
// 处于健康状态，如果不是，则给出原因。

import type { ChannelId } from "../channels/plugins/types.js";

/**
 * 描述一个渠道在某个时间点的状态快照。
 * 这是进行健康评估所需的所有输入数据。
 */
export type ChannelHealthSnapshot = {
  running?: boolean;      // 渠道是否正在运行
  connected?: boolean;    // 是否已连接
  enabled?: boolean;      // 是否在配置中启用
  configured?: boolean;   // 是否已配置
  restartPending?: boolean; // 是否正在等待重启
  busy?: boolean;         // 是否正忙于处理任务
  activeRuns?: number;    // 当前活动的运行数量
  lastRunActivityAt?: number | null; // 上次运行活动的时间戳
  lastEventAt?: number | null;       // 收到最后一个事件的时间戳
  lastStartAt?: number | null;       // 上次启动的时间戳
  reconnectAttempts?: number;    // 重连尝试次数
  mode?: string;             // 渠道的运行模式 (例如 "webhook")
};

/**
 * 健康评估得出的具体原因。
 */
export type ChannelHealthEvaluationReason =
  | "healthy"                 // 健康
  | "unmanaged"               // 未被管理（例如，在配置中被禁用）
  | "not-running"             // 未运行
  | "busy"                    // 正忙（被视为健康）
  | "stuck"                   // 卡住（长时间处于忙碌状态但无活动）
  | "startup-connect-grace"   // 处于启动后的连接宽限期内
  | "disconnected"            // 已断开连接
  | "stale-socket";           // “过时的套接字”（已连接但长时间未收到事件）

/**
 * 健康评估的结果。
 */
export type ChannelHealthEvaluation = {
  healthy: boolean; // 是否健康
  reason: ChannelHealthEvaluationReason; // 原因
};

/**
 * 用于评估健康状况的策略和上下文。
 */
export type ChannelHealthPolicy = {
  channelId: ChannelId;
  now: number; // 当前时间戳
  staleEventThresholdMs: number; // “过时事件”的阈值
  channelConnectGraceMs: number; // 渠道连接的宽限期
};

/**
 * 根据评估结果得出的、更简洁的重启原因。
 */
export type ChannelRestartReason =
  | "gave-up"         // 已放弃（重连次数过多）
  | "stopped"         // 已停止
  | "stale-socket"    // 过时的套接字
  | "stuck"           // 卡住
  | "disconnected";   // 已断开连接

/**
 * 检查一个账户是否被“管理”。
 * 如果一个渠道账户在配置中被禁用或未配置，它就被视为“未被管理”，健康监视器会忽略它。
 */
function isManagedAccount(snapshot: ChannelHealthSnapshot): boolean {
  return snapshot.enabled !== false && snapshot.configured !== false;
}

const BUSY_ACTIVITY_STALE_THRESHOLD_MS = 25 * 60_000; // 25分钟
// ... 默认的时间阈值常量 ...
export const DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS = 30 * 60_000; // 30分钟
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120_000; // 2分钟

/**
 * 【核心评估函数】根据快照和策略，评估一个渠道的健康状况。
 * @param snapshot - 渠道的当前状态快照。
 * @param policy - 应用于评估的策略和上下文。
 * @returns 一个 `ChannelHealthEvaluation` 对象，描述了健康状况和原因。
 */
export function evaluateChannelHealth(
  snapshot: ChannelHealthSnapshot,
  policy: ChannelHealthPolicy,
): ChannelHealthEvaluation {
  // 1. 如果渠道未被管理，则视为健康（我们不关心它）。
  if (!isManagedAccount(snapshot)) {
    return { healthy: true, reason: "unmanaged" };
  }
  // 2. 如果渠道没有在运行，则不健康。
  if (!snapshot.running) {
    return { healthy: false, reason: "not-running" };
  }
  
  // 3. 处理“忙碌（busy）”状态
  const isBusy = snapshot.busy === true || (snapshot.activeRuns ?? 0) > 0;
  // ...
  if (isBusy) {
    // ... 检查忙碌状态是否也“过时”了 ...
    const runActivityAge = policy.now - (snapshot.lastRunActivityAt ?? 0);
    if (runActivityAge < BUSY_ACTIVITY_STALE_THRESHOLD_MS) {
      // 如果最近有活动，则虽然忙，但是是健康的。
      return { healthy: true, reason: "busy" };
    }
    // 如果长时间处于“忙碌”但没有任何实际活动，则判定为“卡住”，不健康。
    return { healthy: false, reason: "stuck" };
  }
  
  // 4. 处理“启动宽限期”
  if (snapshot.lastStartAt != null) {
    const upDuration = policy.now - snapshot.lastStartAt;
    if (upDuration < policy.channelConnectGraceMs) {
      // 如果渠道刚启动不久，给它一些时间去连接，暂时视为健康。
      return { healthy: true, reason: "startup-connect-grace" };
    }
  }
  
  // 5. 如果明确处于“未连接”状态，则不健康。
  if (snapshot.connected === false) {
    return { healthy: false, reason: "disconnected" };
  }

  // 6. 【关键检查】处理“过时的套接字（stale socket）”
  //    这种情况指的是：连接本身是建立的（`connected: true`），但很长时间没有收到任何事件。
  //    这通常意味着连接已经“半死”，需要重启。
  if (
    policy.channelId !== "telegram" && // Telegram 的长轮询模式不适用此检查
    snapshot.mode !== "webhook" &&     // Webhook 模式不适用此检查
    snapshot.connected === true &&
    snapshot.lastEventAt != null
  ) {
    // ... 比较 lastEventAt 和 lastStartAt 来处理重启后的情况 ...
    const eventAge = policy.now - snapshot.lastEventAt;
    if (eventAge > policy.staleEventThresholdMs) {
      return { healthy: false, reason: "stale-socket" };
    }
  }
  
  // 7. 如果所有检查都通过，则渠道是健康的。
  return { healthy: true, reason: "healthy" };
}

/**
 * 将详细的评估原因映射为一个更简洁的、用于日志记录的“重启原因”。
 */
export function resolveChannelRestartReason(
  snapshot: ChannelHealthSnapshot,
  evaluation: ChannelHealthEvaluation,
): ChannelRestartReason {
  if (evaluation.reason === "stale-socket") {
    return "stale-socket";
  }
  if (evaluation.reason === "not-running") {
    // 如果重连次数过多，则标记为“已放弃”
    return snapshot.reconnectAttempts && snapshot.reconnectAttempts >= 10 ? "gave-up" : "stopped";
  }
  if (evaluation.reason === "disconnected") {
    return "disconnected";
  }
  return "stuck";
}
