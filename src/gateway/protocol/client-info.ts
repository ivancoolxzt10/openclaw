// 本文件定义了与连接到网关（Gateway）的客户端相关的所有数据结构、常量和辅助函数。
// 它为“客户端信息（Client Info）”建立了一个协议，确保网关能够识别和理解
// 正在连接的客户端是什么类型、具有什么能力。

/**
 * 一个包含了所有已知的、官方支持的客户端 ID 的常量对象。
 * `as const` 确保这些值是只读的，并且它们的类型是具体的字符串字面量，而不是宽泛的 `string`。
 */
export const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
} as const;

/**
 * 从 `GATEWAY_CLIENT_IDS` 派生出的联合类型，表示一个有效的客户端ID。
 * 例如，`GatewayClientId` 的值只能是 "webchat-ui", "cli" 等之一。
 */
export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];

// 为了向后兼容的命名（仅内部使用）：这些值是 ID，而不是用于显示的名称。
export const GATEWAY_CLIENT_NAMES = GATEWAY_CLIENT_IDS;
export type GatewayClientName = GatewayClientId;

/**
 * 定义了客户端可能处于的不同“模式（modes）”。
 * 例如，一个客户端可以是用于聊天的（`webchat`），也可以是用于管理的（`ui`）。
 */
export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;

export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

/**
 * 【核心类型】描述一个已连接客户端的完整信息。
 */
export type GatewayClientInfo = {
  id: GatewayClientId;      // 客户端的唯一ID
  displayName?: string;     // 用于显示的名称
  version: string;          // 客户端的版本号
  platform: string;         // 客户端运行的平台 (例如, "win32", "darwin")
  deviceFamily?: string;    // 设备家族 (例如, "iPhone", "Mac")
  modelIdentifier?: string; // 具体的设备型号 (例如, "iPhone15,3")
  mode: GatewayClientMode;  // 客户端的运行模式
  instanceId?: string;      // 客户端实例的唯一ID
};

/**
 * 定义了客户端可能拥有的“能力（capabilities）”。
 * 这是一个功能标记系统，用于表示客户端是否支持某个特定的高级功能。
 */
export const GATEWAY_CLIENT_CAPS = {
  TOOL_EVENTS: "tool-events", // 例如，表示客户端能够处理工具执行事件
} as const;

export type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

// 为了进行高效的查找，将常量对象的值转换为 Set。
const GATEWAY_CLIENT_ID_SET = new Set<GatewayClientId>(Object.values(GATEWAY_CLIENT_IDS));
const GATEWAY_CLIENT_MODE_SET = new Set<GatewayClientMode>(Object.values(GATEWAY_CLIENT_MODES));

/**
 * 规范化并验证一个原始的客户端 ID 字符串。
 * @param raw - 来自外部的原始输入字符串。
 * @returns 如果输入是一个有效的 `GatewayClientId`，则返回规范化后的值；否则返回 `undefined`。
 */
export function normalizeGatewayClientId(raw?: string | null): GatewayClientId | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  // 使用 Set 来快速检查值是否有效
  return GATEWAY_CLIENT_ID_SET.has(normalized as GatewayClientId)
    ? (normalized as GatewayClientId)
    : undefined;
}

/**
 * `normalizeGatewayClientId` 的别名，用于向后兼容。
 */
export function normalizeGatewayClientName(raw?: string | null): GatewayClientName | undefined {
  return normalizeGatewayClientId(raw);
}

/**
 * 规范化并验证一个原始的客户端模式字符串。
 */
export function normalizeGatewayClientMode(raw?: string | null): GatewayClientMode | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return GATEWAY_CLIENT_MODE_SET.has(normalized as GatewayClientMode)
    ? (normalized as GatewayClientMode)
    : undefined;
}

/**
 * 检查一个客户端的能力列表是否包含某个特定的能力。
 * @param caps - 客户端报告的能力字符串数组。
 * @param cap - 要检查的特定能力。
 * @returns 如果包含该能力，则返回 `true`。
 */
export function hasGatewayClientCap(
  caps: string[] | null | undefined,
  cap: GatewayClientCap,
): boolean {
  if (!Array.isArray(caps)) {
    return false;
  }
  return caps.includes(cap);
}
