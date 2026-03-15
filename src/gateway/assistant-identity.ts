// 本文件负责解析和确定助手的“身份（Identity）”。
// “身份”是指助手在用户界面中显示的名称、头像和可选的 Emoji。
//
// **核心逻辑**:
// 它实现了一个分层的、有优先级的查找策略，从多个可能的配置源中确定最终的身份信息。
// 这种方法提供了高度的灵活性，允许用户在不同级别上定制助手的“外观”。

import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import { loadAgentIdentity } from "../commands/agents.config.js";
import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { coerceIdentityValue } from "../shared/assistant-identity-values.js";
import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

// 定义身份字段的最大长度常量
const MAX_ASSISTANT_NAME = 50;
const MAX_ASSISTANT_AVATAR = 200;
const MAX_ASSISTANT_EMOJI = 16;

/**
 * 如果所有其他配置源都没有提供信息，则使用这个硬编码的默认身份。
 */
export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = {
  agentId: "main",
  name: "Assistant",
  avatar: "A",
};

/**
 * 助手的身份信息的数据结构。
 */
export type AssistantIdentity = {
  agentId: string; // 代理的ID
  name: string;    // 显示名称
  avatar: string;  // 头像（可以是 URL, Data URL, 路径, 或短文本/Emoji）
  emoji?: string;  // 可选的 Emoji 字符
};

/**
 * 检查一个值是否是 HTTP 或 Data URL。
 */
function isAvatarUrl(value: string): boolean {
  return isAvatarHttpUrl(value) || isAvatarImageDataUrl(value);
}

/**
 * 规范化并验证一个值是否可以作为有效的“头像”。
 * @returns 如果值是有效的 URL、路径或短文本，则返回该值；否则返回 `undefined`。
 */
function normalizeAvatarValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  
  // 1. 如果是 URL，有效。
  if (isAvatarUrl(trimmed)) return trimmed;
  // 2. 如果看起来像文件路径，有效。
  if (looksLikeAvatarPath(trimmed)) return trimmed;
  // 3. 如果是一个没有空格的短字符串（长度<=4），也有效（可用作姓名缩写或简单的 Emoji）。
  if (!/\s/.test(trimmed) && trimmed.length <= 4) return trimmed;
  
  return undefined;
}

/**
 * 规范化并验证一个值是否可以作为有效的“Emoji”。
 * @returns 如果值是有效的 Emoji 字符串，则返回该值；否则返回 `undefined`。
 */
function normalizeEmojiValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ASSISTANT_EMOJI) return undefined;
  
  // 启发式规则：一个有效的 Emoji 应该包含非 ASCII 字符。
  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return undefined;

  // 同时，它不应该看起来像一个 URL 或路径。
  if (isAvatarUrl(trimmed) || looksLikeAvatarPath(trimmed)) return undefined;
  
  return trimmed;
}

/**
 * 【主函数】解析给定代理的最终生效的助手身份。
 *
 * @param params - 包含全局配置和要解析的代理ID等信息的对象。
 * @returns 一个完整的 `AssistantIdentity` 对象。
 */
export function resolveAssistantIdentity(params: {
  cfg: OpenClawConfig;
  agentId?: string | null;
  workspaceDir?: string | null;
}): AssistantIdentity {
  const agentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(params.cfg));
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, agentId);

  // --- 数据源 ---
  // 1. 全局 UI 配置 (`openclaw.json` 中的 `ui.assistant`)
  const configAssistant = params.cfg.ui?.assistant;
  // 2. 代理特定配置 (`openclaw.json` 中的 `agents.list[].identity`)
  const agentIdentity = resolveAgentIdentity(params.cfg, agentId);
  // 3. 代理工作区中的 `identity.json` 文件
  const fileIdentity = workspaceDir ? loadAgentIdentity(workspaceDir) : null;

  // --- 分层查找逻辑 ---
  // 对于每个身份字段（name, avatar, emoji），都遵循从最具体到最通用的查找顺序。
  
  // 1. 解析名称 (Name)
  // 查找顺序: 全局配置 -> 代理配置 -> 文件配置 -> 默认值
  const name =
    coerceIdentityValue(configAssistant?.name, MAX_ASSISTANT_NAME) ??
    coerceIdentityValue(agentIdentity?.name, MAX_ASSISTANT_NAME) ??
    coerceIdentityValue(fileIdentity?.name, MAX_ASSISTANT_NAME) ??
    DEFAULT_ASSISTANT_IDENTITY.name;

  // 2. 解析头像 (Avatar)
  // 查找顺序: 全局配置 -> 代理配置(avatar) -> 代理配置(emoji) -> 文件配置(avatar) -> 文件配置(emoji) -> 默认值
  const avatarCandidates = [
    coerceIdentityValue(configAssistant?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_AVATAR),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_AVATAR),
  ];
  // 找到第一个有效的头像值
  const avatar =
    avatarCandidates.map((candidate) => normalizeAvatarValue(candidate)).find(Boolean) ??
    DEFAULT_ASSISTANT_IDENTITY.avatar;

  // 3. 解析 Emoji
  // 查找顺序: 代理配置(emoji) -> 文件配置(emoji) -> 代理配置(avatar) -> 文件配置(avatar)
  const emojiCandidates = [
    coerceIdentityValue(agentIdentity?.emoji, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(fileIdentity?.emoji, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(agentIdentity?.avatar, MAX_ASSISTANT_EMOJI),
    coerceIdentityValue(fileIdentity?.avatar, MAX_ASSISTANT_EMOJI),
  ];
  // 找到第一个有效的 Emoji 值
  const emoji = emojiCandidates.map((candidate) => normalizeEmojiValue(candidate)).find(Boolean);

  // 4. 组装并返回最终的身份对象
  return { agentId, name, avatar, emoji };
}
