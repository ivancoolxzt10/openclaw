// 导入Node.js文件系统模块，用于文件操作
import fs from "node:fs";
// 导入Node.js路径模块，用于路径处理
import path from "node:path";
// 导入会话版本常量
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
// 导入会话代理ID解析函数
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
// 导入思考模式默认值解析函数
import { resolveThinkingDefault } from "../../agents/model-selection.js";
// 导入代理超时时间解析函数
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
// 导入入站消息分发函数
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
// 导入回复分发器创建函数
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
// 导入消息上下文类型
import type { MsgContext } from "../../auto-reply/templating.js";
// 导入静默回复相关函数和令牌
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
// 导入回复前缀选项创建函数
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
// 导入会话文件路径解析函数
import { resolveSessionFilePath } from "../../config/sessions.js";
// 导入JSON UTF-8字节计算函数
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
// 导入输入来源相关函数和类型
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
// 导入发送策略解析函数
import { resolveSendPolicy } from "../../sessions/send-policy.js";
// 导入会话键解析函数
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
// 导入指令标签处理函数
import {
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "../../utils/directive-tags.js";
// 导入消息通道相关函数和常量
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayCliClient,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
// 导入聊天中止相关函数和类型
import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
// 导入聊天附件相关函数和类型
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
// 导入消息清理函数
import { stripEnvelopeFromMessage, stripEnvelopeFromMessages } from "../chat-sanitize.js";
// 导入管理员作用域常量
import { ADMIN_SCOPE } from "../method-scopes.js";
// 导入网关客户端相关常量和函数
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  hasGatewayClientCap,
} from "../protocol/client-info.js";
// 导入错误处理和验证相关函数
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
// 导入会话键最大长度常量
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../protocol/schema/primitives.js";
// 导入聊天历史最大字节数获取函数
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
// 导入会话工具函数
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
// 导入日志格式化函数
import { formatForLog } from "../ws-log.js";
// 导入时间戳注入相关函数
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
// 导入去重条目设置函数
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
// 导入附件规范化函数
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
// 导入助手消息注入函数
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
// 导入网关请求相关类型
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

/**
 * 聊天记录追加结果类型
 * 表示将消息追加到会话记录的操作结果
 */
type TranscriptAppendResult = {
  ok: boolean; // 操作是否成功
  messageId?: string; // 消息ID，如果成功
  message?: Record<string, unknown>; // 完整的消息对象，如果成功
  error?: string; // 错误信息，如果失败
};

/**
 * 中止来源类型
 * 表示聊天运行被中止的来源
 */
type AbortOrigin = "rpc" | "stop-command";

/**
 * 中止的部分快照类型
 * 保存被中止的聊天运行的当前状态
 */
type AbortedPartialSnapshot = {
  runId: string; // 运行ID
  sessionId: string; // 会话ID
  text: string; // 已生成的文本内容
  abortOrigin: AbortOrigin; // 中止来源
};

/**
 * 聊天中止请求者类型
 * 表示请求中止聊天的实体信息
 */
type ChatAbortRequester = {
  connId?: string; // 连接ID
  deviceId?: string; // 设备ID
  isAdmin: boolean; // 是否是管理员
};

// 聊天历史文本最大字符数（12,000字符）
const CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;
// 聊天历史单条消息最大字节数（128KB）
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
// 聊天历史超大消息占位符文本
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
// 聊天历史占位符发送计数器
let chatHistoryPlaceholderEmitCount = 0;
// 与通道无关的会话作用域集合
// 这些作用域不特定于任何消息通道
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main", // 主会话
  "direct", // 直接会话
  "dm", // 私聊会话
  "group", // 群组会话
  "channel", // 频道会话
  "cron", // 定时任务会话
  "run", // 运行会话
  "subagent", // 子代理会话
  "acp", // ACP桥接会话
  "thread", // 线程会话
  "topic", // 主题会话
]);
// 通道作用域的会话形状集合
// 这些会话类型与特定消息通道相关
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

/**
 * 聊天发送投递条目类型
 * 记录消息投递的上下文信息，包括当前和最后一次的投递详情
 */
