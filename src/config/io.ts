/**
 * @fileoverview
 *
 * 这个文件是 OpenClaw 配置管理的 I/O 核心。它负责所有与配置文件（通常是 `openclaw.json`）
 * 的物理读写操作，并封装了相关的复杂逻辑。主要功能包括：
 *
 * 1.  **读取配置**: 从磁盘加载 `openclaw.json` 文件。
 * 2.  **解析与扩展**:
 *     - 使用 `json5` 解析文件，支持更灵活的 JSON 格式（如注释、尾随逗号）。
 *     - 处理 `$include` 指令，将多个配置文件合并在一起。
 *     - 解析和替换 `${VAR}` 形式的环境变量。
 * 3.  **验证与规范化**:
 *     - 使用 Zod schema 验证配置对象的结构是否正确。
 *     - 对加载的配置应用各种默认值和规范化规则（如路径、模型、日志等）。
 *     - 检测并报告遗留（legacy）的配置项。
 * 4.  **写入配置**: 将内存中的配置对象写回磁盘。
 *     - 在写入前，会智能地恢复之前被解析的环境变量引用（`${VAR}`），避免将敏感值硬编码到文件中。
 *     - 自动处理文件备份和轮换 (`.bak`)。
 *     - 记录配置写入审计日志 (`config-audit.jsonl`)，用于追踪变更历史。
 * 5.  **缓存与快照**:
 *     - 提供内存缓存机制，减少频繁的文件读写，提升性能。
 *     - 管理“运行时快照”，支持配置的热重载（live reload）和跨模块的配置一致性。
 *
 * `createConfigIO` 是本文件的核心工厂函数，它返回一个包含 `loadConfig`、`readConfigFileSnapshot`、
 * 和 `writeConfigFile` 等主要操作方法的对象，为上层应用提供了一个清晰、安全的配置交互接口。
 */

import crypto from "node:crypto"; // 导入 Node.js 的加密模块，主要用于计算文件内容的哈希值。
import fs from "node:fs"; // 导入文件系统模块，用于读写文件。
import os from "node:os"; // 导入操作系统模块，用于获取用户主目录等信息。
import path from "node:path"; // 导入路径处理模块，用于操作和解析文件路径。
import { isDeepStrictEqual } from "node:util"; // 导入工具模块的深度严格相等比较函数。
import JSON5 from "json5"; // 导入 JSON5 库，用于解析带注释和尾随逗号的 JSON 文件。
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js"; // 导入确保所有者显示密钥存在的函数。
import { loadDotEnv } from "../infra/dotenv.js"; // 导入加载 `.env` 文件的函数。
import { resolveRequiredHomeDir } from "../infra/home-dir.js"; // 导入解析用户主目录的函数。
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js"; // 导入与 shell 环境加载相关的函数。
import { sanitizeTerminalText } from "../terminal/safe-text.js"; // 导入用于清理终端文本中不安全字符的函数。
import { VERSION } from "../version.js"; // 导入当前应用的版本号。
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js"; // 导入检查重复 agent 目录的函数和错误类型。
import { maintainConfigBackups } from "./backup-rotation.js"; // 导入维护配置文件备份的函数。
import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkConfigNormalization,
  applyTalkApiKey,
} from "./defaults.js"; // 导入一系列用于应用默认配置的函数。
import { restoreEnvVarRefs } from "./env-preserve.js"; // 导入用于恢复环境变量引用的函数。
import {
  type EnvSubstitutionWarning,
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js"; // 导入环境变量替换相关的工具和类型。
import { applyConfigEnvVars } from "./env-vars.js"; // 导入应用配置中定义的环境变量的函数。
import {
  ConfigIncludeError,
  readConfigIncludeFileWithGuards,
  resolveConfigIncludes,
} from "./includes.js"; // 导入处理 `$include` 指令的函数和错误类型。
import { findLegacyConfigIssues } from "./legacy.js"; // 导入查找遗留配置问题的函数。
import { applyMergePatch } from "./merge-patch.js"; // 导入应用合并补丁的函数。
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js"; // 导入规范化安全执行配置的函数。
import { normalizeConfigPaths } from "./normalize-paths.js"; // 导入规范化路径配置的函数。
import { resolveConfigPath, resolveDefaultConfigCandidates, resolveStateDir } from "./paths.js"; // 导入解析各种配置路径的函数。
import { isBlockedObjectKey } from "./prototype-keys.js"; // 导入检查是否为被阻止的原型键的函数。
import { applyConfigOverrides } from "./runtime-overrides.js"; // 导入应用运行时覆盖配置的函数。
import type { OpenClawConfig, ConfigFileSnapshot, LegacyConfigIssue } from "./types.js"; // 导入配置相关的 TypeScript 类型。
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js"; // 导入配置验证函数。
import { compareOpenClawVersions } from "./version.js"; // 导入版本比较函数。

// 重新导出类型以保持向后兼容性。
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";

// 在加载 shell 环境时，期望检查是否存在的一些关键环境变量。
const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
  "MODELSTUDIO_API_KEY",
  "SYNTHETIC_API_KEY",
  "KILOCODE_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

// 用于匹配开放 DM（直接消息）策略配置错误的正则表达式。
const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

// 配置审计日志的文件名。
const CONFIG_AUDIT_LOG_FILENAME = "config-audit.jsonl";
// 用于跟踪已记录的无效配置，避免重复打印错误。
const loggedInvalidConfigs = new Set<string>();

// 配置写入审计结果的类型。
type ConfigWriteAuditResult = "rename" | "copy-fallback" | "failed";

// 配置写入审计记录的结构。
type ConfigWriteAuditRecord = {
  ts: string; // 时间戳
  source: "config-io"; // 来源
  event: "config.write"; // 事件类型
  result: ConfigWriteAuditResult; // 写入结果
  configPath: string; // 配置文件路径
  pid: number; // 进程 ID
  ppid: number; // 父进程 ID
  cwd: string; // 当前工作目录
  argv: string[]; // 命令行参数
  execArgv: string[]; // Node.js 执行参数
  watchMode: boolean; // 是否处于观察模式
  watchSession: string | null; // 观察会话 ID
  watchCommand: string | null; // 观察模式下的命令
  existsBefore: boolean; // 写入前文件是否存在
  previousHash: string | null; // 之前的文件哈希
  nextHash: string | null; // 新文件的哈希
  previousBytes: number | null; // 之前的文件大小
  nextBytes: number | null; // 新文件的大小
  changedPathCount: number | null; // 变化的路径数量
  hasMetaBefore: boolean; // 写入前是否有 meta 字段
  hasMetaAfter: boolean; // 写入后是否有 meta 字段
  gatewayModeBefore: string | null; // 之前的网关模式
  gatewayModeAfter: string | null; // 之后的网关模式
  suspicious: string[]; // 可疑变更的原因列表
  errorCode?: string; // 错误码
  errorMessage?: string; // 错误信息
};

// 解析 JSON5 字符串的结果类型。
export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };
// 配置文件写入的选项。
export type ConfigWriteOptions = {
  /**
   * 读取时捕获的环境变量快照，用于在写入时验证 `${VAR}` 的恢复决策。
   * 如果省略，写入操作将回退到当前的进程环境变量。
   */
  envSnapshotForRestore?: Record<string, string | undefined>;
  /**
   * 可选的安全检查：仅当写入的配置文件路径与生成快照的路径相同时，
   * 才使用 envSnapshotForRestore。
   */
  expectedConfigPath?: string;
  /**
   * 必须从持久化文件内容中明确移除的路径列表，
   * 即使 schema/默认值规范化会重新引入它们。
   */
  unsetPaths?: string[][];
};

