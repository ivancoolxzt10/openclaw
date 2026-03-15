// 本文件是网关（Gateway）的中央认证和授权引擎。
//
// **核心职责**:
// 1. **解析认证配置**:
//    - `resolveGatewayAuth` 函数读取 `openclaw.json` 和环境变量，
//      并根据明确的优先级规则，确定最终生效的认证模式（`token`, `password`, `none` 等）和凭据。
//
// 2. **执行授权**:
//    - `authorizeGatewayConnect` 函数是授权的核心。它接收一个传入的请求和已解析的认证配置，
//      然后根据不同的认证方法（令牌、密码、Tailscale、受信任的代理等）来决定是否允许该请求。
//
// 3. **安全机制**:
//    - 集成了速率限制（`auth-rate-limit.ts`）来防止暴力破解攻击。
//    - 使用恒定时间比较函数（`safeEqualSecret`）来比较凭据，以防止时序攻击。
//    - 包含了对 Tailscale 和受信任代理头部的验证逻辑，以防止身份欺骗。

import type { IncomingMessage } from "node:http";
import type {
  GatewayAuthConfig,
  GatewayTailscaleMode,
  GatewayTrustedProxyConfig,
} from "../config/config.js";
// ... 其他导入 ...
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
// ...

/**
 * 经过解析后，最终生效的认证模式。
 */
export type ResolvedGatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
/**
 * 描述 `ResolvedGatewayAuthMode` 是如何被决定的来源。
 */
export type ResolvedGatewayAuthModeSource =
  | "override"   // 来自运行时覆盖
  | "config"     // 来自配置文件的明确设置
  | "password"   // 因检测到密码而推断
  | "token"      // 因检测到令牌而推断
  | "default";   // 使用最终的默认值

/**
 * 【核心类型】一个包含了所有已解析和准备就绪的认证配置的对象。
 */
export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  modeSource?: ResolvedGatewayAuthModeSource;
  token?: string;     // 已解析的令牌
  password?: string;  // 已解析的密码
  allowTailscale: boolean; // 是否允许 Tailscale 认证
  trustedProxy?: GatewayTrustedProxyConfig; // 受信任代理的配置
};

/**
 * 授权检查的结果。
 */
export type GatewayAuthResult = {
  ok: boolean; // 是否成功
  method?: "none" | "token" | /* ... 其他方法 ... */; // 使用了哪种认证方法
  user?: string;   // （可选）认证后的用户标识
  reason?: string; // （可选）失败的原因
  rateLimited?: boolean; // 是否因为速率限制而被阻止
  retryAfterMs?: number; // （如果被速率限制）建议客户端等待多少毫秒后再重试
};

// ...

/**
 * 【主函数1：解析配置】根据原始配置和环境变量，解析出最终生效的认证配置。
 *
 * @returns 一个 `ResolvedGatewayAuth` 对象。
 */
export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  authOverride?: GatewayAuthConfig | null; // 运行时的覆盖配置
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  // ... 合并基础配置和覆盖配置 ...
  
  // 1. 从配置或环境变量中解析出原始的令牌和密码值
  const resolvedCredentials = resolveGatewayCredentialsFromValues({ /* ... */ });
  const token = resolvedCredentials.token;
  const password = resolvedCredentials.password;

  // 2. 【核心决策逻辑】根据优先级确定最终的认证 `mode`
  let mode: ResolvedGatewayAuth["mode"];
  let modeSource: ResolvedGatewayAuth["modeSource"];
  if (authOverride?.mode !== undefined) {
    mode = authOverride.mode;
    modeSource = "override";
  } else if (authConfig.mode) {
    mode = authConfig.mode;
    modeSource = "config";
  } else if (password) {
    mode = "password"; // 如果有密码，则推断为密码模式
    modeSource = "password";
  } else if (token) {
    mode = "token"; // 如果有令牌，则推断为令牌模式
    modeSource = "token";
  } else {
    mode = "token"; // 最终默认回退到令牌模式
    modeSource = "default";
  }

  // 3. 决定是否允许 Tailscale 认证
  const allowTailscale =
    authConfig.allowTailscale ??
    (params.tailscaleMode === "serve" && mode !== "password" && mode !== "trusted-proxy");

  return { mode, modeSource, token, password, allowTailscale, trustedProxy };
}