type ChatSendDeliveryEntry = {
  deliveryContext?: {
    channel?: string; // 投递的通道
    to?: string; // 投递的目标对象
    accountId?: string; // 账户ID
    threadId?: string | number; // 线程ID
  };
  lastChannel?: string; // 最后一次使用的通道
  lastTo?: string; // 最后一次投递的目标
  lastAccountId?: string; // 最后一次的账户ID
  lastThreadId?: string | number; // 最后一次的线程ID
};

/**
 * 聊天发送来源路由类型
 * 定义消息的来源路由信息，用于确定消息的投递路径
 */
type ChatSendOriginatingRoute = {
  originatingChannel: string; // 来源通道
  originatingTo?: string; // 来源目标对象
  accountId?: string; // 账户ID
  messageThreadId?: string | number; // 消息线程ID
  explicitDeliverRoute: boolean; // 是否显式指定了投递路由
};

/**
 * 解析聊天发送的来源路由
 *
 * 该函数根据会话键、客户端信息和投递条目，确定消息的来源路由。
 * 它处理多种情况，包括是否需要外部投递、会话作用域类型等。
 *
 * @param params - 参数对象
 * @param params.client - 客户端信息，包含模式和ID
 * @param params.deliver - 是否需要外部投递
 * @param params.entry - 聊天发送投递条目
 * @param params.hasConnectedClient - 是否有已连接的客户端
 * @param params.mainKey - 配置的主会话键
 * @param params.sessionKey - 会话键
 * @returns 聊天发送来源路由对象
 */
function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  // 判断是否需要外部投递
  const shouldDeliverExternally = params.deliver === true;
  if (!shouldDeliverExternally) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  // 获取候选路由通道
  const routeChannelCandidate = normalizeMessageChannel(
    params.entry?.deliveryContext?.channel ?? params.entry?.lastChannel,
  );
  // 获取候选路由目标
  const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
  // 获取候选账户ID
  const routeAccountIdCandidate =
    params.entry?.deliveryContext?.accountId ?? params.entry?.lastAccountId ?? undefined;
  // 获取候选线程ID
  const routeThreadIdCandidate =
    params.entry?.deliveryContext?.threadId ?? params.entry?.lastThreadId;
  // 如果会话键超过最大长度，返回内部通道
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  // 解析会话键
  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  // 获取会话作用域部分
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  // 获取会话作用域头部
  const sessionScopeHead = sessionScopeParts[0];
  // 获取会话通道提示
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  // 规范化会话作用域头部
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  // 获取会话对等形状候选
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  // 判断是否是通道无关的会话作用域
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  // 判断是否是通道作用域的会话
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  // 判断是否有遗留的通道对等形状
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  // 判断是否来自Web聊天客户端
  const isFromWebchatClient = isWebchatClient(params.client);
  // 判断是否来自网关CLI客户端
  const isFromGatewayCliClient = isGatewayCliClient(params.client);
  // 判断是否有客户端元数据
  const hasClientMetadata =
    (typeof params.client?.mode === "string" && params.client.mode.trim().length > 0) ||
    (typeof params.client?.id === "string" && params.client.id.trim().length > 0);
  // 获取配置的主会话键
  const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
  // 判断是否是配置的主会话作用域
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;
  // 判断是否可以继承配置的主路由
  const canInheritConfiguredMainRoute =
    isConfiguredMainSessionScope &&
    params.hasConnectedClient &&
    (isFromGatewayCliClient || !hasClientMetadata);

  // Webchat客户端从不继承外部投递路由。配置的主会话比通道作用域会话更严格：
  // 只有CLI调用者或没有客户端元数据的遗留调用者可以继承最后的外部路由。
  const canInheritDeliverableRoute = Boolean(
    !isFromWebchatClient &&
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      canInheritConfiguredMainRoute),
  );
  // 判断是否有可投递的路由
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  // 如果没有可投递的路由，返回内部通道
  if (!hasDeliverableRoute) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  // 返回完整的路由信息
  return {
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
    accountId: routeAccountIdCandidate,
    messageThreadId: routeThreadIdCandidate,
    explicitDeliverRoute: true,
  };
}

