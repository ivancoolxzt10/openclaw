// 本文件是用于解析所有与“会话（session）”相关的目录和文件路径的“唯一真实来源”。
// 它负责确定会话存储文件（`sessions.json`）和单个会话记录文件（transcripts）的位置。
// 一个关键特性是它支持多代理（multi-agent）设置，即每个代理都有其自己的会话子目录。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";

/**
 * 解析给定代理的会话目录。
 * 这是大多数其他路径解析函数的基础。
 * @param agentId - （可选）代理的ID。如果未提供，则使用默认代理ID。
 * @returns 目录的绝对路径，格式通常为 `~/.openclaw/agents/<agentId>/sessions`。
 */
function resolveAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const root = resolveStateDir(env, homedir); // 获取主状态目录 (例如 ~/.openclaw)
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

/**
 * 解析默认代理的会话记录（transcripts）目录。
 */
export function resolveSessionTranscriptsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

/**
 * 解析特定代理的会话记录目录。
 */
export function resolveSessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveAgentSessionsDir(agentId, env, homedir);
}

/**
 * 解析默认的会话存储文件 (`sessions.json`) 的路径。
 */
export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

export type SessionFilePathOptions = {
  agentId?: string;
  sessionsDir?: string;
};

// ...

// 用于验证会话ID格式是否安全的正则表达式。
// 只允许字母、数字、点、下划线和连字符。
export const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/**
 * 验证一个会话ID是否安全。
 * 如果ID包含无效字符（如路径分隔符 `\` 或 `/`），则抛出错误。
 * @param sessionId - 要验证的ID。
 * @returns 清理（trim）过的有效ID。
 */
export function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!SAFE_SESSION_ID_RE.test(trimmed)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

/**
 * 根据选项解析出最终的会话目录。
 */
function resolveSessionsDir(opts?: SessionFilePathOptions): string {
  const sessionsDir = opts?.sessionsDir?.trim();
  if (sessionsDir) {
    return path.resolve(sessionsDir);
  }
  return resolveAgentSessionsDir(opts?.agentId);
}

/**
 * 确保一个给定的候选路径位于会话目录之内。
 * 这是一个关键的安全函数，用于防止“路径遍历（Path Traversal）”攻击。
 * 它会解析符号链接，并确保最终的真实路径仍然在预期的会话目录内。
 * @param sessionsDir - 基础的会话目录。
 * @param candidate - 要检查的（可能是相对的）路径。
 * @returns 如果路径安全，则返回其绝对路径。
 * @throws {Error} 如果路径不安全（在会话目录之外）。
 */
function resolvePathWithinSessionsDir(
  sessionsDir: string,
  candidate: string,
  opts?: { agentId?: string },
): string {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error("Session file path must not be empty");
  }
  // ... 复杂的路径解析和安全检查逻辑 ...
  // 它处理绝对路径、相对路径以及 "../" 等情况
  const realBase = safeRealpathSync(path.resolve(sessionsDir)) ?? path.resolve(sessionsDir);
  // ...
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Session file path must be within sessions directory");
  }
  return path.resolve(realBase, normalized);
}

/**
 * 为给定的会话ID和可选的话题ID，在指定的目录中解析出会话记录文件的路径。
 * @param sessionId - 会话ID。
 * @param sessionsDir - 会话目录。
 * @param topicId - (可选) 话题ID。
 * @returns 会话记录文件（.jsonl）的完整路径。
 */
export function resolveSessionTranscriptPathInDir(
  sessionId: string,
  sessionsDir: string,
  topicId?: string | number,
): string {
  const safeSessionId = validateSessionId(sessionId);
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  // 文件名格式：<sessionId>.jsonl 或 <sessionId>-topic-<topicId>.jsonl
  const fileName =
    safeTopicId !== undefined
      ? `${safeSessionId}-topic-${safeTopicId}.jsonl`
      : `${safeSessionId}.jsonl`;
  return resolvePathWithinSessionsDir(sessionsDir, fileName);
}

/**
 * 【核心】解析给定会话的记录文件（transcript）的最终路径。
 *
 * @param sessionId - 会话ID。
 * @param entry - （可选）来自 `sessions.json` 的会话条目。
 * @param opts - （可选）包含 `agentId` 或 `sessionsDir` 的选项。
 * @returns 会话记录文件的绝对路径。
 */
export function resolveSessionFilePath(
  sessionId: string,
  entry?: { sessionFile?: string },
  opts?: SessionFilePathOptions,
): string {
  const sessionsDir = resolveSessionsDir(opts);
  // 1. 【优先】检查会话条目中是否有一个明确的 `sessionFile` 字段。
  //    这主要用于向后兼容或特殊情况。
  const candidate = entry?.sessionFile?.trim();
  if (candidate) {
    try {
      // 如果存在，则使用它，但必须通过安全检查
      return resolvePathWithinSessionsDir(sessionsDir, candidate, { agentId: opts?.agentId });
    } catch {
      // 如果路径无效或不安全，则忽略它并回退到标准方法
    }
  }
  // 2. 【回退】如果没有 `sessionFile` 字段，则根据会话ID生成一个标准的路径。
  return resolveSessionTranscriptPathInDir(sessionId, sessionsDir);
}

/**
 * 解析主会话存储文件 (`sessions.json`) 的路径。
 * 它支持在配置的路径中使用 `{agentId}` 占位符。
 * @param store - （可选）在 `config.session.store` 中配置的路径。
 * @param opts - （可选）包含 `agentId` 的选项。
 * @returns `sessions.json` 的绝对路径。
 */
export function resolveStorePath(
  store?: string,
  opts?: { agentId?: string; env?: NodeJS.ProcessEnv },
) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  // ...
  // 如果路径中包含 "{agentId}"，则替换它
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    // ... 处理 `~` 前缀
    return path.resolve(expanded);
  }
  // ...
  return path.resolve(store);
}
// ...
