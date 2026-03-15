// 本文件包含用于验证网关认证（gateway auth）配置的策略逻辑。
//
// **核心目的**:
// 防止一种模棱两可的、不明确的配置状态：当用户在配置中 *同时* 提供了
// `gateway.auth.token` 和 `gateway.auth.password`，但 *没有* 明确指定
// `gateway.auth.mode` 应该使用哪一种时。
//
// 在这种情况下，应用程序无法确定应该启用令牌认证还是密码认证。
// 这个模块的职责就是检测到这种模糊状态，并强制应用程序启动失败，
// 提示用户必须明确选择一种模式。这是一种“快速失败（fail-fast）”的设计，
// 避免了应用以一种不确定的、可能不安全的状态运行。

import type { OpenClawConfig } from "../config/config.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

/**
 * 当检测到模糊的认证配置时，抛出的标准错误消息。
 */
export const EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR =
  "Invalid config: gateway.auth.token and gateway.auth.password are both configured, but gateway.auth.mode is unset. Set gateway.auth.mode to token or password.";

/**
 * 【检测函数】检查网关认证配置是否存在模棱两可的情况。
 * @param cfg - OpenClaw 配置对象。
 * @returns 如果同时配置了令牌和密码但没有指定模式，则返回 `true`。
 */
export function hasAmbiguousGatewayAuthModeConfig(cfg: OpenClawConfig): boolean {
  const auth = cfg.gateway?.auth;
  if (!auth) {
    return false;
  }
  // 1. 如果 `mode` 已经被明确设置，则不存在模糊性。
  if (typeof auth.mode === "string" && auth.mode.trim().length > 0) {
    return false;
  }
  
  // 2. 检查 `token` 和 `password` 是否都已被配置。
  //    `hasConfiguredSecretInput` 是一个辅助函数，它可以处理直接的值、
  //    环境变量引用或秘密引用（SecretRef）等多种配置方式。
  const defaults = cfg.secrets?.defaults;
  const tokenConfigured = hasConfiguredSecretInput(auth.token, defaults);
  const passwordConfigured = hasConfiguredSecretInput(auth.password, defaults);
  
  // 3. 只有当两者都被配置时，才存在模糊性。
  return tokenConfigured && passwordConfigured;
}

/**
 * 【断言函数】断言在令牌和密码都被配置时，必须明确指定认证模式。
 * 如果检测到模糊状态，此函数会抛出一个错误。
 * @param cfg - OpenClaw 配置对象。
 * @throws {Error} 如果配置是模棱两可的。
 */
export function assertExplicitGatewayAuthModeWhenBothConfigured(cfg: OpenClawConfig): void {
  if (!hasAmbiguousGatewayAuthModeConfig(cfg)) {
    return;
  }
  throw new Error(EXPLICIT_GATEWAY_AUTH_MODE_REQUIRED_ERROR);
}