/**
 * 移除不允许的聊天控制字符
 *
 * 该函数从消息中移除不允许的控制字符，只保留制表符、换行符和可打印字符。
 *
 * @param message - 要清理的消息字符串
 * @returns 清理后的消息字符串
 */
function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    // 只保留制表符(9)、换行符(10)、回车符(13)和可打印字符(32-126，除了127)
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

/**
 * 清理聊天发送消息输入
 *
 * 该函数对消息进行规范化，移除不允许的字符，并检查是否包含空字节。
 *
 * @param message - 要清理的消息字符串
 * @returns 清理结果，包含成功状态、清理后的消息或错误信息
 */
export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  // 规范化Unicode字符
  const normalized = message.normalize("NFC");
  // 检查是否包含空字节
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  // 移除不允许的控制字符
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

/**
 * 规范化可选的聊天系统回执
 *
 * 该函数处理系统来源回执值，确保其格式正确。
 *
 * @param value - 要规范化的值
 * @returns 规范化结果，包含成功状态、回执或错误信息
 */
function normalizeOptionalChatSystemReceipt(
  value: unknown,
): { ok: true; receipt?: string } | { ok: false; error: string } {
  // 如果值为null，返回成功
  if (value == null) {
    return { ok: true };
  }
  // 如果不是字符串，返回错误
  if (typeof value !== "string") {
    return { ok: false, error: "systemProvenanceReceipt must be a string" };
  }
  // 清理消息输入
  const sanitized = sanitizeChatSendMessageInput(value);
  if (!sanitized.ok) {
    return sanitized;
  }
  // 去除首尾空白，如果为空则返回undefined
  const receipt = sanitized.message.trim();
  return { ok: true, receipt: receipt || undefined };
}

/**
 * 判断是否是ACP桥接客户端
 *
 * 该函数检查客户端是否是ACP（Agent Control Protocol）桥接客户端。
 *
 * @param client - 网关请求处理器选项中的客户端信息
 * @returns 如果是ACP桥接客户端则返回true，否则返回false
 */
function isAcpBridgeClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const info = client?.connect?.client;
  return (
    info?.id === GATEWAY_CLIENT_NAMES.CLI &&
    info?.mode === GATEWAY_CLIENT_MODES.CLI &&
    info?.displayName === "ACP" &&
    info?.version === "acp"
  );
}

/**
 * 截断聊天历史文本
 *
 * 该函数检查文本长度，如果超过最大长度则进行截断。
 *
 * @param text - 要检查的文本
 * @returns 包含截断后文本和是否被截断标志的对象
 */
