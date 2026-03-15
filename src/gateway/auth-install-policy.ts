// 本文件包含一个策略函数，用于在“服务安装（service install）”期间，
// 判断是否应该要求用户提供一个网关令牌（Gateway Token）。
//
// “服务安装”指的是将应用设置为一个后台服务（例如，使用 `systemd` 或 `launchd`）。
// 在这种非交互式场景下，如果网关需要认证，安装脚本就必须知道应该使用哪种凭据（令牌还是密码）。
// 这个函数就是用来做这个决策的。

import type { OpenClawConfig } from "../config/config.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

/**
 * 判断在服务安装时是否需要一个网关令牌。
 *
 * @param cfg - OpenClaw 的配置对象。
 * @param _env - Node.js 的进程环境变量 (在此函数中未使用，但保留以备将来扩展)。
 * @returns 如果根据配置推断出认证模式为“令牌（token）”模式，则返回 `true`。
 */
export function shouldRequireGatewayTokenForInstall(
  cfg: OpenClawConfig,
  _env: NodeJS.ProcessEnv,
): boolean {
  const mode = cfg.gateway?.auth?.mode;

  // 1. 如果认证模式被明确配置为 "token"，则需要令牌。
  if (mode === "token") {
    return true;
  }
  // 2. 如果模式是 "password", "none", 或 "trusted-proxy"，则明确不需要令牌。
  if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
    return false;
  }

  // 3. 如果模式未设置（即为 "auto" 或 undefined），则需要进行推断。
  //    推断的逻辑是：如果没有配置密码，那么就假定它需要令牌。

  // a. 检查 `gateway.auth.password` 是否以任何形式（直接值、秘密引用等）被配置。
  const hasConfiguredPassword = hasConfiguredSecretInput(
    cfg.gateway?.auth?.password,
    cfg.secrets?.defaults,
  );
  if (hasConfiguredPassword) {
    // 如果配置了密码，则假定为密码模式，不需要令牌。
    return false;
  }

  // b. 检查是否通过“服务级别”的环境变量配置了密码。
  //    这很重要，因为它只考虑那些在服务运行时也会存在的环境变量（例如，来自 `.env` 文件），
  //    而忽略了可能只存在于当前交互式 shell 中的临时环境变量。
  const configServiceEnv = collectConfigServiceEnvVars(cfg);
  const hasConfiguredPasswordEnvCandidate = Boolean(
    configServiceEnv.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    configServiceEnv.CLAWDBOT_GATEWAY_PASSWORD?.trim(),
  );
  if (hasConfiguredPasswordEnvCandidate) {
    // 如果配置了密码环境变量，则假定为密码模式，不需要令牌。
    return false;
  }

  // 4. 如果以上所有检查都未找到密码配置，则默认需要令牌。
  //    这是一种“默认使用令牌”的安全策略。
  return true;
}
