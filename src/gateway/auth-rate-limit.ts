/**
 * @fileoverview
 * 为网关认证尝试实现一个内存中的、基于滑动窗口的速率限制器。
 *
 * **工作原理**:
 * 它通过 `{scope, clientIp}` 来跟踪失败的认证尝试。`scope` 允许调用者
 * 为不同类型的凭据（例如，共享的网关令牌/密码 vs. 设备令牌认证）维护独立的计数器，
 * 同时仍然共享同一个限制器实例。
 *
 * **设计决策**:
 * - **纯内存**: 使用原生的 `Map` 对象，无外部依赖，适用于单个网关进程。
 *   `Map` 会被定期清理，以避免无限增长。
 * - **本地回环地址豁免**: 默认情况下，`127.0.0.1` 和 `::1` 等本地地址不受限制，
 *   以确保本地的 CLI 会话永远不会被锁定。
 * - **无副作用**: 模块本身是无状态的。调用者通过 `createAuthRateLimiter` 创建一个实例，
 *   并根据需要在整个应用程序中传递它。
 */

import { isLoopbackAddress, resolveClientIp } from "./net.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 速率限制器的配置选项。
 */
export interface RateLimitConfig {
  /** 在阻塞前允许的最大失败尝试次数。 @default 10 */
  maxAttempts?: number;
  /** 滑动窗口的持续时间（毫秒）。 @default 60_000 (1分钟) */
  windowMs?: number;
  /** 超过限制后的锁定持续时间（毫秒）。 @default 300_000 (5分钟) */
  lockoutMs?: number;
  /** 是否豁免本地回环地址（localhost）的速率限制。 @default true */
  exemptLoopback?: boolean;
  /** 后台清理过时条目的时间间隔（毫秒）；设置为 <= 0 可禁用自动清理。 @default 60_000 */
  pruneIntervalMs?: number;
}

// 定义不同的认证“范围”，用于隔离不同认证类型的计数器。
export const AUTH_RATE_LIMIT_SCOPE_DEFAULT = "default";
export const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";
export const AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN = "device-token";
export const AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH = "hook-auth";

/**
 * 存储在内存中，用于跟踪单个 IP 状态的条目。
 */
export interface RateLimitEntry {
  /** 在时间窗口内最近失败尝试的时间戳（毫秒）数组。 */
  attempts: number[];
  /** 如果设置了此值，则来自此 IP 的请求将被阻塞，直到这个时间点（毫秒时间戳）。 */
  lockedUntil?: number;
}

/**
 * `check` 方法的返回结果。
 */
export interface RateLimitCheckResult {
  /** 请求是否被允许继续。 */
  allowed: boolean;
  /** 在达到限制之前剩余的尝试次数。 */
  remaining: number;
  /** 锁定过期前剩余的毫秒数（未锁定时为 0）。 */
  retryAfterMs: number;
}

/**
 * 认证速率限制器的公共接口。
 */