function truncateChatHistoryText(text: string): { text: string; truncated: boolean } {
  // 如果文本长度在限制内，直接返回
  if (text.length <= CHAT_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  // 截断文本并添加截断标记
  return {
    text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
    truncated: true,
  };
}

/**
 * 清理聊天历史内容块
 *
 * 该函数清理聊天历史消息中的内容块，包括：
 * 1. 移除内联指令标签
 * 2. 截断过长的文本字段
 * 3. 移除思考签名
 * 4. 移除图像数据，只保留字节大小
 *
 * @param block - 要清理的内容块
 * @returns 包含清理后的块和是否发生更改标志的对象
 */
function sanitizeChatHistoryContentBlock(block: unknown): { block: unknown; changed: boolean } {
  // 如果块不存在或不是对象，直接返回
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  // 创建块的副本
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  // 处理text字段：移除指令标签并截断
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }
  // 处理partialJson字段：截断
  if (typeof entry.partialJson === "string") {
    const res = truncateChatHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  // 处理arguments字段：截断
  if (typeof entry.arguments === "string") {
    const res = truncateChatHistoryText(entry.arguments);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  // 处理thinking字段：截断
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  // 移除thinkingSignature字段
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  // 获取类型
  const type = typeof entry.type === "string" ? entry.type : "";
  // 处理图像类型：移除数据，只保留字节大小
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  // 返回清理后的块和更改标志
  return { block: changed ? entry : block, changed };
}

/**
 * 验证值是否为有限数字，否则返回undefined
 *
 * 该函数用于确保值是有效的数字，避免在UI中调用数字方法时出错。
 *
 * @param x - 要验证的值
 * @returns 如果是有限数字则返回该值，否则返回undefined
 */
function toFiniteNumber(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

/**
 * 清理使用元数据，确保只包含有限数字字段
 *
 * 该函数过滤并验证使用元数据，防止因格式错误的JSON导致UI崩溃。
 * 它只保留已知的数字字段，并验证它们是有限数字。
 *
 * @param raw - 原始使用元数据
 * @returns 清理后的使用元数据，如果没有有效字段则返回undefined
 */
function sanitizeUsage(raw: unknown): Record<string, number> | undefined {
  // 如果值不存在或不是对象，返回undefined
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const out: Record<string, number> = {};

  // 白名单已知的使用字段，并验证它们是有限数字
  const knownFields = [
    "input", // 输入token数
    "output", // 输出token数
    "totalTokens", // 总token数
    "inputTokens", // 输入token数
    "outputTokens", // 输出token数
    "cacheRead", // 缓存读取
    "cacheWrite", // 缓存写入
    "cache_read_input_tokens", // 缓存读取输入token
    "cache_creation_input_tokens", // 缓存创建输入token
  ];

  // 遍历已知字段，只保留有效的数字值
  for (const k of knownFields) {
    const n = toFiniteNumber(u[k]);
    if (n !== undefined) {
      out[k] = n;
    }
  }

  // 保留嵌套的usage.cost字段（如果存在）
  if ("cost" in u && u.cost != null && typeof u.cost === "object") {
    const sanitizedCost = sanitizeCost(u.cost);
    if (sanitizedCost) {
      (out as Record<string, unknown>).cost = sanitizedCost;
    }
  }

  // 如果没有有效字段，返回undefined
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 清理成本元数据，确保只包含有限数字字段
 *
 * 该函数验证成本元数据，防止在非数字上调用.toFixed()导致UI崩溃。
 *
 * @param raw - 原始成本元数据
 * @returns 清理后的成本对象，包含total字段，如果没有有效值则返回undefined
 */
function sanitizeCost(raw: unknown): { total?: number } | undefined {
  // 如果值不存在或不是对象，返回undefined
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  // 验证total字段是否为有限数字
  const total = toFiniteNumber(c.total);
  return total !== undefined ? { total } : undefined;
}

function sanitizeChatHistoryMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }

  // Keep usage/cost so the chat UI can render per-message token and cost badges.
  // Only retain usage/cost on assistant messages and validate numeric fields to prevent UI crashes.
  if (entry.role !== "assistant") {
    if ("usage" in entry) {
      delete entry.usage;
      changed = true;
    }
    if ("cost" in entry) {
      delete entry.cost;
      changed = true;
    }
  } else {
    // Validate and sanitize usage/cost for assistant messages
    if ("usage" in entry) {
      const sanitized = sanitizeUsage(entry.usage);
      if (sanitized) {
        entry.usage = sanitized;
      } else {
        delete entry.usage;
      }
      changed = true;
    }
    if ("cost" in entry) {
      const sanitized = sanitizeCost(entry.cost);
      if (sanitized) {
        entry.cost = sanitized;
      } else {
        delete entry.cost;
      }
      changed = true;
    }
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const res = truncateChatHistoryText(stripped.text);
    entry.content = res.text;
    changed ||= stripped.changed || res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block));
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }

  return { message: changed ? entry : message, changed };
}

/**
 * Extract the visible text from an assistant history message for silent-token checks.
 * Returns `undefined` for non-assistant messages or messages with no extractable text.
 * When `entry.text` is present it takes precedence over `entry.content` to avoid
 * dropping messages that carry real text alongside a stale `content: "NO_REPLY"`.
 */
function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function sanitizeChatHistoryMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    const res = sanitizeChatHistoryMessage(message);
    changed ||= res.changed;
    // Drop assistant messages whose entire visible text is the silent reply token.
    const text = extractAssistantTextForSilentCheck(res.message);
    if (text !== undefined && isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: { truncated: true, reason: "oversized" },
  };
}

/**
 * 替换过大的聊天历史消息
 * @param params 包含消息列表和单个消息最大字节数的参数对象
 * @returns 返回处理后的消息列表和被替换的消息数量
 */
