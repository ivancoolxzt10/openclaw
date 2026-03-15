// 本文件提供了一组用于处理网关认证配置的实用工具，
// 特别是围绕着如何解析“网关密码（gateway password）”这一敏感字段。
// 这里的逻辑需要处理密码可能被配置为直接的字符串，或者是一个“秘密引用（SecretRef）”
// （例如，指向一个文件或环境变量）的情况。

import type { GatewayAuthConfig, OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string.js";

/**
 * 一个纯函数，用于以不可变（immutable）的方式更新配置对象中的网关密码。
 * @param cfg - 原始的 OpenClaw 配置对象。
 * @param password - 新的密码字符串。
 * @returns 一个新的配置对象，其中 `gateway.auth.password` 已被更新。
 */
export function withGatewayAuthPassword(cfg: OpenClawConfig, password: string): OpenClawConfig {
  return {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      auth: {
        ...cfg.gateway?.auth,
        password,
      },
    },
  };
}

/**
 * 判断是否“应该”去解析网关密码的秘密引用。
 * 这是一个决策函数，用于避免在不需要密码或已有密码时进行不必要（或不安全）的解析操作。
 * @returns 如果应该进行解析，则返回 `true`。
 */
function shouldResolveGatewayPasswordSecretRef(params: {
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean; // 是否已从其他来源（如环境变量）获得了一个密码候选值
  hasTokenCandidate: boolean;    // 是否已有一个令牌（token）候选值
}): boolean {
  // 如果已经有了一个密码，就没必要再解析了。
  if (params.hasPasswordCandidate) {
    return false;
  }
  // 如果认证模式明确是 "password"，则必须解析。
  if (params.mode === "password") {
    return true;
  }
  // 如果认证模式是 "token"、"none" 或 "trusted-proxy"，则不需要密码。
  if (params.mode === "token" || params.mode === "none" || params.mode === "trusted-proxy") {
    return false;
  }
  // 作为最后的备用逻辑：如果没有令牌，就尝试解析密码。
  return !params.hasTokenCandidate;
}

/**
 * 【主函数】解析网关密码的秘密引用。
 *
 * @param params - 包含配置、环境和当前认证状态的对象。
 * @returns 一个 Promise，解析为一个可能已更新了密码的 `OpenClawConfig` 对象。
 */
export async function resolveGatewayPasswordSecretRef(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode?: GatewayAuthConfig["mode"];
  hasPasswordCandidate: boolean;
  hasTokenCandidate: boolean;
}): Promise<OpenClawConfig> {
  const authPassword = params.cfg.gateway?.auth?.password;
  // 1. 检查配置中的 `password` 字段是否是一个“秘密引用”对象。
  const { ref } = resolveSecretInputRef({
    value: authPassword,
    defaults: params.cfg.secrets?.defaults,
  });
  if (!ref) {
    // 如果不是秘密引用，则无需操作，直接返回原始配置。
    return params.cfg;
  }
  
  // 2. 调用决策函数，判断现在是否是解析这个秘密引用的合适时机。
  if (
    !shouldResolveGatewayPasswordSecretRef({
      mode: params.mode,
      hasPasswordCandidate: params.hasPasswordCandidate,
      hasTokenCandidate: params.hasTokenCandidate,
    })
  ) {
    return params.cfg;
  }
  
  // 3. 如果需要解析，则调用一个通用的秘密解析函数来获取真实的密码字符串。
  const value = await resolveRequiredConfiguredSecretRefInputString({
    config: params.cfg,
    env: params.env,
    value: authPassword,
    path: "gateway.auth.password",
  });
  if (!value) {
    // 如果解析失败，返回原始配置。
    return params.cfg;
  }
  
  // 4. 如果成功解析出密码，则使用 `withGatewayAuthPassword` 辅助函数
  //    将明文密码更新到配置中，并返回新的配置对象。
  return withGatewayAuthPassword(params.cfg, value);
}