export interface AuthRateLimiter {
  /** 检查 `ip` 当前是否被允许尝试认证。 */
  check(ip: string | undefined, scope?: string): RateLimitCheckResult;
  /** 记录一次来自 `ip` 的失败认证尝试。 */
  recordFailure(ip: string | undefined, scope?: string): void;
  /** 重置 `ip` 的速率限制状态（例如，在成功登录后）。 */
  reset(ip: string | undefined, scope?: string): void;
  /** 返回当前跟踪的 IP 数量（用于诊断）。 */
  size(): number;
  /** 移除过期的条目并释放内存。 */
  prune(): void;
  /** 销毁限制器并取消定期的清理计时器。 */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_WINDOW_MS = 60_000; // 1 分钟
const DEFAULT_LOCKOUT_MS = 300_000; // 5 分钟
const PRUNE_INTERVAL_MS = 60_000; // 每分钟清理一次过时条目

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/**
 * 规范化用于认证节流的客户端 IP，以便所有调用者共享一种表示形式。
 */
export function normalizeRateLimitClientIp(ip: string | undefined): string {
  return resolveClientIp({ remoteAddr: ip }) ?? "unknown";
}

/**
 * 创建并返回一个新的认证速率限制器实例。
 * @param config - （可选）速率限制器的配置。
 */
export function createAuthRateLimiter(config?: RateLimitConfig): AuthRateLimiter {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const lockoutMs = config?.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  const exemptLoopback = config?.exemptLoopback ?? true;
  const pruneIntervalMs = config?.pruneIntervalMs ?? PRUNE_INTERVAL_MS;

  // 使用 Map 来存储每个 {scope, ip} 的状态。
  const entries = new Map<string, RateLimitEntry>();

  // 设置一个定时器，定期调用 `prune` 函数来清理，避免内存无限增长。
  const pruneTimer = pruneIntervalMs > 0 ? setInterval(() => prune(), pruneIntervalMs) : null;
  // `unref()` 允许 Node.js 进程在即使此计时器仍然活动时也能正常退出。
  if (pruneTimer?.unref) {
    pruneTimer.unref();
  }
  
  // ... 内部辅助函数 ...
  function resolveKey(rawIp: string | undefined, rawScope: string | undefined): { key: string; ip: string; } {
    const ip = normalizeIp(rawIp);
    const scope = normalizeScope(rawScope);
    // 将范围和IP组合成一个唯一的键。
    return { key: `${scope}:${ip}`, ip };
  }
  function isExempt(ip: string): boolean {
    return exemptLoopback && isLoopbackAddress(ip);
  }
  
  /**
   * “滑动窗口”的核心实现：移除所有早于当前时间窗口的尝试记录。
   */
  function slideWindow(entry: RateLimitEntry, now: number): void {
    const cutoff = now - windowMs;
    entry.attempts = entry.attempts.filter((ts) => ts > cutoff);
  }

  /**
   * 检查一个 IP 是否被允许。
   */
  function check(rawIp: string | undefined, rawScope?: string): RateLimitCheckResult {
    const { key, ip } = resolveKey(rawIp, rawScope);
    if (isExempt(ip)) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    const now = Date.now();
    const entry = entries.get(key);

    if (!entry) {
      return { allowed: true, remaining: maxAttempts, retryAfterMs: 0 };
    }

    // 检查是否仍处于锁定状态
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: entry.lockedUntil - now,
      };
    }

    // 如果锁定已过期，则清除它
    if (entry.lockedUntil && now >= entry.lockedUntil) {
      entry.lockedUntil = undefined;
      entry.attempts = [];
    }

    slideWindow(entry, now);
    const remaining = Math.max(0, maxAttempts - entry.attempts.length);
    return { allowed: remaining > 0, remaining, retryAfterMs: 0 };
  }

  /**
   * 记录一次失败的尝试。
   */
  function recordFailure(rawIp: string | undefined, rawScope?: string): void {
    const { key, ip } = resolveKey(rawIp, rawScope);
    if (isExempt(ip)) {
      return;
    }

    const now = Date.now();
    let entry = entries.get(key);
    if (!entry) {
      entry = { attempts: [] };
      entries.set(key, entry);
    }
    
    if (entry.lockedUntil && now < entry.lockedUntil) {
      return;
    }

    slideWindow(entry, now);
    entry.attempts.push(now);

    // 如果尝试次数达到上限，则设置锁定时间。
    if (entry.attempts.length >= maxAttempts) {
      entry.lockedUntil = now + lockoutMs;
    }
  }

  /**
   * 重置一个 IP 的所有限制。
   */
  function reset(rawIp: string | undefined, rawScope?: string): void {
    const { key } = resolveKey(rawIp, rawScope);
    entries.delete(key);
  }

  /**
   * 清理过期的条目。
   */
  function prune(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      // 如果仍在锁定中，则保留该条目
      if (entry.lockedUntil && now < entry.lockedUntil) {
        continue;
      }
      slideWindow(entry, now);
      // 如果窗口内已没有任何尝试记录，则可以安全地删除该条目以释放内存。
      if (entry.attempts.length === 0) {
        entries.delete(key);
      }
    }
  }

  function size(): number {
    return entries.size;
  }

  function dispose(): void {
    if (pruneTimer) {
      clearInterval(pruneTimer);
    }
    entries.clear();
  }

  return { check, recordFailure, reset, size, prune, dispose };
}
