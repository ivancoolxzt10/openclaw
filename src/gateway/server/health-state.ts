// 本文件负责管理网关（Gateway）的“健康状态（health state）”。
// 它将网关的状态分为两部分：
// 1. **在线状态 (Presence)**: 可以快速、同步获取的信息，例如正常运行时间、配置路径、认证模式等。
// 2. **健康状态 (Health)**: 可能需要较长时间异步获取的信息，例如通过探测（probe）来检查
//    外部服务（如 AI 模型提供商）的可用性。
//
// 这种分离设计允许客户端（如 Web UI）可以立即获得基本的状态信息，然后再异步地接收
// 更详细但获取较慢的健康报告。

import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { STATE_DIR, createConfigIO, loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAuth } from "../auth.js";
import type { Snapshot } from "../protocol/index.js";

// --- 模块级状态变量 ---
let presenceVersion = 1; // 在线状态的版本号，每次变化时递增
let healthVersion = 1;   // 健康状态的版本号
let healthCache: HealthSummary | null = null; // 缓存的健康摘要
// 用于防止并发刷新健康状态的“锁”（一个 Promise）
let healthRefresh: Promise<HealthSummary> | null = null;
// 一个回调函数，用于在健康状态更新后，将其广播给所有连接的客户端
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

/**
 * 构建一个包含了所有“在线状态”信息的网关快照。
 * @returns 一个 `Snapshot` 对象。
 */
export function buildGatewaySnapshot(): Snapshot {
  const cfg = loadConfig();
  const configPath = createConfigIO().configPath;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const mainSessionKey = resolveMainSessionKey(cfg);
  const scope = cfg.session?.scope ?? "per-sender";
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
  const updateAvailable = getUpdateAvailable() ?? undefined;
  
  // 【注意】健康信息（health）在这里被初始化为空对象。
  // 这是因为获取健康信息是一个异步过程。调用者应该在之后异步调用
  // `getHealthSnapshot`，并在需要时替换这个空对象。
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    // 暴露解析出的路径，以便 UI 可以显示真实的配置位置。
    configPath,
    stateDir: STATE_DIR,
    sessionDefaults: {
      defaultAgentId,
      mainKey,
      mainSessionKey,
      scope,
    },
    authMode: auth.mode,
    updateAvailable,
  };
}

/**
 * 获取缓存的健康摘要。
 */
export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

/**
 * 获取当前的健康状态版本号。
 */
export function getHealthVersion(): number {
  return healthVersion;
}

/**
 * 递增并返回在线状态版本号。
 * 当任何在线状态信息改变时，应调用此函数。
 */
export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

/**
 * 获取当前的在线状态版本号。
 */
export function getPresenceVersion(): number {
  return presenceVersion;
}

/**
 * 设置用于广播健康状态更新的回调函数。
 */
export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

/**
 * 【核心】异步地刷新网关的健康状态快照。
 *
 * 这个函数使用一个 Promise (`healthRefresh`) 作为锁，以实现“去抖（debounce）”效果，
 * 防止在短时间内发起多次昂贵的健康检查。
 *
 * @param opts - 选项，例如 `probe` 为 true 时会强制执行网络探测。
 * @returns 一个解析为最新 `HealthSummary` 的 Promise。
 */
export async function refreshGatewayHealthSnapshot(opts?: { probe?: boolean }) {
  // 1. 如果当前没有正在进行的刷新操作...
  if (!healthRefresh) {
    // 2. ...则创建一个新的 Promise 并将其赋值给 `healthRefresh` 作为“锁”。
    healthRefresh = (async () => {
      // a. 调用 `getHealthSnapshot` 执行昂贵的异步健康检查。
      const snap = await getHealthSnapshot({ probe: opts?.probe });
      // b. 更新缓存和版本号。
      healthCache = snap;
      healthVersion += 1;
      // c. 如果设置了广播回调，则调用它将新状态推送给客户端。
      if (broadcastHealthUpdate) {
        broadcastHealthUpdate(snap);
      }
      return snap;
    })().finally(() => {
      // 3. 无论成功还是失败，在操作完成后都清除“锁”，以便下一次可以发起新的刷新。
      healthRefresh = null;
    });
  }
  // 4. 返回当前正在进行的刷新操作的 Promise。
  //    如果多个调用者同时请求刷新，它们都会获得同一个 Promise，并等待同一个结果。
  return healthRefresh;
}
