// 本文件是会话密钥（sessionKey）解析的最终协调器。
// 它的职责是根据消息的完整上下文（`MsgContext`）和全局配置（如 `scope`），
// 计算出应该用于该消息的、唯一的、规范化的会话密钥。

import type { MsgContext } from "../../auto-reply/templating.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { normalizeE164 } from "../../utils.js";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";
import { resolveGroupSessionKey } from "./group.js";
import type { SessionScope } from "./types.js";

/**
 * 根据会话作用域（scope）派生一个“原始”的会话密钥。
 * @param scope - 会话作用域，可以是 "global" 或 "per-sender"。
 * @param ctx - 消息上下文。
 * @returns 派生出的原始会话密钥。
 */
export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
  // 1. 如果作用域是 "global"，所有消息共享同一个会话，密钥就是 "global"。
  if (scope === "global") {
    return "global";
  }

  // 2. 否则，是 "per-sender" 作用域。首先尝试将其解析为一个群组会话。
  const resolvedGroup = resolveGroupSessionKey(ctx);
  if (resolvedGroup) {
    // 如果是群组，则使用规范化的群组密钥。
    return resolvedGroup.key;
  }

  // 3. 如果不是群组（即为私聊/直接消息），则使用发送者的标识（经过 E.164 规范化的电话号码或地址）作为密钥。
  const from = ctx.From ? normalizeE164(ctx.From) : "";
  return from || "unknown";
}

/**
 * 【主函数】解析最终的、规范的会话密钥。
 *
 * 这个函数整合了所有逻辑，包括处理显式密钥、群组/私聊区分，以及会话作用域。
 *
 * @param scope - 会话作用域。
 * @param ctx - 消息上下文。
 * @param mainKey - （可选）在配置中定义的主会话的自定义名称。
 * @returns 最终的会话密钥字符串。
 */
export function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string) {
  // 1. 【最高优先级】检查上下文中是否明确提供了一个 `SessionKey`。
  //    如果提供了，则对其进行规范化并直接使用。这允许运行时覆盖默认行为。
  const explicit = ctx.SessionKey?.trim();
  if (explicit) {
    return normalizeExplicitSessionKey(explicit, ctx);
  }

  // 2. 如果没有明确的密钥，则派生一个“原始”密钥。
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") {
    return raw; // 对于全局作用域，直接返回 "global"
  }

  // 3. 【核心逻辑】区分私聊和群聊。
  const canonicalMainKey = normalizeMainKey(mainKey);
  // 为默认代理构建其“主会话”的密钥 (例如 "agent:main:main")
  const canonical = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey: canonicalMainKey,
  });

  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) {
    // a. 如果不是群组（是私聊），则 *忽略* 派生的原始密钥（即发送者地址），
    //    并强制所有私聊都使用同一个“主会话”密钥。
    //    这意味着默认情况下，所有与机器人的私聊都共享同一个对话上下文。
    return canonical;
  }
  // b. 如果是群组，则在派生的群组密钥前加上代理命名空间，以确保其全局唯一性。
  //    例如："whatsapp:group:123" -> "agent:main:whatsapp:group:123"
  return `agent:${DEFAULT_AGENT_ID}:${raw}`;
}