// 为写入操作读取配置文件快照的结果类型。
export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

// 运行时配置快照刷新的参数类型。
export type RuntimeConfigSnapshotRefreshParams = {
  sourceConfig: OpenClawConfig;
};

// 运行时配置快照刷新的处理器类型。
export type RuntimeConfigSnapshotRefreshHandler = {
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

// 配置运行时刷新错误的自定义错误类。
export class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRuntimeRefreshError";
  }
}

/**
 * 计算原始配置字符串的 SHA256 哈希值。
 * @param raw 原始配置字符串，如果为 null，则视为空字符串。
 * @returns 64个字符的十六进制哈希字符串。
 */
function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

/**
 * 如果需要，收紧状态目录的权限（仅限非 Windows 系统）。
 * 这是一个尽力而为的安全强化措施。
 * @param params 包含配置路径、环境、homedir 函数和 fs 模块的对象。
 */
async function tightenStateDirPermissionsIfNeeded(params: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  fsModule: typeof fs;
}): Promise<void> {
  // Windows 系统不支持 POSIX 权限，直接返回。
  if (process.platform === "win32") {
    return;
  }
  const stateDir = resolveStateDir(params.env, params.homedir);
  const configDir = path.dirname(params.configPath);
  // 仅当配置文件在状态目录中时才操作。
  if (path.resolve(configDir) !== path.resolve(stateDir)) {
    return;
  }
  try {
    const stat = await params.fsModule.promises.stat(configDir);
    const mode = stat.mode & 0o777; // 获取权限位
    // 如果其他用户和组没有任何权限，则权限已足够严格。
    if ((mode & 0o077) === 0) {
      return;
    }
    // 将目录权限设置为 700 (rwx------)。
    await params.fsModule.promises.chmod(configDir, 0o700);
  } catch {
    // 这是一个尽力而为的操作，即使失败，也应继续执行配置写入。
  }
}

/**
 * 格式化配置验证失败时的错误消息，特别是为开放 DM 策略提供友好的修复建议。
 * @param pathLabel 发生问题的配置路径标签。
 * @param issueMessage 原始的错误信息。
 * @returns 格式化后的、对用户更友好的错误消息。
 */
function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  // 如果不是特定的 DM 策略问题，则返回通用格式。
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  // 为 DM 策略问题提供具体的修复命令。
  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}

/**
 * 检查路径段是否为数字（用于数组索引）。
 * @param raw 路径段字符串。
 * @returns 如果字符串只包含数字，则返回 true。
 */
function isNumericPathSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

/**
 * 检查一个值是否为可用于写入的普通对象。
 * @param value 要检查的值。
 * @returns 如果是普通对象，则返回 true。
 */
function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 检查对象是否自身拥有指定的键（而不是从原型链继承）。
 * @param value 对象。
 * @param key 键名。
 * @returns 如果对象自身拥有该键，则返回 true。
 */
function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// 一个特殊的 Symbol，用于标记一个对象在 unset 操作后应该被完全删除。
const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

// 从值中移除指定路径的结果类型。
type UnsetPathWriteResult = {
  changed: boolean; // 是否发生了改变
  value: unknown; // 操作后的新值
};

/**
 * 递归地从一个值中移除指定路径的属性。
 * 这是 `unsetPathForWrite` 的核心实现。
 * @param value 当前正在处理的值。
 * @param pathSegments 要移除的路径分段数组。
 * @param depth 当前递归的深度。
 * @returns 返回一个包含是否更改和新值的对象。
 */
function unsetPathForWriteAt(
  value: unknown,
  pathSegments: string[],
  depth: number,
): UnsetPathWriteResult {
  // 如果已经到达路径末端，则无需操作。
  if (depth >= pathSegments.length) {
    return { changed: false, value };
  }
  const segment = pathSegments[depth];
  const isLeaf = depth === pathSegments.length - 1;

  // 处理数组
  if (Array.isArray(value)) {
    if (!isNumericPathSegment(segment)) {
      return { changed: false, value };
    }
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
      return { changed: false, value };
    }
    if (isLeaf) {
      // 如果是叶子节点，直接移除该索引的元素。
      const next = value.slice();
      next.splice(index, 1);
      return { changed: true, value: next };
    }
    // 递归处理子元素。
    const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === WRITE_PRUNED_OBJECT) {
      // 如果子对象被完全修剪，则从数组中移除。
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  // 处理对象
  if (
    isBlockedObjectKey(segment) ||
    !isWritePlainObject(value) ||
    !hasOwnObjectKey(value, segment)
  ) {
    return { changed: false, value };
  }
  if (isLeaf) {
    // 如果是叶子节点，直接删除该键。
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      // 如果对象变空，则标记为待修剪。
      value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
    };
  }

  // 递归处理子对象。
  const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === WRITE_PRUNED_OBJECT) {
    // 如果子对象被完全修剪，则删除该键。
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    // 如果对象变空，则标记为待修剪。
    value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
  };
}

/**
 * 从根配置对象中移除指定路径的属性。
 * @param root 根配置对象。
 * @param pathSegments 要移除的路径分段数组。
 * @returns 返回一个包含是否更改和新配置的对象。
 */
function unsetPathForWrite(
  root: OpenClawConfig,
  pathSegments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (pathSegments.length === 0) {
    return { changed: false, next: root };
  }
  const result = unsetPathForWriteAt(root, pathSegments, 0);
  if (!result.changed) {
    return { changed: false, next: root };
  }
  if (result.value === WRITE_PRUNED_OBJECT) {
    // 如果整个对象被修剪，返回一个空对象。
    return { changed: true, next: {} };
  }
  if (isWritePlainObject(result.value)) {
    return { changed: true, next: coerceConfig(result.value) };
  }
  return { changed: false, next: root };
}

