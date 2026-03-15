// 本文件是一个“规则数据库”，用于 *检测* 旧版（legacy）或已弃用的配置键。
// 它与 `legacy.ts` 中的 `findLegacyConfigIssues` 函数协同工作。
// 本文件只“定义”了要查找的内容，而不执行任何修改操作。

import type { LegacyConfigRule } from "./legacy.shared.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 辅助函数，用于更复杂的匹配逻辑
function hasLegacyThreadBindingTtl(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "ttlHours");
}

function hasLegacyThreadBindingTtlInAccounts(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) =>
    hasLegacyThreadBindingTtl(isRecord(entry) ? entry.threadBindings : undefined),
  );
}

function isLegacyGatewayBindHostAlias(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  // 这些是新的、有效的绑定“模式”，不应被视为旧版
  if (["auto", "loopback", "lan", "tailnet", "custom"].includes(normalized)) return false;
  // 这些是旧版的、表示绑定地址的“别名”，现在应使用上面的模式
  return ["0.0.0.0", "::", "[::]", "*", "127.0.0.1", "localhost", "::1", "[::1]"].includes(normalized);
}

/**
 * `LEGACY_CONFIG_RULES` 是一个规则定义的数组。
 * 每一条规则都描述了一个旧版的配置项。
 *
 * 每条规则包含:
 * - `path`: 一个字符串数组，表示到达旧版配置项的路径 (例如 `['gateway', 'token']`)。
 * - `message`: 一条人类可读的消息，解释为什么这个配置是旧版的，以及它被什么取代了。
 * - `match` (可选): 一个函数，用于执行更复杂的检查。
 * - `requireSourceLiteral` (可选): 一个布尔值，如果为 `true`，则该规则仅在原始配置文件中存在该键时才触发。
 */
export const LEGACY_CONFIG_RULES: LegacyConfigRule[] = [
  // 示例: 简单的路径检查
  {
    path: ["whatsapp"],
    message: "whatsapp 配置已移动到 channels.whatsapp (加载时会自动迁移)。",
  },
  {
    path: ["telegram"],
    message: "telegram 配置已移动到 channels.telegram (加载时会自动迁移)。",
  },
  // ... 其他渠道的类似规则 ...

  // 示例: 使用 `match` 函数进行更复杂的检查
  {
    path: ["session", "threadBindings"],
    message: "session.threadBindings.ttlHours 已重命名为 session.threadBindings.idleHours (加载时会自动迁移)。",
    match: (value) => hasLegacyThreadBindingTtl(value), // 仅当对象中包含 `ttlHours` 键时才匹配
  },
  {
    path: ["channels", "discord", "accounts"],
    message: "channels.discord.accounts.<id>.threadBindings.ttlHours 已重命名为 channels.discord.accounts.<id>.threadBindings.idleHours (加载时会自动迁移)。",
    match: (value) => hasLegacyThreadBindingTtlInAccounts(value),
  },
  {
    path: ["routing", "allowFrom"],
    message: "routing.allowFrom 已移除；请使用 channels.whatsapp.allowFrom (加载时会自动迁移)。",
  },
  // ... 更多关于 `routing` 的迁移规则 ...

  // 示例: 检查值的类型
  {
    path: ["agent", "model"],
    message: "agent.model (字符串) 已被 agents.defaults.model.primary/fallbacks 和 agents.defaults.models 替代 (加载时会自动迁移)。",
    match: (value) => typeof value === "string", // 仅当 `agent.model` 是一个字符串时才匹配
  },
  {
    path: ["gateway", "token"],
    message: "gateway.token 已被忽略；请使用 gateway.auth.token (加载时会自动迁移)。",
  },
  // 示例: 使用 `requireSourceLiteral`
  {
    path: ["gateway", "bind"],
    message: "gateway.bind 的主机别名 (例如 0.0.0.0/localhost) 是旧版配置；请改用绑定模式 (lan/loopback/custom/tailnet/auto) (加载时会自动迁移)。",
    match: (value) => isLegacyGatewayBindHostAlias(value),
    requireSourceLiteral: true, // 仅当这个旧版值明确存在于磁盘上的源文件中时才触发
  },
  {
    path: ["heartbeat"],
    message: "顶层的 heartbeat 不是有效的配置路径；请使用 agents.defaults.heartbeat (用于节奏/目标/模型设置) 或 channels.defaults.heartbeat (用于显示/警报设置)。",
  },
];