function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[]; // 消息列表
  maxSingleMessageBytes: number; // 单个消息的最大字节数限制
}): { messages: unknown[]; replacedCount: number } {
  // 返回类型：处理后的消息列表和被替换的数量
  const { messages, maxSingleMessageBytes } = params; // 解构参数获取消息列表和最大字节数
  if (messages.length === 0) {
    // 如果消息列表为空，直接返回原列表和替换数量0
    return { messages, replacedCount: 0 };
  }
  let replacedCount = 0; // 初始化替换计数器
  const next = messages.map((message) => {
    // 遍历消息列表
    if (jsonUtf8Bytes(message) <= maxSingleMessageBytes) {
      // 检查消息大小是否超过限制
      return message; // 未超过限制，返回原消息
    }
    replacedCount += 1; // 增加替换计数
    return buildOversizedHistoryPlaceholder(message); // 超过限制，返回占位符消息
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount }; // 如果有替换，返回新列表；否则返回原列表
}

function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

/**
 * 持久化中止的部分快照
 *
 * 该函数将中止的聊天运行快照保存到会话记录中。
 *
 * @param params - 参数对象
 * @param params.context - 网关请求上下文
 * @param params.sessionKey - 会话键
 * @param params.snapshots - 中止的部分快照数组
 */
function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  // 如果没有快照，直接返回
  if (params.snapshots.length === 0) {
    return;
  }
  // 加载会话条目
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  // 遍历每个快照，保存到会话记录
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    // 如果追加失败，记录警告
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

/**
 * 创建聊天中止操作对象
 *
 * 该函数从网关请求上下文中提取聊天中止相关的操作。
 *
 * @param context - 网关请求上下文
 * @returns 聊天中止操作对象
 */
function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers, // 聊天中止控制器
    chatRunBuffers: context.chatRunBuffers, // 聊天运行缓冲区
    chatDeltaSentAt: context.chatDeltaSentAt, // 聊天增量发送时间
    chatAbortedRuns: context.chatAbortedRuns, // 聊天中止运行
    removeChatRun: context.removeChatRun, // 移除聊天运行
    agentRunSeq: context.agentRunSeq, // 代理运行序列
    broadcast: context.broadcast, // 广播函数
    nodeSendToSession: context.nodeSendToSession, // 节点发送到会话
  };
}

/**
 * 规范化可选文本
 *
 * 该函数去除文本两端的空白字符，如果结果为空则返回undefined。
 *
 * @param value - 要规范化的文本
 * @returns 规范化后的文本，如果为空则返回undefined
 */
function normalizeOptionalText(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * 解析聊天中止请求者信息
 *
 * 该函数从客户端信息中提取聊天中止请求者的详细信息。
 *
 * @param client - 网关请求处理器选项中的客户端信息
 * @returns 聊天中止请求者对象
 */
function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
): ChatAbortRequester {
  // 获取客户端作用域
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    connId: normalizeOptionalText(client?.connId), // 连接ID
    deviceId: normalizeOptionalText(client?.connect?.device?.id), // 设备ID
    isAdmin: scopes.includes(ADMIN_SCOPE), // 是否是管理员
  };
}

/**
 * 判断请求者是否可以中止聊天运行
 *
 * 该函数检查请求者是否有权限中止指定的聊天运行。
 * 管理员可以中止任何运行，其他请求者只能中止自己拥有的运行。
 *
 * @param entry - 聊天中止控制器条目
 * @param requester - 聊天中止请求者
 * @returns 如果可以中止则返回true，否则返回false
 */
function canRequesterAbortChatRun(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  // 管理员可以中止任何运行
  if (requester.isAdmin) {
    return true;
  }
  // 获取运行所有者的设备ID和连接ID
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  // 如果运行没有所有者，允许中止
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  // 如果请求者设备ID匹配，允许中止
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  // 如果请求者连接ID匹配，允许中止
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  // 不匹配，不允许中止
  return false;
}

/**
 * 解析会话的授权运行ID
 *
 * 该函数查找指定会话中所有授权给请求者的运行ID。
 *
 * @param params - 参数对象
 * @param params.chatAbortControllers - 聊天中止控制器映射
 * @param params.sessionKey - 会话键
 * @param params.requester - 聊天中止请求者
 * @returns 包含匹配的运行数和授权ID的对象
 */