/**
 * 【启动时验证】断言网关认证配置是完整且有效的。
 * 如果配置无效（例如，模式是 "token" 但没有提供令牌），它会抛出一个错误，使应用启动失败。
 * @throws {Error} 如果配置无效。
 */
export function assertGatewayAuthConfigured(
  auth: ResolvedGatewayAuth,
  rawAuthConfig?: GatewayAuthConfig | null,
): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error("gateway auth mode is token, but no token was configured...");
  }
  // ... 其他模式的验证 ...
}


/**
 * 【授权方法：受信任的代理】
 * 验证请求是否来自一个受信任的反向代理，并从 HTTP 头部提取用户身份。
 */
function authorizeTrustedProxy(params: { /* ... */ }): { user: string } | { reason: string } {
  // 1. 检查请求的来源 IP 是否在 `trustedProxies` 列表中。
  // 2. 检查所有 `requiredHeaders` 是否存在。
  // 3. 从 `userHeader` 中提取用户ID。
  // 4. （可选）检查用户ID是否在 `allowUsers` 列表中。
}

/**
 * 【授权方法：Tailscale】
 * 验证一个声称来自 Tailscale 的请求是否合法。
 * 它通过 `tailscale whois` 命令交叉验证 IP 地址和 HTTP 头部中的用户身份，以防止欺骗。
 */
async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  // ... 实现细节 ...
}

/**
 * 【主函数2：执行授权】对一个传入的连接请求进行授权检查。
 *
 * @returns 一个 `GatewayAuthResult` 对象，指示授权是否成功。
 */
export async function authorizeGatewayConnect(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  
  // --- 授权流程开始 ---

  // 1. 如果是“受信任的代理”模式，则使用其专用逻辑。
  if (auth.mode === "trusted-proxy") {
    // ...
  }

  // 2. 如果是“无认证”模式，则直接允许。
  if (auth.mode === "none") {
    return { ok: true, method: "none" };
  }

  // 3. 【速率限制】检查客户端 IP 是否被速率限制。
  const limiter = params.rateLimiter;
  const ip = /* ... 获取客户端IP ... */;
  if (limiter) {
    const rlCheck: RateLimitCheckResult = limiter.check(ip, rateLimitScope);
    if (!rlCheck.allowed) {
      // 如果被限制，则立即拒绝请求。
      return { ok: false, reason: "rate_limited", rateLimited: true, /* ... */ };
    }
  }

  // 4. 【Tailscale 认证】如果允许，则尝试通过 Tailscale 头部进行认证。
  if (allowTailscaleHeaderAuth && auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({ req, tailscaleWhois });
    if (tailscaleCheck.ok) {
      limiter?.reset(ip, rateLimitScope); // 认证成功，重置速率限制器
      return { ok: true, method: "tailscale", user: tailscaleCheck.user.login };
    }
  }

  // 5. 【令牌认证】如果是“令牌”模式...
  if (auth.mode === "token") {
    // a. 检查请求中是否提供了令牌。
    if (!connectAuth?.token) {
      return { ok: false, reason: "token_missing" };
    }
    // b. 使用恒定时间比较函数安全地比较令牌。
    if (!safeEqualSecret(connectAuth.token, auth.token)) {
      limiter?.recordFailure(ip, rateLimitScope); // 失败，记录一次失败尝试
      return { ok: false, reason: "token_mismatch" };
    }
    limiter?.reset(ip, rateLimitScope); // 成功，重置限制器
    return { ok: true, method: "token" };
  }

  // 6. 【密码认证】如果是“密码”模式... (逻辑与令牌类似)
  if (auth.mode === "password") {
    // ...
  }

  // 7. 如果所有检查都失败，则记录一次失败尝试并拒绝请求。
  limiter?.recordFailure(ip, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}

// ... 两个便捷的包装函数，用于区分 HTTP 和 WebSocket 的授权 ...
export async function authorizeHttpGatewayConnect(
  // ...
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({ ...params, authSurface: "http" });
}
export async function authorizeWsControlUiGatewayConnect(
  // ...
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({ ...params, authSurface: "ws-control-ui" });
}
