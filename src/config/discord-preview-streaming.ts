// 本文件专注于处理“流式（streaming）”模式的配置设置。
// “流式”可能指的是实时更新（如模型生成文本时）在不同聊天客户端（Discord、Slack、Telegram）中的显示方式。
// 文件定义了不同的模式，并提供了用于解析、解析和映射这些设置的函数，同时处理新旧两种配置格式。
// 这是一个典型的配置演进示例，它管理一个设置的多个“代”，并提供了一个兼容层。

/**
 * 通用的、统一的流式模式枚举。
 * - `off`: 关闭流式输出。
 * - `partial`: 部分更新，可能会替换之前的消息。
 * - `block`: 按块更新，通常是追加内容。
 * - `progress`: 显示进度指示，最后显示完整内容。
 */
export type StreamingMode = "off" | "partial" | "block" | "progress";

/** 特定于 Discord 的预览流式模式。 */
export type DiscordPreviewStreamMode = "off" | "partial" | "block";
/** 特定于 Telegram 的预览流式模式。 */
export type TelegramPreviewStreamMode = "off" | "partial" | "block";
/** 特定于 Slack 的旧版草稿流式模式。 */
export type SlackLegacyDraftStreamMode = "replace" | "status_final" | "append";

/**
 * 规范化流式模式的值（转换为小写、去除空格）。
 */
function normalizeStreamingMode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

/**
 * 将未知值解析为统一的 `StreamingMode` 枚举。
 * @param value 来自配置的原始值。
 * @returns 解析后的 `StreamingMode`，如果无效则返回 `null`。
 */
export function parseStreamingMode(value: unknown): StreamingMode | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return null;
}

/**
 * 将未知值解析为 Discord 的预览流式模式。
 * 注意：它会将通用的 "progress" 模式映射为 "partial"。
 */
export function parseDiscordPreviewStreamMode(value: unknown): DiscordPreviewStreamMode | null {
  const parsed = parseStreamingMode(value);
  if (!parsed) {
    return null;
  }
  return parsed === "progress" ? "partial" : parsed;
}

/**
 * 将未知值解析为 Slack 的旧版草稿流式模式。
 */
export function parseSlackLegacyDraftStreamMode(value: unknown): SlackLegacyDraftStreamMode | null {
  const normalized = normalizeStreamingMode(value);
  if (normalized === "replace" || normalized === "status_final" || normalized === "append") {
    return normalized;
  }
  return null;
}

/**
 * 将 Slack 的旧版模式映射到新的统一 `StreamingMode`。
 * 这是为了向后兼容。
 */
export function mapSlackLegacyDraftStreamModeToStreaming(
  mode: SlackLegacyDraftStreamMode,
): StreamingMode {
  if (mode === "append") return "block";
  if (mode === "status_final") return "progress";
  return "partial";
}

/**
 * 将新的统一 `StreamingMode` 映射回旧的 Slack 模式。
 */
export function mapStreamingModeToSlackLegacyDraftStreamMode(mode: StreamingMode) {
  if (mode === "block") return "append" as const;
  if (mode === "progress") return "status_final" as const;
  return "replace" as const;
}

/**
 * 解析并确定 Telegram 的最终生效的预览流式模式。
 * 解析顺序：
 * 1. 新的 `streaming` 枚举设置。
 * 2. 旧的 `streamMode` 设置。
 * 3. 更旧的 `streaming` 布尔值设置。
 * 4. 默认值 "partial"。
 */
export function resolveTelegramPreviewStreamMode(
  params: { streamMode?: unknown; streaming?: unknown } = {},
): TelegramPreviewStreamMode {
  const parsedStreaming = parseStreamingMode(params.streaming);
  if (parsedStreaming) {
    return parsedStreaming === "progress" ? "partial" : parsedStreaming;
  }

  const legacy = parseDiscordPreviewStreamMode(params.streamMode);
  if (legacy) return legacy;

  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "partial";
}

/**
 * 解析并确定 Discord 的最终生效的预览流式模式。
 * 解析顺序与 Telegram 类似，但默认值为 "off"。
 */
export function resolveDiscordPreviewStreamMode(
  params: { streamMode?: unknown; streaming?: unknown } = {},
): DiscordPreviewStreamMode {
  const parsedStreaming = parseDiscordPreviewStreamMode(params.streaming);
  if (parsedStreaming) return parsedStreaming;

  const legacy = parseDiscordPreviewStreamMode(params.streamMode);
  if (legacy) return legacy;

  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "off";
}

/**
 * 解析并确定 Slack 的最终生效的流式模式。
 * 它会处理多种旧版设置并将其映射到新的统一模式。
 */
export function resolveSlackStreamingMode(
  params: { streamMode?: unknown; streaming?: unknown } = {},
): StreamingMode {
  const parsedStreaming = parseStreamingMode(params.streaming);
  if (parsedStreaming) return parsedStreaming;

  const legacyStreamMode = parseSlackLegacyDraftStreamMode(params.streamMode);
  if (legacyStreamMode) {
    return mapSlackLegacyDraftStreamModeToStreaming(legacyStreamMode);
  }

  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "partial";
}

/**
 * 解析 Slack 的原生流式（native streaming）设置。
 */
export function resolveSlackNativeStreaming(
  params: { nativeStreaming?: unknown; streaming?: unknown } = {},
): boolean {
  if (typeof params.nativeStreaming === "boolean") {
    return params.nativeStreaming;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming;
  }
  return true;
}

/**
 * 格式化一条消息，告知用户他们的旧版 Slack `streamMode` 设置已被迁移。
 */
export function formatSlackStreamModeMigrationMessage(
  pathPrefix: string,
  resolvedStreaming: string,
): string {
  return `已将 ${pathPrefix}.streamMode 移动到 → ${pathPrefix}.streaming (${resolvedStreaming})。`;
}

/**
 * 格式化一条消息，告知用户他们的旧版 Slack `streaming`布尔值设置已被迁移。
 */
export function formatSlackStreamingBooleanMigrationMessage(
  pathPrefix: string,
  resolvedNativeStreaming: boolean,
): string {
  return `已将 ${pathPrefix}.streaming (布尔值) 移动到 → ${pathPrefix}.nativeStreaming (${resolvedNativeStreaming})。`;
}
