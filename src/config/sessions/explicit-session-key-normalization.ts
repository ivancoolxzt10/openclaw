// 本文件实现了一个“显式会话密钥规范化”的分发器。
//
// "会话密钥（sessionKey）" 是一个唯一标识对话的字符串。
// "显式" 意味着这个密钥是由用户或其他工具直接提供的（例如，通过一个命令），
// 而不是从一个收到的消息中自动生成的。
// "规范化" 意味着将一个可能格式不统一的密钥（例如，可能只是一个频道ID）
// 转换为一个标准的、内部一致的格式（例如，`discord:channel:12345`）。
//
// 本模块的核心职责是：根据上下文（例如，消息来自哪个提供商），
// 查找并调用特定于该提供商的规范化函数。

import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeExplicitDiscordSessionKey } from "../../discord/session-key-normalization.js";

/**
 * 定义了一个“显式会话密钥规范化器”函数的类型。
 * 它接收一个会话密钥和消息上下文，并返回一个规范化后的新密钥。
 */
type ExplicitSessionKeyNormalizer = (sessionKey: string, ctx: MsgContext) => string;

/**
 * 定义了规范化器注册表中的一个条目。
 */
type ExplicitSessionKeyNormalizerEntry = {
  provider: string; // 提供商的名称 (例如 "discord")
  normalize: ExplicitSessionKeyNormalizer; // 实际的规范化函数
  /**
   * 一个“匹配器”函数。它使用启发式规则来判断给定的上下文是否与此提供商匹配。
   */
  matches: (params: {
    sessionKey: string;
    provider?: string;
    surface?: string;
    from: string;
  }) => boolean;
};

/**
 * 一个规范化器的“注册表”。
 * 这是一个数组，其中包含了所有可用的、特定于提供商的规范化逻辑。
 * 要添加对新提供商的支持，只需在此处添加一个新的条目。
 */
const EXPLICIT_SESSION_KEY_NORMALIZERS: ExplicitSessionKeyNormalizerEntry[] = [
  // 为 "discord" 提供商注册一个规范化器。
  {
    provider: "discord",
    normalize: normalizeExplicitDiscordSessionKey, // 使用从 discord 模块导入的专用函数
    matches: ({ sessionKey, provider, surface, from }) =>
      // 匹配规则：如果上下文中的任何一个线索表明这是 Discord，则匹配成功。
      surface === "discord" ||
      provider === "discord" ||
      from.startsWith("discord:") ||
      sessionKey.startsWith("discord:") ||
      sessionKey.includes(":discord:"),
  },
];

/**
 * 根据给定的消息上下文，解析并返回正确的规范化函数。
 * @param sessionKey - 用户提供的原始会话密钥。
 * @param ctx - 消息上下文，包含了 `Provider`, `Surface` 等信息。
 * @returns 如果找到匹配的规范化器，则返回其 `normalize` 函数；否则返回 `undefined`。
 */
function resolveExplicitSessionKeyNormalizer(
  sessionKey: string,
  ctx: Pick<MsgContext, "From" | "Provider" | "Surface">,
): ExplicitSessionKeyNormalizer | undefined {
  const normalizedProvider = ctx.Provider?.trim().toLowerCase();
  const normalizedSurface = ctx.Surface?.trim().toLowerCase();
  const normalizedFrom = (ctx.From ?? "").trim().toLowerCase();
  
  // 遍历注册表，使用每个条目的 `matches` 函数进行检查
  return EXPLICIT_SESSION_KEY_NORMALIZERS.find((entry) =>
    entry.matches({
      sessionKey,
      provider: normalizedProvider,
      surface: normalizedSurface,
      from: normalizedFrom,
    }),
  )?.normalize;
}

/**
 * 【主函数】规范化一个显式的会话密钥。
 * 这是本模块导出的主要入口点。
 *
 * @param sessionKey - 用户或工具提供的原始会话密钥。
 * @param ctx - 触发此操作的消息的完整上下文。
 * @returns 规范化后的会话密钥。如果找不到特定的规范化器，则返回经过基本清理（小写、去空格）的原始密钥。
 */
export function normalizeExplicitSessionKey(sessionKey: string, ctx: MsgContext): string {
  // 1. 对输入进行基本的清理
  const normalized = sessionKey.trim().toLowerCase();
  
  // 2. 根据上下文查找合适的规范化函数
  const normalize = resolveExplicitSessionKeyNormalizer(normalized, ctx);
  
  // 3. 如果找到，则调用它；否则，返回基本的规范化结果。
  return normalize ? normalize(normalized, ctx) : normalized;
}
