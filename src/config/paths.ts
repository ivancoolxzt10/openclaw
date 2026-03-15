// 本文件是应用程序中所有重要文件和目录路径的“唯一真实来源（single source of truth）”。
// 它负责确定状态目录、配置文件、OAuth 凭据等的位置。
// 它的设计非常灵活（通过环境变量覆盖）且向后兼容（通过支持旧版路径）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import type { OpenClawConfig } from "./types.js";

/**
 * Nix 模式检测：当 `OPENCLAW_NIX_MODE=1` 时，表示网关正在 Nix 环境下运行。
 * 在此模式下，应用程序的行为会有所不同（例如，不应尝试自动安装流程）。
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

// --- 旧版（Legacy）和新版路径常量 ---
// 支持历史上的旧名称，以确保平滑升级
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moldbot", ".moltbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json", "moldbot.json", "moltbot.json"] as const;

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

/** 为给定的 `env` 构建一个 home-dir thunk，它会尊重 `OPENCLAW_HOME` 环境变量。 */
function envHomedir(env: NodeJS.ProcessEnv): () => string {
  return () => resolveRequiredHomeDir(env, os.homedir);
}

// ... 获取新旧状态目录的辅助函数 ...
function legacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] { /* ... */ }
function newStateDir(homedir: () => string = resolveDefaultHomeDir): string { /* ... */ }
export function resolveLegacyStateDir(homedir: () => string = resolveDefaultHomeDir): string { /* ... */ }
// ...

/**
 * 解析用于存储可变数据（会话、日志、缓存等）的状态目录。
 *
 * 查找顺序:
 * 1. 环境变量 `OPENCLAW_STATE_DIR` 或旧的 `CLAWDBOT_STATE_DIR`。
 * 2. 如果存在，使用新的 `~/.openclaw` 目录。
 * 3. 如果存在，使用任何一个旧的目录（例如 `~/.clawdbot`）。
 * 4. 默认使用新的 `~/.openclaw` 目录。
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  // 1. 检查环境变量覆盖
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  
  const newDir = newStateDir(effectiveHomedir);
  if (env.OPENCLAW_TEST_FAST === "1") return newDir;
  
  // 2. 检查新目录是否存在
  if (fs.existsSync(newDir)) return newDir;
  
  // 3. 检查旧目录是否存在
  const existingLegacy = legacyStateDirs(effectiveHomedir).find((dir) => fs.existsSync(dir));
  if (existingLegacy) return existingLegacy;
  
  // 4. 回退到新目录的路径
  return newDir;
}

/**
 * 一个辅助函数，用于解析包含 `~` 的用户路径。
 */
function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  return resolveHomeRelativePath(input, { env, homedir });
}

export const STATE_DIR = resolveStateDir();

/**
 * 解析配置文件的“规范”路径。
 * 这通常是 `$STATE_DIR/openclaw.json`。
 * @param env 环境变量对象。
 * @param stateDir 状态目录的路径。
 * @returns 配置文件的绝对路径。
 */
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, CONFIG_FILENAME);
}

/**
 * 解析“活动的”配置文件路径。
 * 它会优先选择一个已存在的配置文件，而不是直接返回默认路径。
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  // 查找顺序与 `resolveStateDir` 类似，但针对的是配置文件本身。
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) return resolveUserPath(override, env, homedir);

  const candidates = [
    path.join(stateDir, CONFIG_FILENAME),
    ...LEGACY_CONFIG_FILENAMES.map((name) => path.join(stateDir, name)),
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;
  
  // ... 更复杂的后备逻辑 ...
  return resolveConfigPathCandidate(env, homedir);
}

export const CONFIG_PATH = resolveConfigPathCandidate();

/**
 * 解析所有可能的默认配置文件候选路径。
 */
export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  // ... 返回一个包含所有可能路径（新旧、不同目录下）的列表 ...
}

// --- 其他路径解析 ---

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * 解析网关锁文件目录（用于防止多实例运行）。
 * 通常在操作系统的临时目录下。
 */
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(base, suffix);
}

/**
 * 解析 OAuth 凭据的存储目录。
 */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) return resolveUserPath(override, env, envHomedir(env));
  return path.join(stateDir, "credentials");
}

export function resolveOAuthPath(
  // ...
): string {
  return path.join(resolveOAuthDir(/* ... */), "oauth.json");
}

/**
 * 解析网关应监听的端口号。
 * 查找顺序: 环境变量 -> 配置文件 -> 默认值。
 */
export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}
