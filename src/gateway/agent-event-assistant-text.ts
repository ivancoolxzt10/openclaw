// 本文件包含一个单一的、小型的实用工具函数，
// 其目的是从一个“代理事件（AgentEventPayload）”中可靠地提取出文本内容。

import type { AgentEventPayload } from "../infra/agent-events.js";

/**
 * 从一个代理事件中解析出助手（assistant）的“流式增量（stream delta）”文本。
 *
 * 在流式输出中，文本更新可能以不同的形式出现。这个函数旨在优雅地处理两种常见情况：
 * 1. 增量更新（`delta`）: 只包含最新的一小段文本。
 * 2. 全量更新（`text`）: 包含到目前为止的完整文本块。
 *
 * @param evt - 从代理发出的事件负载。
 * @returns 提取出的文本字符串。如果两个字段都无效，则返回一个空字符串以确保安全。
 */
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  // 优先使用 `delta` 字段，如果它是一个字符串的话。
  // 否则，回退到使用 `text` 字段。
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