function resolveAuthorizedRunIdsForSession(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKey: string;
  requester: ChatAbortRequester;
}) {
  const authorizedRunIds: string[] = [];
  let matchedSessionRuns = 0;
  // 遍历所有运行，查找属于指定会话的运行
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    matchedSessionRuns += 1;
    // 检查请求者是否可以中止该运行
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRunIds.push(runId);
    }
  }
  return {
    matchedSessionRuns, // 匹配的运行数
    authorizedRunIds, // 授权的运行ID列表
  };
}

/**
 * 为会话键中止聊天运行并保存部分快照
 *
 * 该函数中止指定会话中授权的运行，并保存部分结果。
 *
 * @param params - 参数对象
 * @param params.context - 网关请求上下文
 * @param params.ops - 聊天中止操作
 * @param params.sessionKey - 会话键
 * @param params.abortOrigin - 中止来源
 * @param params.stopReason - 停止原因
 * @param params.requester - 聊天中止请求者
 * @returns 包含中止状态、运行ID和授权状态的对象
 */
function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
}) {
  // 解析授权的运行ID
  const { matchedSessionRuns, authorizedRunIds } = resolveAuthorizedRunIdsForSession({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKey: params.sessionKey,
    requester: params.requester,
  });
  // 如果没有授权的运行，返回未中止状态
  if (authorizedRunIds.length === 0) {
    return {
      aborted: false,
      runIds: [],
      unauthorized: matchedSessionRuns > 0,
    };
  }
  // 创建授权ID集合
  const authorizedRunIdSet = new Set(authorizedRunIds);
  // 收集中止的部分快照
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  const runIds: string[] = [];
  // 遍历授权的运行ID，执行中止操作
  for (const runId of authorizedRunIds) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey: params.sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const res = { aborted: runIds.length > 0, runIds, unauthorized: false };
  // 如果有运行被中止，保存部分快照
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  return res;
}

/**
 * 获取下一个聊天序列号
 *
 * 该函数为指定的运行ID生成下一个序列号，并更新序列映射。
 *
 * @param context - 包含代理运行序列映射的上下文
 * @param runId - 运行ID
 * @returns 下一个序列号
 */
function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  // 获取当前序列号并加1
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  // 更新序列映射
  context.agentRunSeq.set(runId, next);
  return next;
}

/**
 * 广播聊天最终消息
 *
 * 该函数将聊天的最终消息广播给所有客户端，并发送到会话。
 *
 * @param params - 参数对象
 * @param params.context - 网关请求上下文
 * @param params.runId - 运行ID
 * @param params.sessionKey - 会话键
 * @param params.message - 要广播的消息
 */
function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  // 获取下一个序列号
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  // 移除消息信封
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  // 构建最终消息负载
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
  };
  // 广播消息到所有客户端
  params.context.broadcast("chat", payload);
  // 发送消息到会话
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  // 删除运行序列号
  params.context.agentRunSeq.delete(params.runId);
}

/**
 * 广播聊天错误消息
 *
 * 该函数将聊天错误消息广播给所有客户端，并发送到会话。
 *
 * @param params - 参数对象
 * @param params.context - 网关请求上下文
 * @param params.runId - 运行ID
 * @param params.sessionKey - 会话键
 * @param params.errorMessage - 错误消息
 */
function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  // 获取下一个序列号
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  // 构建错误消息负载
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  // 广播错误消息到所有客户端
  params.context.broadcast("chat", payload);
  // 发送错误消息到会话
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  // 删除运行序列号
  params.context.agentRunSeq.delete(params.runId);
}

