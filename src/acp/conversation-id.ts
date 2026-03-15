/**
 * Telegram会话ID处理工具
 * 
 * 功能概述：
 * 提供Telegram聊天和话题的会话ID解析、构建和规范化功能
 * 
 * 主要功能：
 * 1. 解析Telegram聊天ID
 * 2. 构建和解析Telegram话题会话ID
 * 3. 规范化会话文本
 * 
 * 会话ID格式：
 * - 普通聊天: telegram:<chatId>
 * - 话题聊天: <chatId>:topic:<topicId>
 */

/**
 * 解析后的Telegram话题会话信息
 * 
 * @property chatId - Telegram聊天ID（可以是负数，表示群组）
 * @property topicId - 话题ID（正整数）
 * @property canonicalConversationId - 规范化的会话ID，格式为 <chatId>:topic:<topicId>
 */
export type ParsedTelegramTopicConversation = {
  chatId: string; // Telegram聊天ID
  topicId: string; // 话题ID
  canonicalConversationId: string; // 规范化的会话ID
};

/**
 * 规范化会话文本
 * 将各种类型的值转换为规范化的字符串
 * 
 * @param value - 要规范化的值，可以是字符串、数字、bigint或布尔值
 * @returns 规范化后的字符串（去除首尾空格），如果无法转换则返回空字符串
 * 
 * 转换规则：
 * - 字符串：直接去除首尾空格
 * - 数字/bigint/布尔值：转换为字符串后去除首尾空格
 * - 其他类型：返回空字符串
 */
export function normalizeConversationText(value: unknown): string {
  // 如果是字符串，直接去除首尾空格
  if (typeof value === "string") {
    return value.trim();
  }
  // 如果是数字、bigint或布尔值，转换为字符串后去除首尾空格
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  // 其他类型返回空字符串
  return "";
}

/**
 * 从目标值中解析Telegram聊天ID
 * 
 * @param raw - 原始值，可以是字符串、数字等
 * @returns Telegram聊天ID，解析失败则返回undefined
 * 
 * 解析规则：
 * - 输入格式必须是: telegram:<chatId>
 * - chatId必须是整数（可以是负数，表示群组）
 * 
 * 示例：
 * - "telegram:123456" -> "123456"
 * - "telegram:-100123456" -> "-100123456"
 * - "invalid" -> undefined
 */
export function parseTelegramChatIdFromTarget(raw: unknown): string | undefined {
  // 规范化输入文本
  const text = normalizeConversationText(raw);
  // 如果文本为空，返回undefined
  if (!text) {
    return undefined;
  }
  // 匹配格式: telegram:<chatId>，其中chatId可以是负数
  const match = text.match(/^telegram:(-?\d+)$/);
  // 如果匹配失败，返回undefined
  if (!match?.[1]) {
    return undefined;
  }
  // 返回提取的聊天ID
  return match[1];
}

/**
 * 构建Telegram话题会话ID
 * 
 * @param params - 构建参数
 * @param params.chatId - Telegram聊天ID（可以是负数）
 * @param params.topicId - 话题ID（必须是正整数）
 * @returns 规范化的会话ID，格式为 <chatId>:topic:<topicId>，验证失败则返回null
 * 
 * 验证规则：
 * - chatId必须是整数（可以是负数）
 * - topicId必须是正整数
 * 
 * 示例：
 * - {chatId: "123456", topicId: "789"} -> "123456:topic:789"
 * - {chatId: "-100123456", topicId: "789"} -> "-100123456:topic:789"
 * - {chatId: "abc", topicId: "789"} -> null
 */
export function buildTelegramTopicConversationId(params: {
  chatId: string;
  topicId: string;
}): string | null {
  // 去除首尾空格
  const chatId = params.chatId.trim();
  const topicId = params.topicId.trim();
  // 验证chatId必须是整数（可以是负数）
  // 验证topicId必须是正整数
  if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(topicId)) {
    return null;
  }
  // 构建并返回规范化的会话ID
  return `${chatId}:topic:${topicId}`;
}

/**
 * 解析Telegram话题会话ID
 * 支持两种格式：
 * 1. 完整格式: <chatId>:topic:<topicId>
 * 2. 简化格式: <topicId>（需要提供parentConversationId）
 * 
 * @param params - 解析参数
 * @param params.conversationId - 会话ID（完整格式或简化格式）
 * @param params.parentConversationId - 父会话ID（仅在使用简化格式时需要）
 * @returns 解析后的会话信息，解析失败则返回null
 * 
 * 示例：
 * - {conversationId: "123456:topic:789"} -> {chatId: "123456", topicId: "789", canonicalConversationId: "123456:topic:789"}
 * - {conversationId: "789", parentConversationId: "123456"} -> {chatId: "123456", topicId: "789", canonicalConversationId: "123456:topic:789"}
 */
export function parseTelegramTopicConversation(params: {
  conversationId: string;
  parentConversationId?: string;
}): ParsedTelegramTopicConversation | null {
  const conversation = params.conversationId.trim();
  const directMatch = conversation.match(/^(-?\d+):topic:(\d+)$/);
  if (directMatch?.[1] && directMatch[2]) {
    const canonicalConversationId = buildTelegramTopicConversationId({
      chatId: directMatch[1],
      topicId: directMatch[2],
    });
    if (!canonicalConversationId) {
      return null;
    }
    return {
      chatId: directMatch[1],
      topicId: directMatch[2],
      canonicalConversationId,
    };
  }
  if (!/^\d+$/.test(conversation)) {
    return null;
  }
  const parent = params.parentConversationId?.trim();
  if (!parent || !/^-?\d+$/.test(parent)) {
    return null;
  }
  const canonicalConversationId = buildTelegramTopicConversationId({
    chatId: parent,
    topicId: conversation,
  });
  if (!canonicalConversationId) {
    return null;
  }
  return {
    chatId: parent,
    topicId: conversation,
    canonicalConversationId,
  };
}