/**
 * 解析配置快照的哈希值。
 * 优先使用 `hash` 字段，如果不存在，则根据 `raw` 内容计算。
 * @param snapshot 包含 `hash` 或 `raw` 属性的快照对象。
 * @returns 哈希字符串或 null。
 */
export function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string") {
    const trimmed = snapshot.hash.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (typeof snapshot.raw !== "string") {
    return null;
  }
  return hashConfigRaw(snapshot.raw);
}

/**
 * 将一个未知类型的值强制转换为 OpenClawConfig 类型。
 * 如果值不是对象，则返回一个空对象。
 * @param value 要转换的值。
 * @returns OpenClawConfig 对象。
 */
function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

/**
 * 检查一个值是否为普通对象。
 * @param value 要检查的值。
 * @returns 如果是普通对象，则返回 true。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 检查配置对象是否包含 `meta` 字段。
 * @param value 配置对象。
 * @returns 如果包含 `meta` 对象，则返回 true。
 */
function hasConfigMeta(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const meta = value.meta;
  return isPlainObject(meta);
}

/**
 * 解析配置对象中的网关模式。
 * @param value 配置对象。
 * @returns 网关模式字符串或 null。
 */
function resolveGatewayMode(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const gateway = value.gateway;
  if (!isPlainObject(gateway) || typeof gateway.mode !== "string") {
    return null;
  }
  const trimmed = gateway.mode.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 使用 `structuredClone` 克隆一个未知类型的值。
 * @param value 要克隆的值。
 * @returns 克隆后的值。
 */
function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 创建一个用于从 `base` 对象转换到 `target` 对象的合并补丁（merge patch）。
 * @param base 基础对象。
 * @param target 目标对象。
 * @returns 表示变更的补丁对象。
 */
function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = key in base;
    const hasTarget = key in target;
    if (!hasTarget) {
      // 如果目标中不存在，则标记为删除。
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      // 如果基础中不存在，则为新增。
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(targetValue)) {
      // 递归创建子补丁。
      const childPatch = createMergePatch(baseValue, targetValue);
      if (isPlainObject(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      patch[key] = childPatch;
      continue;
    }
    if (!isDeepStrictEqual(baseValue, targetValue)) {
      // 如果值不相等，则为更新。
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
}

/**
 * 递归地收集对象中所有包含环境变量引用 (`${VAR}`) 的值的路径。
 * @param value 当前值。
 * @param path 当前路径。
 * @param output 用于存储结果的 Map。
 */
function collectEnvRefPaths(value: unknown, path: string, output: Map<string, string>): void {
  if (typeof value === "string") {
    if (containsEnvVarReference(value)) {
      output.set(path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectEnvRefPaths(item, `${path}[${index}]`, output);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      collectEnvRefPaths(child, childPath, output);
    }
  }
}

/**
 * 递归地收集两个对象之间发生变化的所有属性路径。
 * @param base 基础对象。
 * @param target 目标对象。
 * @param path 当前路径。
 * @param output 用于存储结果的 Set。
 */
function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[index], target[index], childPath, output);
    }
    return;
  }
  if (isPlainObject(base) && isPlainObject(target)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = key in base;
      const hasTarget = key in target;
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[key], target[key], childPath, output);
    }
    return;
  }
  if (!isDeepStrictEqual(base, target)) {
    output.add(path);
  }
}

/**
 * 获取一个路径的父路径。
 * @param value 完整路径字符串。
 * @returns 父路径字符串。
 */
function parentPath(value: string): string {
  if (!value) {
    return "";
  }
  if (value.endsWith("]")) {
    const index = value.lastIndexOf("[");
    return index > 0 ? value.slice(0, index) : "";
  }
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(0, index) : "";
}

/**
 * 检查给定路径或其任何父路径是否在已更改路径集合中。
 * @param path 要检查的路径。
 * @param changedPaths 已更改路径的集合。
 * @returns 如果路径已更改，则返回 true。
 */
function isPathChanged(path: string, changedPaths: Set<string>): boolean {
  if (changedPaths.has(path)) {
    return true;
  }
  let current = parentPath(path);
  while (current) {
    if (changedPaths.has(current)) {
      return true;
    }
    current = parentPath(current);
  }
  return changedPaths.has("");
}

/**
 * 递归地恢复对象中未被更改的环境变量引用。
 * @param value 当前值。
 * @param path 当前路径。
 * @param envRefMap 原始环境变量引用映射。
 * @param changedPaths 已更改路径的集合。
 * @returns 恢复后的值。
 */
function restoreEnvRefsFromMap(
  value: unknown,
  path: string,
  envRefMap: Map<string, string>,
  changedPaths: Set<string>,
): unknown {
  if (typeof value === "string") {
    // 如果当前路径未被更改，并且在原始引用映射中存在，则恢复它。
    if (!isPathChanged(path, changedPaths)) {
      const original = envRefMap.get(path);
      if (original !== undefined) {
        return original;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const updated = restoreEnvRefsFromMap(item, `${path}[${index}]`, envRefMap, changedPaths);
      if (updated !== item) {
        changed = true;
      }
      return updated;
    });
    return changed ? next : value;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const updated = restoreEnvRefsFromMap(child, childPath, envRefMap, changedPaths);
      if (updated !== child) {
        changed = true;
      }
      next[key] = updated;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * 解析配置审计日志文件的完整路径。
 * @param env 进程环境变量。
 * @param homedir 获取主目录的函数。
 * @returns 审计日志文件的绝对路径。
 */
function resolveConfigAuditLogPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveStateDir(env, homedir), "logs", CONFIG_AUDIT_LOG_FILENAME);
}

/**
 * 分析并返回配置写入中可能存在的可疑变更的原因。
 * @param params 包含写入前后状态信息的对象。
 * @returns 一个包含可疑原因描述字符串的数组。
 */
function resolveConfigWriteSuspiciousReasons(params: {
  existsBefore: boolean;
  previousBytes: number | null;
  nextBytes: number | null;
  hasMetaBefore: boolean;
  gatewayModeBefore: string | null;
  gatewayModeAfter: string | null;
}): string[] {
  const reasons: string[] = [];
  if (!params.existsBefore) {
    return reasons;
  }
  // 文件大小大幅减小
  if (
    typeof params.previousBytes === "number" &&
    typeof params.nextBytes === "number" &&
    params.previousBytes >= 512 &&
    params.nextBytes < Math.floor(params.previousBytes * 0.5)
  ) {
    reasons.push(`size-drop:${params.previousBytes}->${params.nextBytes}`);
  }
  // 写入前缺少 meta 字段
  if (!params.hasMetaBefore) {
    reasons.push("missing-meta-before-write");
  }
  // 网关模式被移除
  if (params.gatewayModeBefore && !params.gatewayModeAfter) {
    reasons.push("gateway-mode-removed");
  }
  return reasons;
}

