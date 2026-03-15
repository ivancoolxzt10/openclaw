// 本文件包含用于解析和构建“群组（group）”会话密钥的逻辑。
// 它的核心任务是从一个通用的消息上下文（`MsgContext`）中，
// 识别出这是一个群组聊天，并为该群组生成一个唯一的、规范化的会话密钥。

import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeHyphenSlug } from "../../shared/string-normalization.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

/**
 * 获取所有支持群组聊天的渠道/界面名称。
 */
const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

/**
 * 规范化群组标签，将其转换为一个连字符分隔的、URL友好的“slug”格式。
 * 例如，"My Cool Group" -> "my-cool-group"。
 */
function normalizeGroupLabel(raw?: string) {
  return normalizeHyphenSlug(raw);
}

/**
 * 如果群组ID太长，则将其缩短以便显示。
 * @param value - 原始ID字符串。
 * @returns 缩短后的ID，例如 "longid...1234"。
 */
function shortenGroupId(value?: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

/**
 * 为一个群组构建一个人类可读的、唯一的“显示名称”或标识符。
 * 它会智能地组合提供商、主题、频道名等信息来创建一个有意义的标签。
 * @param params - 包含群组上下文信息的对象。
 * @returns 格式化后的显示名称，例如 "discord:g-general"。
 */
export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = (params.provider?.trim().toLowerCase() || "group").trim();
  const groupChannel = params.groupChannel?.trim();
  const space = params.space?.trim();
  const subject = params.subject?.trim();
  // 尝试从各种字段中找到最有意义的细节作为标签
  const detail =
    (groupChannel && space
      ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}`
      : groupChannel || subject || space || "") || "";
  const fallbackId = params.id?.trim() || params.key;
  const rawLabel = detail || fallbackId;
  // 规范化标签
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    // 如果规范化失败（例如，标签只包含特殊字符），则先缩短再试一次
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  // 一些清理和格式化，例如确保它以 "g-" 开头
  if (!params.groupChannel && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

/**
 * 【主函数】从消息上下文中解析出群组会话密钥。
 *
 * @param ctx - 消息上下文对象。
 * @returns 如果这是一个群组消息，则返回一个包含规范化密钥和其组成部分的对象 (`GroupKeyResolution`)；否则返回 `null`。
 */
export function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  const chatType = ctx.ChatType?.trim().toLowerCase();
  const normalizedChatType =
    chatType === "channel" ? "channel" : chatType === "group" ? "group" : undefined;

  // 1. 【启发式判断】通过多种线索判断这是否是一个群组消息。
  const isWhatsAppGroupId = from.toLowerCase().endsWith("@g.us");
  const looksLikeGroup =
    normalizedChatType === "group" ||
    normalizedChatType === "channel" ||
    from.includes(":group:") ||
    from.includes(":channel:") ||
    isWhatsAppGroupId;
  if (!looksLikeGroup) {
    return null;
  }

  // 2. 确定提供商（provider）
  const providerHint = ctx.Provider?.trim().toLowerCase();
  const parts = from.split(":").filter(Boolean);
  const head = parts[0]?.trim().toLowerCase() ?? "";
  const headIsSurface = head ? getGroupSurfaces().has(head) : false;
  const provider = headIsSurface
    ? head
    : (providerHint ?? (isWhatsAppGroupId ? "whatsapp" : undefined));
  if (!provider) {
    return null;
  }

  // 3. 确定群组类型（kind），是 "group" 还是 "channel"
  const second = parts[1]?.trim().toLowerCase();
  const secondIsKind = second === "group" || second === "channel";
  const kind = secondIsKind
    ? second
    : from.includes(":channel:") || normalizedChatType === "channel"
      ? "channel"
      : "group";

  // 4. 提取群组的唯一 ID
  const id = headIsSurface
    ? secondIsKind
      ? parts.slice(2).join(":")
      : parts.slice(1).join(":")
    : from;
  const finalId = id.trim().toLowerCase();
  if (!finalId) {
    return null;
  }

  // 5. 组装成最终的规范化会话密钥并返回
  return {
    key: `${provider}:${kind}:${finalId}`, // 例如："whatsapp:group:1234567890@g.us"
    channel: provider,
    id: finalId,
    chatType: kind === "channel" ? "channel" : "group",
  };
}
