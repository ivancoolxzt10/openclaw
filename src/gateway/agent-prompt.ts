// 本文件的主要职责是根据一个结构化的对话历史，构建最终要发送给 AI 代理（agent）的
// 纯文本“提示（prompt）”。它将一系列的对话条目（`ConversationEntry`）
// 格式化成一个连贯的字符串。

import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

/**
 * 定义了一个对话条目的类型，它结合了角色（`role`）和历史条目（`entry`）本身。
 */
export type ConversationEntry = {
  role: "user" | "assistant" | "tool"; // 角色：用户、助手（AI）、或工具
  entry: HistoryEntry; // 包含发送者、消息体等信息的历史条目
};

/**
 * 将消息体（body）安全地转换为字符串。
 *
 * 消息体可能是一个简单的字符串，也可能是一个复杂的内容数组
 * (例如 `[{type:"text", text:"hello"}]`)。如果直接在模板字符串中使用后者，
 * 它会被序列化为 `[object Object]`。此函数旨在避免这种情况。
 *
 * @param body - 未知类型的消息体。
 * @returns 消息的纯文本表示。
 */
function safeBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  // 使用一个工具函数来尝试从复杂内容结构中提取文本。
  return extractTextFromChatContent(body) ?? "";
}

/**
 * 【主函数】根据一个对话条目数组，构建最终的代理消息（即提示）。
 * @param entries - 一个按时间顺序排列的对话条目数组。
 * @returns 一个包含了历史上下文和当前消息的、格式化后的字符串。
 */
export function buildAgentMessageFromConversationEntries(entries: ConversationEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  // 1. 【核心启发式逻辑】确定“当前消息”。
  //    我们从对话历史的末尾向前查找，将最后一个“用户”或“工具”的消息视为“当前消息”。
  //    这样做是为了确保代理总是对最新的信息（用户的提问或工具的输出）作出回应，
  //    而不是对自己上一条的输出作出回应。
  let currentIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const role = entries[i]?.role;
    if (role === "user" || role === "tool") {
      currentIndex = i;
      break;
    }
  }
  // 如果找不到用户或工具的消息（虽然不太可能），则默认使用最后一条消息。
  if (currentIndex < 0) {
    currentIndex = entries.length - 1;
  }

  const currentEntry = entries[currentIndex]?.entry;
  if (!currentEntry) {
    return "";
  }

  // 2. 将对话历史分为两部分：“历史”和“当前”。
  const historyEntries = entries.slice(0, currentIndex).map((e) => e.entry);
  
  // 如果没有历史记录，则只返回当前消息的内容。
  if (historyEntries.length === 0) {
    return safeBody(currentEntry.body);
  }

  // 3. 使用 `buildHistoryContextFromEntries` 辅助函数来将历史部分格式化成一个字符串。
  const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${safeBody(entry.body)}`;
  return buildHistoryContextFromEntries({
    entries: [...historyEntries, currentEntry],
    currentMessage: formatEntry(currentEntry),
    formatEntry,
  });
}