/**
 * 将一条配置写入审计记录追加到日志文件中。
 * @param deps 依赖项对象。
 * @param record 要写入的审计记录。
 */
async function appendConfigWriteAuditRecord(
  deps: Required<ConfigIoDeps>,
  record: ConfigWriteAuditRecord,
): Promise<void> {
  try {
    const auditPath = resolveConfigAuditLogPath(deps.env, deps.homedir);
    await deps.fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await deps.fs.promises.appendFile(auditPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // 这是一个尽力而为的操作。
  }
}

// 定义配置 I/O 操作的依赖项类型。
export type ConfigIoDeps = {
  fs?: typeof fs; // 文件系统模块
  json5?: typeof JSON5; // JSON5 解析器
  env?: NodeJS.ProcessEnv; // 进程环境变量
  homedir?: () => string; // 获取主目录的函数
  configPath?: string; // 配置文件路径
  logger?: Pick<typeof console, "error" | "warn">; // 日志记录器
};

/**
 * 检查配置中是否存在已废弃的键名并发出警告。
 * @param raw 原始配置对象。
 * @param logger 日志记录器。
 */
function warnOnConfigMiskeys(raw: unknown, logger: Pick<typeof console, "warn">): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return;
  }
  if ("token" in (gateway as Record<string, unknown>)) {
    logger.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

/**
 * 为配置对象添加或更新版本和时间戳元数据。
 * @param cfg 原始配置对象。
 * @returns 带有更新后 meta 字段的配置对象。
 */
function stampConfigVersion(cfg: OpenClawConfig): OpenClawConfig {
  const now = new Date().toISOString();
  return {
    ...cfg,
    meta: {
      ...cfg.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: now,
    },
  };
}

/**
 * 如果配置文件是由一个更新版本的 OpenClaw 写入的，则发出警告。
 * @param cfg 配置对象。
 * @param logger 日志记录器。
 */
function warnIfConfigFromFuture(cfg: OpenClawConfig, logger: Pick<typeof console, "warn">): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) {
    return;
  }
  const cmp = compareOpenClawVersions(VERSION, touched);
  if (cmp === null) {
    return;
  }
  if (cmp < 0) {
    logger.warn(
      `Config was last written by a newer OpenClaw (${touched}); current version is ${VERSION}.`,
    );
  }
}

/**
 * 从依赖项中解析出最终的配置文件路径。
 * @param deps 依赖项对象。
 * @returns 配置文件路径。
 */
function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) {
    return deps.configPath;
  }
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir));
}

/**
 * 规范化依赖项对象，为所有可选字段提供默认值。
 * @param overrides 用户提供的覆盖项。
 * @returns 一个包含所有字段的完整依赖项对象。
 */
function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env: overrides.env ?? process.env,
    homedir:
      overrides.homedir ?? (() => resolveRequiredHomeDir(overrides.env ?? process.env, os.homedir)),
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
  };
}

/**
 * 尝试为当前进程环境加载 `.env` 文件。
 * 仅在操作真实 `process.env` 时执行，以隔离测试环境。
 * @param env 进程环境变量。
 */
function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  if (env !== process.env) {
    return;
  }
  loadDotEnv({ quiet: true });
}

/**
 * 使用 JSON5 解析器解析字符串。
 * @param raw 要解析的字符串。
 * @param json5 JSON5 解析器实例。
 * @returns 成功则返回解析后的对象，失败则返回错误信息。
 */
export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// 配置读取解析的结果类型。
type ConfigReadResolution = {
  resolvedConfigRaw: unknown; // 解析了 includes 和 env 后的原始配置
  envSnapshotForRestore: Record<string, string | undefined>; // 用于恢复的环境变量快照
  envWarnings: EnvSubstitutionWarning[]; // 环境变量替换过程中的警告
};

/**
 * 在读取配置时，解析其中的 `$include` 指令。
 * @param parsed 初始解析的配置对象。
 * @param configPath 配置文件路径。
 * @param deps 依赖项。
 * @returns 解析了 includes 后的配置对象。
 */
function resolveConfigIncludesForRead(
  parsed: unknown,
  configPath: string,
  deps: Required<ConfigIoDeps>,
): unknown {
  return resolveConfigIncludes(parsed, configPath, {
    readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
    readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
      readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath,
        rootRealDir,
        ioFs: deps.fs,
      }),
    parseJson: (raw) => deps.json5.parse(raw),
  });
}

/**
 * 在读取配置时，解析其中的环境变量引用 (`${VAR}`)。
 * @param resolvedIncludes 已解析 includes 的配置对象。
 * @param env 环境变量。
 * @returns 包含解析结果、快照和警告的对象。
 */
function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
): ConfigReadResolution {
  // 在替换 ${VAR} 之前，先将 config.env 应用到 process.env，这样可以引用配置中定义的变量。
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as OpenClawConfig, env);
  }

  // 将缺失的环境变量引用收集为警告而不是抛出错误，
  // 这样即使非关键配置部分的变量未设置，网关也能启动。
  const envWarnings: EnvSubstitutionWarning[] = [];
  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
      onMissing: (w) => envWarnings.push(w),
    }),
    // 捕获替换后的环境变量快照，用于写入时恢复 ${VAR}。
    envSnapshotForRestore: { ...env } as Record<string, string | undefined>,
    envWarnings,
  };
}

// 读取配置文件快照的内部结果类型。
type ReadConfigFileSnapshotInternalResult = {
  snapshot: ConfigFileSnapshot;
  envSnapshotForRestore?: Record<string, string | undefined>;
};

/**
 * 创建一个配置 I/O 操作的实例。
 * 这是本文件的主要入口点，返回一个包含所有核心操作方法的对象。
 * @param overrides 用户提供的依赖项覆盖。
 * @returns 一个包含配置操作方法的对象。
 */
