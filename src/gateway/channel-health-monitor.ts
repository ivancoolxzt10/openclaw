// 本文件实现了“渠道健康监视器（Channel Health Monitor）”。
// 它的核心职责是定期检查所有活动的消息渠道连接（如 Slack, Discord 等）的状态，
// 并在检测到连接不健康时自动尝试重启它们。

import type { ChannelId } from "../channels/plugins/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  resolveChannelRestartReason,
  type ChannelHealthPolicy,
} from "./channel-health-policy.js";
import type { ChannelManager } from "./server-channels.js";

const log = createSubsystemLogger("gateway/health-monitor");

// --- 默认常量 ---
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;        // 默认每5分钟检查一次
const DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000;     // 监视器启动后，等待1分钟的宽限期再开始检查
const DEFAULT_COOLDOWN_CYCLES = 2;                   // 重启后的冷却周期数（周期长度 = 检查间隔）
const DEFAULT_MAX_RESTARTS_PER_HOUR = 10;            // 每小时最大重启次数，防止无限重启循环
const ONE_HOUR_MS = 60 * 60_000;

/**
 * 定义了与健康检查相关的各种时间策略。
 */
export type ChannelHealthTimingPolicy = {
  monitorStartupGraceMs: number; // 监视器启动的宽限期
  channelConnectGraceMs: number; // 单个渠道连接的宽限期
  staleEventThresholdMs: number; // “过时事件”的阈值（多久没收到事件算不健康）
};

/**
 * `startChannelHealthMonitor` 函数的依赖项。
 */
export type ChannelHealthMonitorDeps = {
  channelManager: ChannelManager; // 用于启动/停止渠道的管理器
  checkIntervalMs?: number;      // 检查间隔
  cooldownCycles?: number;       // 冷却周期
  maxRestartsPerHour?: number;   // 每小时最大重启次数
  abortSignal?: AbortSignal;     // 用于停止监视器的中止信号
  // ... 其他 timing 相关的已弃用选项 ...
};

export type ChannelHealthMonitor = {
  stop: () => void;
};

/**
 * 记录单个渠道的重启信息。
 */
type RestartRecord = {
  lastRestartAt: number; // 上次重启的时间戳
  restartsThisHour: { at: number }[]; // 最近一小时内的所有重启记录
};

/**
 * 解析并确定最终生效的时间策略。
 */
function resolveTimingPolicy(
  deps: Pick<
    ChannelHealthMonitorDeps,
    "startupGraceMs" | "channelStartupGraceMs" | "staleEventThresholdMs" | "timing"
  >,
): ChannelHealthTimingPolicy {
  // ... 逻辑：优先使用新的 `timing` 对象，然后回退到旧的独立字段，最后使用默认值 ...
}

/**
 * 【主函数】创建并启动一个渠道健康监视器。
 * @param deps - 包含所有依赖项和配置的对象。
 * @returns 一个包含 `stop` 方法的监视器实例。
 */
export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps): ChannelHealthMonitor {
  // 1. 初始化配置，应用默认值
  const {
    channelManager,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    cooldownCycles = DEFAULT_COOLDOWN_CYCLES,
    maxRestartsPerHour = DEFAULT_MAX_RESTARTS_PER_HOUR,
    abortSignal,
  } = deps;
  const timing = resolveTimingPolicy(deps);

  const cooldownMs = cooldownCycles * checkIntervalMs; // 计算出具体的冷却时间
  const restartRecords = new Map<string, RestartRecord>(); // 用于存储每个渠道的重启记录
  const startedAt = Date.now();
  let stopped = false;
  let checkInFlight = false; // 一个锁，防止上一次检查还未完成时就开始下一次检查
  let timer: ReturnType<typeof setInterval> | null = null;

  const rKey = (channelId: string, accountId: string) => `${channelId}:${accountId}`;

  /**
   * 从重启记录中移除超过一小时的旧记录。
   */
  function pruneOldRestarts(record: RestartRecord, now: number) {
    record.restartsThisHour = record.restartsThisHour.filter((r) => now - r.at < ONE_HOUR_MS);
  }

  /**
   * 【核心检查逻辑】
   * 这个函数由 `setInterval` 定期调用。
   */
  async function runCheck() {
    if (stopped || checkInFlight) {
      return;
    }
    checkInFlight = true;

    try {
      const now = Date.now();
      // 启动宽限期内不执行检查
      if (now - startedAt < timing.monitorStartupGraceMs) {
        return;
      }

      // 获取所有渠道账户的当前状态快照
      const snapshot = channelManager.getRuntimeSnapshot();

      // 遍历所有渠道和账户
      for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
        // ...
        for (const [accountId, status] of Object.entries(accounts)) {
          // ...
          // 跳过被手动停止的渠道
          if (channelManager.isManuallyStopped(channelId as ChannelId, accountId)) {
            continue;
          }
          
          // 2. 使用 `evaluateChannelHealth` 来判断当前渠道的健康状况
          const health = evaluateChannelHealth(status, healthPolicy);
          if (health.healthy) {
            continue; // 如果健康，则跳到下一个
          }

          // 3. 【不健康处理】
          const key = rKey(channelId, accountId);
          const record = restartRecords.get(key) ?? { lastRestartAt: 0, restartsThisHour: [] };

          // a. 检查是否在“冷却期”内。如果是，则暂时不重启，等待下一个检查周期。
          if (now - record.lastRestartAt <= cooldownMs) {
            continue;
          }

          // b. 检查是否已达到每小时最大重启次数限制。
          pruneOldRestarts(record, now);
          if (record.restartsThisHour.length >= maxRestartsPerHour) {
            log.warn?.(`[${channelId}:${accountId}] health-monitor: hit ${maxRestartsPerHour} restarts/hour limit, skipping`);
            continue;
          }
          
          const reason = resolveChannelRestartReason(status, health);
          log.info?.(`[${channelId}:${accountId}] health-monitor: restarting (reason: ${reason})`);

          // c. 执行重启操作
          try {
            if (status.running) {
              await channelManager.stopChannel(channelId as ChannelId, accountId);
            }
            channelManager.resetRestartAttempts(channelId as ChannelId, accountId);
            await channelManager.startChannel(channelId as ChannelId, accountId);
            // d. 更新重启记录
            record.lastRestartAt = now;
            record.restartsThisHour.push({ at: now });
            restartRecords.set(key, record);
          } catch (err) {
            log.error?.(`[${channelId}:${accountId}] health-monitor: restart failed: ${String(err)}`);
          }
        }
      }
    } finally {
      checkInFlight = false; // 释放锁
    }
  }

  /**
   * 停止监视器并清理定时器。
   */
  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // 4. 启动定时器
  if (abortSignal?.aborted) {
    stopped = true;
  } else {
    abortSignal?.addEventListener("abort", stop, { once: true });
    timer = setInterval(() => void runCheck(), checkIntervalMs);
    // ...
  }

  return { stop };
}
