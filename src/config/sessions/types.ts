// 本文件是所有与“会话（session）”相关的数据结构的 TypeScript 类型定义中心。
// 它定义了 `SessionEntry` 的形状，这是存储在 `sessions.json` 中的核心对象，
// 以及处理这些数据结构的各种辅助类型和函数。

import crypto from "node:crypto";
import type { Skill } from "@mariozechner/pi-coding-agent";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { TtsAutoMode } from "../types.tts.js";

/**
 * 会话的作用域。
 * - `per-sender`: 每个发送者都有自己独立的会话。
 * - `global`: 所有用户共享同一个全局会话。
 */
export type SessionScope = "per-sender" | "global";

export type SessionChannelId = ChannelId | "webchat";

export type SessionChatType = ChatType;

/**
 * 描述一个会话的“来源（origin）”。
 * 包含了关于这个会话是从哪里开始的所有上下文信息。
 */
export type SessionOrigin = {
  label?: string;      // 对话的标签 (例如，群名或用户名)
  provider?: string;   // 提供商 (例如, "discord", "slack")
  surface?: string;    // 界面 (通常与 provider 相同)
  chatType?: SessionChatType; // 聊天类型 ('direct', 'group', 'channel')
  from?: string;       // 发送者ID
  to?: string;         // 接收者ID
  accountId?: string;  // 使用的账户ID
  threadId?: string | number; // 话题ID
};

// ... 其他与 ACP (Agent-Command Protocol) 相关的类型定义 ...
export type SessionAcpIdentity = { /* ... */ };
export type SessionAcpMeta = { /* ... */ };
export type AcpSessionRuntimeOptions = { /* ... */ };

/**
 * 【核心类型】会话条目（Session Entry）。
 * 这是存储在 `sessions.json` 中的主要对象，代表一个独立的对话上下文。
 */
export type SessionEntry = {
  // --- 核心标识符和状态 ---
  sessionId: string; // 一个全局唯一的会话 UUID
  updatedAt: number; // 最后一次更新此条目的时间戳（毫秒）
  sessionFile?: string; // 指向该会话聊天记录文件（.jsonl）的路径

  // --- 父子会话（Spawn）相关字段 ---
  spawnedBy?: string; // 创建此会话的父会话的密钥
  spawnedWorkspaceDir?: string; // 继承自父会话的工作区目录
  forkedFromParent?: boolean; // 标记此话题会话是否已从其父会话的记录中“分叉”出来
  spawnDepth?: number; // 子会话的派生深度

  // --- 中止（Abort）状态 ---
  abortedLastRun?: boolean; // 上一次运行是否被中止
  abortCutoffMessageSid?: string; // `/stop` 命令发生时的消息ID，用于忽略此消息之前的积压消息
  
  // --- 运行时覆盖（Runtime Overrides）---
  // 这些字段允许用户通过命令（如 `/set`）临时覆盖全局配置，仅对当前会话有效。
  thinkingLevel?: string;
  ttsAuto?: TtsAutoMode;
  // ... 其他运行时覆盖字段 ...
  providerOverride?: string;
  modelOverride?: string;
  authProfileOverride?: string;
  
  // --- 群聊特定字段 ---
  chatType?: SessionChatType;
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  
  // --- 显示与元数据 ---
  label?: string; // 对话的显示标签（已弃用，请使用 displayName）
  displayName?: string; // 在UI中显示的名称
  origin?: SessionOrigin; // 会话来源的详细信息

  // --- 投递（Delivery）与路由 ---
  // 用于确定如何将消息发送回用户
  deliveryContext?: DeliveryContext; // 完整的投递上下文（channel, to, accountId, threadId）
  lastChannel?: SessionChannelId; // 最后一次交互的渠道
  lastTo?: string; // 最后一次交互的接收者
  lastAccountId?: string; // 最后一次交互的账户
  lastThreadId?: string | number; // 最后一次交互的话题

  // ... 其他用于内部状态管理的字段 ...
};

/**
 * 规范化会话条目中的模型相关字段。
 * 确保 `model` 和 `modelProvider` 字段要么都有效，要么都为 undefined。
 */
function normalizeRuntimeField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  // ... 实现细节：清理和同步 model 和 modelProvider 字段 ...
}

/**
 * 设置会话的运行时模型。
 */
export function setSessionRuntimeModel(
  entry: SessionEntry,
  runtime: { provider: string; model: string },
): boolean {
  // ...
}


/**
 * 【核心辅助函数】合并一个“补丁（patch）”对象到一个已有的会话条目中。
 * @param existing - 已有的会话条目。
 * @param patch - 一个只包含要更改的字段的部分 `SessionEntry` 对象。
 * @param options - 合并策略选项。
 * @returns 一个新的、合并后的 `SessionEntry` 对象。
 */
export function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  // 如果是新条目，则生成一个新的 sessionId
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  
  // 【关键逻辑】根据策略决定如何更新 `updatedAt` 时间戳
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  
  if (!existing) {
    return normalizeSessionRuntimeModelFields({ ...patch, sessionId, updatedAt });
  }
  
  const next = { ...existing, ...patch, sessionId, updatedAt };

  // ... 处理模型字段更新时的特殊逻辑 ...
  
  return normalizeSessionRuntimeModelFields(next);
}

/**
 * `mergeSessionEntryWithPolicy` 的一个包装器，使用默认的“触摸活动”策略。
 * 这意味着每次合并都会更新 `updatedAt` 时间戳。
 */
export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch);
}

/**
 * `mergeSessionEntryWithPolicy` 的一个包装器，使用“保留活动”策略。
 * 只有在补丁本身或现有条目中明确包含 `updatedAt` 时，才会更新时间戳。
 * 这对于那些不应被视为“用户活动”的元数据更新（例如，从 `/who` 命令更新 `displayName`）非常重要，
 * 因为它避免了错误地重置“闲置计时器”。
 */
export function mergeSessionEntryPreserveActivity(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch, {
    policy: "preserve-activity",
  });
}

// ... 其他类型定义和默认常量 ...
export type GroupKeyResolution = { /* ... */ };
export type SessionSkillSnapshot = { /* ... */ };
export type SessionSystemPromptReport = { /* ... */ };

export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_IDLE_MINUTES = 60;