export function createConfigIO(overrides: ConfigIoDeps = {}) {
  const deps = normalizeDeps(overrides);
  const requestedConfigPath = resolveConfigPathForDeps(deps);
  // 查找实际存在的配置文件路径。
  const candidatePaths = deps.configPath
    ? [requestedConfigPath]
    : resolveDefaultConfigCandidates(deps.env, deps.homedir);
  const configPath =
    candidatePaths.find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;

  /**
   * 加载、解析、验证并返回最终的配置对象。
   * 这是应用获取配置的主要函数。
   */
  function loadConfig(): OpenClawConfig {
    try {
      maybeLoadDotEnvForConfig(deps.env);
      if (!deps.fs.existsSync(configPath)) {
        // 如果配置文件不存在，尝试加载 shell 环境作为回退。
        if (shouldEnableShellEnvFallback(deps.env) && !shouldDeferShellEnvFallback(deps.env)) {
          loadShellEnvFallback({
            enabled: true,
            env: deps.env,
            expectedKeys: SHELL_ENV_EXPECTED_KEYS,
            logger: deps.logger,
            timeoutMs: resolveShellEnvFallbackTimeoutMs(deps.env),
          });
        }
        return {};
      }
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const parsed = deps.json5.parse(raw);
      // 解析 includes 和 env vars
      const readResolution = resolveConfigForRead(
        resolveConfigIncludesForRead(parsed, configPath, deps),
        deps.env,
      );
      const resolvedConfig = readResolution.resolvedConfigRaw;
      // 打印环境变量缺失的警告
      for (const w of readResolution.envWarnings) {
        deps.logger.warn(
          `Config (${configPath}): missing env var "${w.varName}" at ${w.configPath} — feature using this value will be unavailable`,
        );
      }
      warnOnConfigMiskeys(resolvedConfig, deps.logger);
      if (typeof resolvedConfig !== "object" || resolvedConfig === null) {
        return {};
      }
      // 验证前检查重复的 agent 目录
      const preValidationDuplicates = findDuplicateAgentDirs(resolvedConfig as OpenClawConfig, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (preValidationDuplicates.length > 0) {
        throw new DuplicateAgentDirError(preValidationDuplicates);
      }
      // 验证配置对象
      const validated = validateConfigObjectWithPlugins(resolvedConfig);
      if (!validated.ok) {
        const details = validated.issues
          .map(
            (iss) =>
              `- ${sanitizeTerminalText(iss.path || "<root>")}: ${sanitizeTerminalText(iss.message)}`,
          )
          .join("\n");
        if (!loggedInvalidConfigs.has(configPath)) {
          loggedInvalidConfigs.add(configPath);
          deps.logger.error(`Invalid config at ${configPath}:\\n${details}`);
        }
        const error = new Error(`Invalid config at ${configPath}:\n${details}`);
        (error as { code?: string; details?: string }).code = "INVALID_CONFIG";
        (error as { code?: string; details?: string }).details = details;
        throw error;
      }
      // 打印验证警告
      if (validated.warnings.length > 0) {
        const details = validated.warnings
          .map(
            (iss) =>
              `- ${sanitizeTerminalText(iss.path || "<root>")}: ${sanitizeTerminalText(iss.message)}`,
          )
          .join("\n");
        deps.logger.warn(`Config warnings:\\n${details}`);
      }
      warnIfConfigFromFuture(validated.config, deps.logger);
      // 应用一系列默认值和规范化
      const cfg = applyTalkConfigNormalization(
        applyModelDefaults(
          applyCompactionDefaults(
            applyContextPruningDefaults(
              applyAgentDefaults(
                applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
              ),
            ),
          ),
        ),
      );
      normalizeConfigPaths(cfg);
      normalizeExecSafeBinProfilesInConfig(cfg);

      // 再次检查重复的 agent 目录
      const duplicates = findDuplicateAgentDirs(cfg, {
        env: deps.env,
        homedir: deps.homedir,
      });
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }

      applyConfigEnvVars(cfg, deps.env);

      // 加载 shell 环境变量
      const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
      if (enabled && !shouldDeferShellEnvFallback(deps.env)) {
        loadShellEnvFallback({
          enabled: true,
          env: deps.env,
          expectedKeys: SHELL_ENV_EXPECTED_KEYS,
          logger: deps.logger,
          timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
        });
      }

      // 确保并可能自动生成 ownerDisplaySecret
      const pendingSecret = AUTO_OWNER_DISPLAY_SECRET_BY_PATH.get(configPath);
      const ownerDisplaySecretResolution = ensureOwnerDisplaySecret(
        cfg,
        () => pendingSecret ?? crypto.randomBytes(32).toString("hex"),
      );
      const cfgWithOwnerDisplaySecret = ownerDisplaySecretResolution.config;
      if (ownerDisplaySecretResolution.generatedSecret) {
        // 如果生成了新密钥，则异步写回配置文件
        AUTO_OWNER_DISPLAY_SECRET_BY_PATH.set(
          configPath,
          ownerDisplaySecretResolution.generatedSecret,
        );
        if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.has(configPath)) {
          AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.add(configPath);
          void writeConfigFile(cfgWithOwnerDisplaySecret, { expectedConfigPath: configPath })
            .then(() => {
              AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
              AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
            })
            .catch((err) => {
              if (!AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.has(configPath)) {
                AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.add(configPath);
                deps.logger.warn(
                  `Failed to persist auto-generated commands.ownerDisplaySecret at ${configPath}: ${String(err)}`,
                );
              }
            })
            .finally(() => {
              AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT.delete(configPath);
            });
        }
      } else {
        AUTO_OWNER_DISPLAY_SECRET_BY_PATH.delete(configPath);
        AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED.delete(configPath);
      }

      // 应用运行时覆盖并返回最终配置
      return applyConfigOverrides(cfgWithOwnerDisplaySecret);
    } catch (err) {
      if (err instanceof DuplicateAgentDirError) {
        deps.logger.error(err.message);
        throw err;
      }
      const error = err as { code?: string };
      if (error?.code === "INVALID_CONFIG") {
        // 对于无效配置，直接失败，避免静默回退到可能不安全的默认值。
        throw err;
      }
      deps.logger.error(`Failed to read config at ${configPath}`, err);
      throw err;
    }
  }

  /**
   * 读取配置文件的完整快照，包含原始文本、解析后的对象、验证状态等。
   * 这是 `writeConfigFile` 和其他需要详细上下文的操作的基础。
   */
  async function readConfigFileSnapshotInternal(): Promise<ReadConfigFileSnapshotInternalResult> {
    maybeLoadDotEnvForConfig(deps.env);
    const exists = deps.fs.existsSync(configPath);
    if (!exists) {
      // 如果文件不存在，返回一个表示空配置的快照。
      const hash = hashConfigRaw(null);
      const config = applyTalkApiKey(
        applyTalkConfigNormalization(
          applyModelDefaults(
            applyCompactionDefaults(
              applyContextPruningDefaults(
                applyAgentDefaults(applySessionDefaults(applyMessageDefaults({}))),
              ),
            ),
          ),
        ),
      );
      const legacyIssues: LegacyConfigIssue[] = [];
      return {
        snapshot: {
          path: configPath,
          exists: false,
          raw: null,
          parsed: {},
          resolved: {},
          valid: true,
          config,
          hash,
          issues: [],
          warnings: [],
          legacyIssues,
        },
      };
    }

    try {
      const raw = deps.fs.readFileSync(configPath, "utf-8");
      const hash = hashConfigRaw(raw);
      const parsedRes = parseConfigJson5(raw, deps.json5);
      if (!parsedRes.ok) {
        // 如果 JSON5 解析失败，返回无效快照。
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: {},
            resolved: {},
            valid: false,
            config: {},
            hash,
            issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      // 解析 `$include` 指令
      let resolved: unknown;
      try {
        resolved = resolveConfigIncludesForRead(parsedRes.parsed, configPath, deps);
      } catch (err) {
        const message =
          err instanceof ConfigIncludeError
            ? err.message
            : `Include resolution failed: ${String(err)}`;
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(parsedRes.parsed),
            valid: false,
            config: coerceConfig(parsedRes.parsed),
            hash,
            issues: [{ path: "", message }],
            warnings: [],
            legacyIssues: [],
          },
        };
      }

      // 解析环境变量
      const readResolution = resolveConfigForRead(resolved, deps.env);

      const envVarWarnings = readResolution.envWarnings.map((w) => ({
        path: w.configPath,
        message: `Missing env var "${w.varName}" — feature using this value will be unavailable`,
      }));

      const resolvedConfigRaw = readResolution.resolvedConfigRaw;
      // 检测遗留配置项
      const legacyIssues = findLegacyConfigIssues(resolvedConfigRaw, parsedRes.parsed);

      // 验证配置
      const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
      if (!validated.ok) {
        return {
          snapshot: {
            path: configPath,
            exists: true,
            raw,
            parsed: parsedRes.parsed,
            resolved: coerceConfig(resolvedConfigRaw),
            valid: false,
            config: coerceConfig(resolvedConfigRaw),
            hash,
            issues: validated.issues,
            warnings: [...validated.warnings, ...envVarWarnings],
            legacyIssues,
          },
        };
      }

      warnIfConfigFromFuture(validated.config, deps.logger);
      // 应用规范化
      const snapshotConfig = normalizeConfigPaths(
        applyTalkApiKey(
          applyTalkConfigNormalization(
            applyModelDefaults(
              applyAgentDefaults(
                applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
              ),
            ),
          ),
        ),
      );
      normalizeExecSafeBinProfilesInConfig(snapshotConfig);
      // 返回成功的快照
      return {
        snapshot: {
          path: configPath,
          exists: true,
          raw,
          parsed: parsedRes.parsed,
          resolved: coerceConfig(resolvedConfigRaw),
          valid: true,
          config: snapshotConfig,
          hash,
          issues: [],
          warnings: [...validated.warnings, ...envVarWarnings],
          legacyIssues,
        },
        envSnapshotForRestore: readResolution.envSnapshotForRestore,
      };
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      let message: string;
      if (nodeErr?.code === "EACCES") {
        // 处理权限错误
        const uid = process.getuid?.();
        const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
        message = [
          `read failed: ${String(err)}`,
          ``,
          `Config file is not readable by the current process. If running in a container`,
          `or 1-click deployment, fix ownership with:`,
          `  chown ${uidHint} "${configPath}"`,
          `Then restart the gateway.`,
        ].join("\n");
        deps.logger.error(message);
      } else {
        message = `read failed: ${String(err)}`;
      }
      return {
        snapshot: {
          path: configPath,
          exists: true,
          raw: null,
          parsed: {},
          resolved: {},
          valid: false,
          config: {},
          hash: hashConfigRaw(null),
          issues: [{ path: "", message }],
          warnings: [],
          legacyIssues: [],
        },
      };
    }
  }

  /**
   * 读取配置文件的快照（公共接口）。
   */
  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    const result = await readConfigFileSnapshotInternal();
    return result.snapshot;
  }

  /**
   * 为写入操作读取配置文件的快照，同时返回写入所需的选项。
   */
  async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
    const result = await readConfigFileSnapshotInternal();
    return {
      snapshot: result.snapshot,
      writeOptions: {
        envSnapshotForRestore: result.envSnapshotForRestore,
        expectedConfigPath: configPath,
      },
    };
  }

  /**
   * 将配置对象写入文件。
   * @param cfg 要写入的配置对象。
   * @param options 写入选项。
   */
  async function writeConfigFile(cfg: OpenClawConfig, options: ConfigWriteOptions = {}) {
    clearConfigCache();
    let persistCandidate: unknown = cfg;
    const { snapshot } = await readConfigFileSnapshotInternal();
    let envRefMap: Map<string, string> | null = null;
    let changedPaths: Set<string> | null = null;
    if (snapshot.valid && snapshot.exists) {
      // 基于当前配置和快照创建补丁，以应用变更。
      const patch = createMergePatch(snapshot.config, cfg);
      persistCandidate = applyMergePatch(snapshot.resolved, patch);
      try {
        // 收集原始文件中的环境变量引用，用于恢复。
        const resolvedIncludes = resolveConfigIncludes(snapshot.parsed, configPath, {
          readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
          readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
            readConfigIncludeFileWithGuards({
              includePath,
              resolvedPath,
              rootRealDir,
              ioFs: deps.fs,
            }),
          parseJson: (raw) => deps.json5.parse(raw),
        });
        const collected = new Map<string, string>();
        collectEnvRefPaths(resolvedIncludes, "", collected);
        if (collected.size > 0) {
          envRefMap = collected;
          changedPaths = new Set<string>();
          collectChangedPaths(snapshot.config, cfg, "", changedPaths);
        }
      } catch {
        envRefMap = null;
      }
    }

    // 验证待持久化的配置
    const validated = validateConfigObjectRawWithPlugins(persistCandidate);
    if (!validated.ok) {
      const issue = validated.issues[0];
      const pathLabel = issue?.path ? issue.path : "<root>";
      const issueMessage = issue?.message ?? "invalid";
      throw new Error(formatConfigValidationFailure(pathLabel, issueMessage));
    }
    if (validated.warnings.length > 0) {
      const details = validated.warnings
        .map((warning) => `- ${warning.path}: ${warning.message}`)
        .join("\n");
      deps.logger.warn(`Config warnings:\n${details}`);
    }

    // 智能地恢复环境变量引用，避免将敏感值写入文件。
    let cfgToWrite = validated.config;
    try {
      if (deps.fs.existsSync(configPath)) {
        const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
        const parsedRes = parseConfigJson5(currentRaw, deps.json5);
        if (parsedRes.ok) {
          const envForRestore = options.envSnapshotForRestore ?? deps.env;
          cfgToWrite = restoreEnvVarRefs(
            cfgToWrite,
            parsedRes.parsed,
            envForRestore,
          ) as OpenClawConfig;
        }
      }
    } catch {
      // 如果读取当前文件失败，则按原样写入 cfg（不恢复环境变量）。
    }

    const dir = path.dirname(configPath);
    await deps.fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await tightenStateDirPermissionsIfNeeded({
      configPath,
      env: deps.env,
      homedir: deps.homedir,
      fsModule: deps.fs,
    });
    // 再次恢复环境变量引用
    const outputConfigBase =
      envRefMap && changedPaths
        ? (restoreEnvRefsFromMap(cfgToWrite, "", envRefMap, changedPaths) as OpenClawConfig)
        : cfgToWrite;
    let outputConfig = outputConfigBase;
    // 处理 unsetPaths
    if (options.unsetPaths?.length) {
      for (const unsetPath of options.unsetPaths) {
        if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
          continue;
        }
        const unsetResult = unsetPathForWrite(outputConfig, unsetPath);
        if (unsetResult.changed) {
          outputConfig = unsetResult.next;
        }
      }
    }
    // 添加版本和时间戳，然后序列化为 JSON
    const stampedOutputConfig = stampConfigVersion(outputConfig);
    const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
    const nextHash = hashConfigRaw(json);
    const previousHash = resolveConfigSnapshotHash(snapshot);
    const changedPathCount = changedPaths?.size;
    const previousBytes =
      typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
    const nextBytes = Buffer.byteLength(json, "utf-8");
    const hasMetaBefore = hasConfigMeta(snapshot.parsed);
    const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
    const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
    const gatewayModeAfter = resolveGatewayMode(stampedOutputConfig);
    // 检查可疑变更
    const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
      existsBefore: snapshot.exists,
      previousBytes,
      nextBytes,
      hasMetaBefore,
      gatewayModeBefore,
      gatewayModeAfter,
    });

    // 记录覆盖日志
    const logConfigOverwrite = () => {
      if (!snapshot.exists) {
        return;
      }
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_OVERWRITE_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      const changeSummary =
        typeof changedPathCount === "number" ? `, changedPaths=${changedPathCount}` : "";
      deps.logger.warn(
        `Config overwrite: ${configPath} (sha256 ${previousHash ?? "unknown"} -> ${nextHash}, backup=${configPath}.bak${changeSummary})`,
      );
    };
    // 记录异常写入日志
    const logConfigWriteAnomalies = () => {
      if (suspiciousReasons.length === 0) {
        return;
      }
      const isVitest = deps.env.VITEST === "true";
      const shouldLogInVitest = deps.env.OPENCLAW_TEST_CONFIG_WRITE_ANOMALY_LOG === "1";
      if (isVitest && !shouldLogInVitest) {
        return;
      }
      deps.logger.warn(`Config write anomaly: ${configPath} (${suspiciousReasons.join(", ")})`);
    };

    // 准备审计记录
    const auditRecordBase = {
      ts: new Date().toISOString(),
      source: "config-io" as const,
      event: "config.write" as const,
      configPath,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      argv: process.argv.slice(0, 8),
      execArgv: process.execArgv.slice(0, 8),
      watchMode: deps.env.OPENCLAW_WATCH_MODE === "1",
      watchSession:
        typeof deps.env.OPENCLAW_WATCH_SESSION === "string" &&
        deps.env.OPENCLAW_WATCH_SESSION.trim().length > 0
          ? deps.env.OPENCLAW_WATCH_SESSION.trim()
          : null,
      watchCommand:
        typeof deps.env.OPENCLAW_WATCH_COMMAND === "string" &&
        deps.env.OPENCLAW_WATCH_COMMAND.trim().length > 0
          ? deps.env.OPENCLAW_WATCH_COMMAND.trim()
          : null,
      existsBefore: snapshot.exists,
      previousHash: previousHash ?? null,
      nextHash,
      previousBytes,
      nextBytes,
      changedPathCount: typeof changedPathCount === "number" ? changedPathCount : null,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspicious: suspiciousReasons,
    };
    // 追加写入审计日志的函数
    const appendWriteAudit = async (result: ConfigWriteAuditResult, err?: unknown) => {
      const errorCode =
        err && typeof err === "object" && "code" in err && typeof err.code === "string"
          ? err.code
          : undefined;
      const errorMessage =
        err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : undefined;
      await appendConfigWriteAuditRecord(deps, {
        ...auditRecordBase,
        result,
        nextHash: result === "failed" ? null : auditRecordBase.nextHash,
        nextBytes: result === "failed" ? null : auditRecordBase.nextBytes,
        errorCode,
        errorMessage,
      });
    };

    // 使用临时文件实现原子写入
    const tmp = path.join(
      dir,
      `${path.basename(configPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    try {
      await deps.fs.promises.writeFile(tmp, json, {
        encoding: "utf-8",
        mode: 0o600,
      });

      if (deps.fs.existsSync(configPath)) {
        await maintainConfigBackups(configPath, deps.fs.promises);
      }

      try {
        await deps.fs.promises.rename(tmp, configPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // 在 Windows 上，rename 可能因为文件已存在而失败，回退到 copy + unlink
        if (code === "EPERM" || code === "EEXIST") {
          await deps.fs.promises.copyFile(tmp, configPath);
          await deps.fs.promises.chmod(configPath, 0o600).catch(() => {});
          await deps.fs.promises.unlink(tmp).catch(() => {});
          logConfigOverwrite();
          logConfigWriteAnomalies();
          await appendWriteAudit("copy-fallback");
          return;
        }
        await deps.fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
      logConfigOverwrite();
      logConfigWriteAnomalies();
      await appendWriteAudit("rename");
    } catch (err) {
      await appendWriteAudit("failed", err);
      throw err;
    }
  }

  return {
    configPath,
    loadConfig,
    readConfigFileSnapshot,
    readConfigFileSnapshotForWrite,
    writeConfigFile,
  };
}

// ---- 全局缓存和运行时快照 ----
// 这些包装器故意不在模块作用域缓存解析的配置路径，
// 以便 `OPENCLAW_CONFIG_PATH` 等环境变量在模块导入后设置仍然有效。
const DEFAULT_CONFIG_CACHE_MS = 200; // 默认缓存时间
const AUTO_OWNER_DISPLAY_SECRET_BY_PATH = new Map<string, string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_IN_FLIGHT = new Set<string>();
const AUTO_OWNER_DISPLAY_SECRET_PERSIST_WARNED = new Set<string>();
let configCache: {
  configPath: string;
  expiresAt: number;
  config: OpenClawConfig;
} | null = null;
let runtimeConfigSnapshot: OpenClawConfig | null = null;
let runtimeConfigSourceSnapshot: OpenClawConfig | null = null;
let runtimeConfigSnapshotRefreshHandler: RuntimeConfigSnapshotRefreshHandler | null = null;

function resolveConfigCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_CONFIG_CACHE_MS?.trim();
  if (raw === "" || raw === "0") {
    return 0;
  }
  if (!raw) {
    return DEFAULT_CONFIG_CACHE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CONFIG_CACHE_MS;
  }
  return Math.max(0, parsed);
}

function shouldUseConfigCache(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_DISABLE_CONFIG_CACHE?.trim()) {
    return false;
  }
  return resolveConfigCacheMs(env) > 0;
}

/** 清除全局配置缓存。 */
export function clearConfigCache(): void {
  configCache = null;
}

/**
 * 设置运行时配置快照。
 * 这用于支持配置的热重载。
 * @param config 应用了所有默认值和解析的配置。
 * @param sourceConfig 未解析默认值的源配置。
 */
export function setRuntimeConfigSnapshot(
  config: OpenClawConfig,
  sourceConfig?: OpenClawConfig,
): void {
  runtimeConfigSnapshot = config;
  runtimeConfigSourceSnapshot = sourceConfig ?? null;
  clearConfigCache();
}

/** 清除运行时配置快照。 */
export function clearRuntimeConfigSnapshot(): void {
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
  clearConfigCache();
}

/** 获取当前的运行时配置快照。 */
export function getRuntimeConfigSnapshot(): OpenClawConfig | null {
  return runtimeConfigSnapshot;
}

/** 获取当前的运行时源配置快照。 */
export function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null {
  return runtimeConfigSourceSnapshot;
}

function isCompatibleTopLevelRuntimeProjectionShape(params: {
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  const runtime = params.runtimeSnapshot as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return false;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    const runtimeType = Array.isArray(runtimeValue)
      ? "array"
      : runtimeValue === null
        ? "null"
        : typeof runtimeValue;
    const candidateType = Array.isArray(candidateValue)
      ? "array"
      : candidateValue === null
        ? "null"
        : typeof candidateValue;
    if (runtimeType !== candidateType) {
      return false;
    }
  }
  return true;
}

/**
 * 将一个配置对象的变更“投影”回源快照上。
 * 这用于在写入文件前，将基于运行时快照的变更应用回原始的、未解析的配置结构上。
 * @param config 发生了变更的配置对象。
 * @returns 应用了变更的源配置对象。
 */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  if (config === runtimeConfigSnapshot) {
    return runtimeConfigSourceSnapshot;
  }
  // 这种投影期望调用者传递从活动运行时快照派生的配置对象
  // （例如，带有目标编辑的浅/深克隆）。
  // 对于结构不相关的配置，跳过投影以避免意外的合并补丁删除或将解析的值重新引入源引用。
  if (
    !isCompatibleTopLevelRuntimeProjectionShape({
      runtimeSnapshot: runtimeConfigSnapshot,
      candidate: config,
    })
  ) {
    return config;
  }
  const runtimePatch = createMergePatch(runtimeConfigSnapshot, config);
  return coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot, runtimePatch));
}

/** 设置运行时配置快照的刷新处理器。 */
export function setRuntimeConfigSnapshotRefreshHandler(
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null,
): void {
  runtimeConfigSnapshotRefreshHandler = refreshHandler;
}

/**
 * 加载配置的全局快捷函数。
 * 会利用缓存和运行时快照。
 */
export function loadConfig(): OpenClawConfig {
  if (runtimeConfigSnapshot) {
    return runtimeConfigSnapshot;
  }
  const io = createConfigIO();
  const configPath = io.configPath;
  const now = Date.now();
  if (shouldUseConfigCache(process.env)) {
    const cached = configCache;
    if (cached && cached.configPath === configPath && cached.expiresAt > now) {
      return cached.config;
    }
  }
  const config = io.loadConfig();
  if (shouldUseConfigCache(process.env)) {
    const cacheMs = resolveConfigCacheMs(process.env);
    if (cacheMs > 0) {
      configCache = {
        configPath,
        expiresAt: now + cacheMs,
        config,
      };
    }
  }
  return config;
}

/**
 * 尽力读取配置。如果配置有效，则加载完整配置；如果无效，则返回快照中未经验证的配置对象。
 */
export async function readBestEffortConfig(): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  return snapshot.valid ? loadConfig() : snapshot.config;
}

/** 读取配置文件快照的全局快捷函数。 */
export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO().readConfigFileSnapshot();
}

/** 为写入操作读取配置文件快照的全局快捷函数。 */
export async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await createConfigIO().readConfigFileSnapshotForWrite();
}

/**
 * 写入配置文件的全局快捷函数。
 * 会处理运行时快照的投影和刷新。
 */
export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  const io = createConfigIO();
  let nextCfg = cfg;
  const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
  const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
  if (hadBothSnapshots) {
    // 如果存在运行时快照，则将变更应用到源快照上。
    const runtimePatch = createMergePatch(runtimeConfigSnapshot!, cfg);
    nextCfg = coerceConfig(applyMergePatch(runtimeConfigSourceSnapshot!, runtimePatch));
  }
  const sameConfigPath =
    options.expectedConfigPath === undefined || options.expectedConfigPath === io.configPath;
  await io.writeConfigFile(nextCfg, {
    envSnapshotForRestore: sameConfigPath ? options.envSnapshotForRestore : undefined,
    unsetPaths: options.unsetPaths,
  });
  // 写入后，如果存在刷新处理器，则调用它来更新运行时状态。
  const refreshHandler = runtimeConfigSnapshotRefreshHandler;
  if (refreshHandler) {
    try {
      const refreshed = await refreshHandler.refresh({ sourceConfig: nextCfg });
      if (refreshed) {
        return;
      }
    } catch (error) {
      try {
        refreshHandler.clearOnRefreshFailure?.();
      } catch {
        // 保留原始刷新失败作为表面错误。
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigRuntimeRefreshError(
        `Config was written to ${io.configPath}, but runtime snapshot refresh failed: ${detail}`,
        { cause: error },
      );
    }
  }
  if (hadBothSnapshots) {
    // 从磁盘原子地刷新两个快照，以便后续读取获得规范化配置，
    // 并且后续写入仍然可以获得秘密保留合并补丁（hadBothSnapshots 保持为 true）。
    const fresh = io.loadConfig();
    setRuntimeConfigSnapshot(fresh, nextCfg);
    return;
  }
  if (hadRuntimeSnapshot) {
    clearRuntimeConfigSnapshot();
  }
  // 当我们没有运行时快照时，让调用者从磁盘/缓存中读取，以便外部/手动
  // 对 openclaw.json 的编辑保持可见（没有过时的快照）。
}
