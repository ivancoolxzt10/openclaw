// 本文件包含用于派生和更新会话元数据（metadata）的逻辑。
// “元数据”是指关于会-话的描述性信息，例如它的来源（origin）、是否是群聊、
// 以及群聊的主题、显示名称等。这些信息对于在UI中正确显示会话、
// 以及路由回复至关重要。

import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveConversationLabel } from "../../channels/conversation-label.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { buildGroupDisplayName, resolveGroupSessionKey } from "./group.js";
import type { GroupKeyResolution, SessionEntry, SessionOrigin } from "./types.js";

/**
 * 一个辅助函数，用于安全地合并两个“来源（origin）”对象。
 * 它会优先使用 `next` 对象中的字段来覆盖 `existing` 对象中的字段。
 * @param existing - 已有的来源对象。
 * @param next - 新的来源对象。
 * @returns 合并后的新来源对象，如果两者都为空，则返回 `undefined`。
 */
const mergeOrigin = (
  existing: SessionOrigin | undefined,
  next: SessionOrigin | undefined,
): SessionOrigin | undefined => {
  if (!existing && !next) {
    return undefined;
  }
  const merged: SessionOrigin = existing ? { ...existing } : {};
  if (next?.label) {
    merged.label = next.label;
  }
  // ... 为 origin 的每个字段进行合并 ...
  if (next?.threadId != null && next.threadId !== "") {
    merged.threadId = next.threadId;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

/**
 * 从一个消息上下文（`MsgContext`）中派生出会话的“来源（origin）”信息。
 * “来源”对象捕获了消息来自何处的完整上下文。
 * @param ctx - 消息上下文。
 * @returns 一个 `SessionOrigin` 对象，如果无法派生任何信息，则返回 `undefined`。
 */
export function deriveSessionOrigin(ctx: MsgContext): SessionOrigin | undefined {
  // 从上下文中提取各种相关字段
  const label = resolveConversationLabel(ctx)?.trim();
  const providerRaw =
    (typeof ctx.OriginatingChannel === "string" && ctx.OriginatingChannel) ||
    ctx.Surface ||
    ctx.Provider;
  const provider = normalizeMessageChannel(providerRaw);
  const surface = ctx.Surface?.trim().toLowerCase();
  const chatType = normalizeChatType(ctx.ChatType) ?? undefined;
  const from = ctx.From?.trim();
  const to =
    (typeof ctx.OriginatingTo === "string" ? ctx.OriginatingTo : ctx.To)?.trim() ?? undefined;
  const accountId = ctx.AccountId?.trim();
  const threadId = ctx.MessageThreadId ?? undefined;

  // 将所有有效字段组装成一个 origin 对象
  const origin: SessionOrigin = {};
  if (label) {
    origin.label = label;
  }
  // ...
  if (threadId != null && threadId !== "") {
    origin.threadId = threadId;
  }

  return Object.keys(origin).length > 0 ? origin : undefined;
}

/**
 * 从一个会话条目（`SessionEntry`）中安全地创建一个其 `origin` 信息的快照（深拷贝）。
 * @param entry - 会话条目。
 * @returns 一个 `origin` 对象的拷贝，如果不存在，则返回 `undefined`。
 */
export function snapshotSessionOrigin(entry?: SessionEntry): SessionOrigin | undefined {
  if (!entry?.origin) {
    return undefined;
  }
  return { ...entry.origin };
}

/**
 * 派生一个用于更新“群组会话”元数据的“补丁（patch）”对象。
 * “补丁”是一个部分 `SessionEntry` 对象，只包含需要被更新的字段。
 * @param params - 包含上下文、会话密钥和可选的现有会话条目等信息的对象。
 * @returns 一个部分 `SessionEntry` 对象，如果不是群组会话，则返回 `null`。
 */
export function deriveGroupSessionPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  // 1. 解析群组会话密钥，如果不是群组会话则提前退出
  const resolution = params.groupResolution ?? resolveGroupSessionKey(params.ctx);
  if (!resolution?.channel) {
    return null;
  }

  const channel = resolution.channel;
  // 2. 从上下文中提取群组相关的各种名称和ID
  const subject = params.ctx.GroupSubject?.trim();
  const space = params.ctx.GroupSpace?.trim();
  const explicitChannel = params.ctx.GroupChannel?.trim();
  // ...
  const nextGroupChannel = /* ... */;
  const nextSubject = nextGroupChannel ? undefined : subject;

  // 3. 构建补丁对象
  const patch: Partial<SessionEntry> = {
    chatType: resolution.chatType ?? "group",
    channel,
    groupId: resolution.id,
  };
  if (nextSubject) {
    patch.subject = nextSubject;
  }
  // ...

  // 4. 为这个群组构建一个易于识别的显示名称
  const displayName = buildGroupDisplayName({
    provider: channel,
    subject: nextSubject ?? params.existing?.subject,
    groupChannel: nextGroupChannel ?? params.existing?.groupChannel,
    space: space ?? params.existing?.space,
    id: resolution.id,
    key: params.sessionKey,
  });
  if (displayName) {
    patch.displayName = displayName;
  }

  return patch;
}

/**
 * 【主函数】派生用于更新一个会话的完整元数据补丁。
 * 它会组合“群组补丁”和“来源补丁”。
 * @param params - 包含完整上下文信息的对象。
 * @returns 一个包含了所有需要更新的元数据字段的“补丁”对象，如果无需更新，则返回 `null`。
 */
export function deriveSessionMetaPatch(params: {
  ctx: MsgContext;
  sessionKey: string;
  existing?: SessionEntry;
  groupResolution?: GroupKeyResolution | null;
}): Partial<SessionEntry> | null {
  // 1. 获取群组相关的元数据补丁
  const groupPatch = deriveGroupSessionPatch(params);
  // 2. 获取来源相关的元数据
  const origin = deriveSessionOrigin(params.ctx);
  if (!groupPatch && !origin) {
    return null;
  }

  const patch: Partial<SessionEntry> = groupPatch ? { ...groupPatch } : {};
  // 3. 将新的来源信息与已有的来源信息合并
  const mergedOrigin = mergeOrigin(params.existing?.origin, origin);
  if (mergedOrigin) {
    patch.origin = mergedOrigin;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
