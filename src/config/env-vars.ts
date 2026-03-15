// 本文件负责从 OpenClaw 配置文件中提取用户定义的环境变量，
// 并将它们应用到一个给定的环境对象中（例如 `process.env`）。
// 这允许用户在 `openclaw.json` 中直接定义环境变量，
// 以供应用程序或其子进程使用。

import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { containsEnvVarReference } from "./env-substitution.js";
import type { OpenClawConfig } from "./types.js";

/**
 * 检查一个环境变量键是否被安全策略阻止。
 * 这是一个安全护栏，防止用户通过配置文件设置潜在危险的环境变量（如 `LD_PRELOAD`）。
 * @param key 要检查的环境变量名。
 * @returns 如果被阻止，则为 `true`。
 */
function isBlockedConfigEnvVar(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

/**
 * 从配置的 `env` 部分收集环境变量。
 * 支持两种格式：
 * 1. 一个 `vars` 对象: `env: { vars: { MY_VAR: "value" } }`
 * 2. 直接的键值对: `env: { MY_VAR: "value" }`
 * @param cfg OpenClaw 配置对象。
 * @returns 一个包含从配置中提取的环境变量的记录（键值对）。
 */
function collectConfigEnvVarsByTarget(cfg?: OpenClawConfig): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  // 处理 `env.vars` 对象
  if (envConfig.vars) {
    for (const [rawKey, value] of Object.entries(envConfig.vars)) {
      if (!value) continue;
      const key = normalizeEnvVarKey(rawKey, { portable: true }); // 规范化键名
      if (!key || isBlockedConfigEnvVar(key)) continue; // 跳过空键或被阻止的键
      entries[key] = value;
    }
  }

  // 处理 `env` 下的直接键值对
  for (const [rawKey, value] of Object.entries(envConfig)) {
    if (rawKey === "shellEnv" || rawKey === "vars") continue; // 忽略特殊键
    if (typeof value !== "string" || !value.trim()) continue; // 值必须是有效字符串
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || isBlockedConfigEnvVar(key)) continue;
    entries[key] = value;
  }

  return entries;
}

/**
 * 收集用于“运行时（runtime）”目标的环境变量。
 */
export function collectConfigRuntimeEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

/**
 * 收集用于“服务（service）”目标的环境变量。
 */
export function collectConfigServiceEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigEnvVarsByTarget(cfg);
}

/** @deprecated 请使用 `collectConfigRuntimeEnvVars` 或 `collectConfigServiceEnvVars`。 */
export function collectConfigEnvVars(cfg?: OpenClawConfig): Record<string, string> {
  return collectConfigRuntimeEnvVars(cfg);
}

/**
 * 创建一个新的运行时环境对象。
 * 它克隆一个基础环境（默认为 `process.env`），然后将配置文件中的变量合并进去。
 * @param cfg OpenClaw 配置对象。
 * @param baseEnv 基础环境对象。
 * @returns 一个新的、合并了配置变量的环境对象。
 */
export function createConfigRuntimeEnv(
  cfg: OpenClawConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  applyConfigEnvVars(cfg, env);
  return env;
}

/**
 * 将配置文件中定义的环境变量应用（合并）到现有的环境对象中。
 * 这个函数会直接修改传入的 `env` 对象。
 * @param cfg OpenClaw 配置对象。
 * @param env 要修改的环境对象（默认为 `process.env`）。
 */
export function applyConfigEnvVars(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const entries = collectConfigRuntimeEnvVars(cfg);
  for (const [key, value] of Object.entries(entries)) {
    // 安全检查 1: 如果环境中已存在该变量，则不覆盖。
    // 这意味着系统级的环境变量优先级更高。
    if (env[key]?.trim()) {
      continue;
    }
    
    // 安全检查 2: 跳过那些值中仍包含未解析的 `${VAR}` 引用的变量。
    // 因为此函数在环境变量替换之前运行，这可以防止将字面量占位符
    // (例如 "${VAULT_TOKEN}") 写入 `process.env`，从而避免下游的认证逻辑
    // 将其误认为是真实的凭据。
    if (containsEnvVarReference(value)) {
      continue;
    }
    env[key] = value;
  }
}
