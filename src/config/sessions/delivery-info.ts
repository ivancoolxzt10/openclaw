// 本文件提供用于从“会话密钥（sessionKey）”中提取“投递信息（delivery info）”的实用函数。
// “投递信息”是指机器人需要将消息发送回何处的所有上下文，例如渠道、接收者、账户和话题ID。
// 这里的逻辑对于确保机器人能够正确地在对话中进行回复至关重要。

import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";

/**
 * 从会话密钥（sessionKey）中解析出“基础会话密钥”和“话题ID（threadId）”。
 *
 * 会话密钥的格式通常是 `baseSessionKey` 或 `baseSessionKey:thread:someThreadId`。
 * 此函数旨在将这两部分分离开来。
 *
 * 它支持两种标记：
 * - `:thread:` (用于大多数渠道)
 * - `:topic:` (专用于 Telegram)
 *
 * @param sessionKey - 要解析的完整会话密钥。
 * @returns 一个包含 `baseSessionKey` 和 `threadId` 的对象。如果不存在，则相应字段为 `undefined`。
 */
export function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  if (!sessionKey) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  // 查找 :topic: 和 :thread: 标记的位置
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? ":topic:" : ":thread:";

  // 根据标记位置分割字符串
  const baseSessionKey = markerIndex === -1 ? sessionKey : sessionKey.slice(0, markerIndex);
  const threadIdRaw =
    markerIndex === -1 ? undefined : sessionKey.slice(markerIndex + marker.length);
  
  // 清理并返回结果
  const threadId = threadIdRaw?.trim() || undefined;
  return { baseSessionKey, threadId };
}

/**
 * 【主函数】从会话密钥（sessionKey）中提取完整的投递信息。
 *
 * 这个函数不仅解析 `threadId`，还会从持久化的会话存储（`sessions.json`）中
 * 加载与该会话关联的 `deliveryContext`（投递上下文）。
 *
 * @param sessionKey - 要提取信息的完整会话密钥。
 * @returns 一个包含 `deliveryContext` 和 `threadId` 的对象。
 */
export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  threadId: string | undefined;
} {
  // 1. 首先，解析出会话密钥中的 `baseSessionKey` 和 `threadId`。
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  try {
    // 2. 加载配置和会话存储文件 (`sessions.json`)。
    //    这是一个 I/O 操作，因此将其包裹在 try...catch 中，作为一种“尽力而为”的尝试。
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);

    // 3. 尝试使用完整的会话密钥（包含 threadId）在存储中查找会话条目。
    let entry = store[sessionKey];
    // 4. 【回退逻辑】如果使用完整密钥找不到 `deliveryContext`，
    //    则尝试使用“基础会话密钥”（不含 threadId）再次查找。
    //    这在话题（thread）是后来才创建的情况下非常有用。
    if (!entry?.deliveryContext && baseSessionKey !== sessionKey) {
      entry = store[baseSessionKey];
    }
    
    // 5. 如果找到了有效的上下文，则提取所需字段。
    if (entry?.deliveryContext) {
      deliveryContext = {
        channel: entry.deliveryContext.channel,
        to: entry.deliveryContext.to,
        accountId: entry.deliveryContext.accountId,
      };
    }
  } catch {
    // 忽略错误：这是一个尽力而为的操作。如果无法加载存储或解析失败，
    // 只会返回空的 `deliveryContext`，而不会使整个应用程序崩溃。
  }
  return { deliveryContext, threadId };
}