export const chatHandlers: GatewayRequestHandlers = {
  /**
   * 聊天历史处理器
   *
   * 该处理器获取并返回指定会话的聊天历史消息。
   * 它会对消息进行清理、截断和大小限制处理。
   *
   * @param params - 请求参数
   * @param respond - 响应函数
   * @param context - 网关请求上下文
   */
  "chat.history": async ({ params, respond, context }) => {
    // 验证请求参数
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    // 解析请求参数
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    // 加载会话条目
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    // 读取会话消息
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    // 设置硬性最大值和默认限制
    const hardMax = 1000;
    const defaultLimit = 200;
    // 计算实际限制
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    // 截取最近的消息
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    // 移除消息信封
    const sanitized = stripEnvelopeFromMessages(sliced);
    // 清理消息内容
    const normalized = sanitizeChatHistoryMessages(sanitized);
    // 获取历史最大字节数
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    // 计算单条消息硬性上限
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    // 替换超大的消息
    const replaced = replaceOversizedChatHistoryMessages({
      messages: normalized,
      maxSingleMessageBytes: perMessageHardCap,
    });
    // 按字节数限制消息数组
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    // 强制执行最终预算限制
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
    // 记录占位符使用情况
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    // 解析思考级别
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
      const { provider, model } = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const catalog = await context.loadGatewayModelCatalog();
      thinkingLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog,
      });
    }
    // 获取详细级别
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    // 返回响应
    respond(true, {
      sessionKey,
      sessionId,
      messages: bounded.messages,
      thinkingLevel,
      fastMode: entry?.fastMode,
      verboseLevel,
    });
  },
  /**
   * 聊天中止处理器
   *
   * 该处理器中止指定的聊天运行。
   * 可以中止特定会话的所有运行，或中止特定的运行。
   *
   * @param params - 请求参数
   * @param respond - 响应函数
   * @param context - 网关请求上下文
   * @param client - 客户端信息
   */
  "chat.abort": ({ params, respond, context, client }) => {
    // 验证请求参数
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    // 解析请求参数
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);
    const requester = resolveChatAbortRequester(client);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: rawSessionKey,
        abortOrigin: "rpc",
        stopReason: "rpc",
        requester,
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }
    if (!canRequesterAbortChatRun(active, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      systemInputProvenance?: InputProvenance;
      systemProvenanceReceipt?: string;
      idempotencyKey: string;
    };
    if ((p.systemInputProvenance || p.systemProvenanceReceipt) && !isAcpBridgeClient(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "system provenance fields are reserved for the ACP bridge",
        ),
      );
      return;
    }
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const systemReceiptResult = normalizeOptionalChatSystemReceipt(p.systemProvenanceReceipt);
    if (!systemReceiptResult.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, systemReceiptResult.error));
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const systemInputProvenance = normalizeInputProvenance(p.systemInputProvenance);
    const systemProvenanceReceipt = systemReceiptResult.receipt;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const rawSessionKey = p.sessionKey;
    const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        abortOrigin: "stop-command",
        stopReason: "stop",
        requester: resolveChatAbortRequester(client),
      });
      if (res.unauthorized) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        ownerConnId: normalizeOptionalText(client?.connId),
        ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const messageForAgent = systemProvenanceReceipt
        ? [systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
        : parsedMessage;
      const clientInfo = client?.connect?.client;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: p.deliver,
        entry,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/moltbot/moltbot/issues/3658
      const stampedMessage = injectTimestamp(messageForAgent, timestampOptsFromConfig(cfg));

      const ctx: MsgContext = {
        Body: messageForAgent,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        InputProvenance: systemInputProvenance,
        SessionKey: sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        GatewayClientScopes: client?.connect?.scopes,
      };

      const agentId = resolveSessionAgentId({
        sessionKey,
        config: cfg,
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        ...prefixOptions,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") {
            return;
          }
          const text = payload.text?.trim() ?? "";
          if (!text) {
            return;
          }
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
        },
      })
        .then(() => {
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } =
                loadSessionEntry(sessionKey);
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                agentId,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  // Keep this compatible with Pi stopReason enums even though this message isn't
                  // persisted to the transcript due to the append failure.
                  stopReason: "stop",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: rawSessionKey,
              message,
            });
          }
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: rawSessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({ sessionKey: rawSessionKey, config: cfg }),
      createIfMissing: true,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey: rawSessionKey,
      seq: 0,
      state: "final" as const,
      message: stripInlineDirectiveTagsFromMessageForDisplay(
        stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
      ),
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(rawSessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId: appended.messageId });
  },
};
