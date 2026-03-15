// 本文件负责为配置 schema 中的每个字段“派生（derive）”一组描述性的标签。
// 例如，一个名为 `gateway.auth.token` 的字段可能会被自动打上 "security", "auth", "network" 等标签。
// 这些标签对于在 UI 中实现配置项的筛选和分类功能至关重要。
//
// 派生逻辑是基于一组“启发式（heuristic）”规则，包括：
// - 路径前缀 (例如，所有以 `gateway.` 开头的都是 "network")
// - 路径中的关键词 (例如，包含 `timeout` 的都是 "performance")
// - 明确的覆盖规则

import type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";

/**
 * 所有可用的配置标签的列表。
 * `as const` 确保这个数组是只读的，并且其成员是具体的字符串字面量类型，而不是宽泛的 `string` 类型。
 */
export const CONFIG_TAGS = [
  "security",
  "auth",
  "network",
  "access",
  "privacy",
  "observability",
  "performance",
  "reliability",
  "storage",
  "models",
  "media",
  "automation",
  "channels",
  "tools",
  "advanced",
] as const;

/**
 * 从 `CONFIG_TAGS` 派生出的单个标签的 TypeScript 类型。
 */
export type ConfigTag = (typeof CONFIG_TAGS)[number];

/**
 * 一个字典，定义了每个标签的显示优先级（顺序）。
 * 数字越小，在 UI 中显示的位置就越靠前。
 */
const TAG_PRIORITY: Record<ConfigTag, number> = {
  security: 0,
  auth: 1,
  access: 2,
  network: 3,
  privacy: 4,
  observability: 5,
  reliability: 6,
  performance: 7,
  storage: 8,
  models: 9,
  media: 10,
  automation: 11,
  channels: 12,
  tools: 13,
  advanced: 14,
};

/**
 * 一个“覆盖”字典，用于为特定的配置路径手动指定标签。
 * 这是最高优先级的规则，会覆盖所有自动派生的标签。
 * 支持通配符 `*`。
 */
const TAG_OVERRIDES: Record<string, ConfigTag[]> = {
  "gateway.auth.token": ["security", "auth", "access", "network"],
  "gateway.auth.password": ["security", "auth", "access", "network"],
  "gateway.push.apns.relay.baseUrl": ["network", "advanced"],
  "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback": [
    "security",
    "access",
    "network",
    "advanced",
  ],
  "gateway.controlUi.dangerouslyDisableDeviceAuth": ["security", "access", "network", "advanced"],
  "gateway.controlUi.allowInsecureAuth": ["security", "access", "network", "advanced"],
  "tools.exec.applyPatch.workspaceOnly": ["tools", "security", "access", "advanced"],
};

/**
 * 基于路径“前缀”的规则。
 * 如果一个配置路径以这里定义的某个前缀开头，它就会被打上相应的标签。
 */
const PREFIX_RULES: Array<{ prefix: string; tags: ConfigTag[] }> = [
  { prefix: "channels.", tags: ["channels", "network"] },
  { prefix: "tools.", tags: ["tools"] },
  { prefix: "gateway.", tags: ["network"] },
  { prefix: "nodehost.", tags: ["network"] },
  { prefix: "discovery.", tags: ["network"] },
  { prefix: "auth.", tags: ["auth", "access"] },
  { prefix: "memory.", tags: ["storage"] },
  { prefix: "models.", tags: ["models"] },
  { prefix: "diagnostics.", tags: ["observability"] },
  { prefix: "logging.", tags: ["observability"] },
  { prefix: "cron.", tags: ["automation"] },
  { prefix: "talk.", tags: ["media"] },
  { prefix: "audio.", tags: ["media"] },
];

/**
 * 基于路径中“关键词”的规则。
 * 如果一个配置路径匹配了某个正则表达式，它就会被打上相应的标签。
 */
const KEYWORD_RULES: Array<{ pattern: RegExp; tags: ConfigTag[] }> = [
  { pattern: /(token|password|secret|api[_.-]?key|tlsfingerprint)/i, tags: ["security", "auth"] },
  { pattern: /(allow|deny|owner|permission|policy|access)/i, tags: ["access"] },
  { pattern: /(timeout|debounce|interval|concurrency|max|limit|cachettl)/i, tags: ["performance"] },
  { pattern: /(retry|backoff|fallback|circuit|health|reload|probe)/i, tags: ["reliability"] },
  { pattern: /(path|dir|file|store|db|session|cache)/i, tags: ["storage"] },
  { pattern: /(telemetry|trace|metrics|logs|diagnostic)/i, tags: ["observability"] },
  { pattern: /(experimental|dangerously|insecure)/i, tags: ["advanced", "security"] },
  { pattern: /(privacy|redact|sanitize|anonym|pseudonym)/i, tags: ["privacy"] },
];

// 更多的特定关键词模式
const MODEL_PATH_PATTERN = /(^|\.)(model|models|modelid|imagemodel)(\.|$)/i;
const MEDIA_PATH_PATTERN = /(tools\.media\.|^audio\.|^talk\.|image|video|stt|tts)/i;
const AUTOMATION_PATH_PATTERN = /(cron|heartbeat|schedule|onstart|watchdebounce)/i;
const AUTH_KEYWORD_PATTERN = /(token|password|secret|api[_.-]?key|credential|oauth)/i;

/**
 * 规范化单个标签字符串，确保它是 `ConfigTag` 类型中的一个有效值。
 */
function normalizeTag(tag: string): ConfigTag | null {
  const normalized = tag.trim().toLowerCase() as ConfigTag;
  return CONFIG_TAGS.includes(normalized) ? normalized : null;
}

/**
 * 规范化一个标签数组：去重并按优先级排序。
 */
function normalizeTags(tags: ReadonlyArray<string>): ConfigTag[] {
  const out = new Set<ConfigTag>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out].toSorted((a, b) => TAG_PRIORITY[a] - TAG_PRIORITY[b]);
}

/**
 * 将一个带通配符的模式字符串转换为正则表达式。
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * 在 `TAG_OVERRIDES` 中查找匹配给定路径的规则。
 */
function resolveOverride(path: string): ConfigTag[] | undefined {
  // 直接匹配
  const direct = TAG_OVERRIDES[path];
  if (direct) {
    return direct;
  }
  // 通配符匹配
  for (const [pattern, tags] of Object.entries(TAG_OVERRIDES)) {
    if (!pattern.includes("*")) {
      continue;
    }
    if (patternToRegExp(pattern).test(path)) {
      return tags;
    }
  }
  return undefined;
}

/**
 * 一个辅助函数，向一个 Set 中添加多个标签。
 */
function addTags(set: Set<ConfigTag>, tags: ReadonlyArray<ConfigTag>): void {
  for (const tag of tags) {
    set.add(tag);
  }
}

/**
 * 【核心】为单个配置路径派生标签。
 * 这是所有规则的应用中心。
 * @param path - 点分表示法的配置路径。
 * @param hint - （可选）与此路径关联的现有 UI 提示，可用于推断更多标签（例如，如果 `sensitive: true`，则添加 "security" 标签）。
 * @returns 一个已去重和排序的标签数组。
 */
export function deriveTagsForPath(path: string, hint?: ConfigUiHint): ConfigTag[] {
  const lowerPath = path.toLowerCase();
  // 1. 检查最高优先级的覆盖规则
  const override = resolveOverride(path);
  if (override) {
    return normalizeTags(override);
  }

  const tags = new Set<ConfigTag>();
  // 2. 应用前缀规则
  for (const rule of PREFIX_RULES) {
    if (lowerPath.startsWith(rule.prefix)) {
      addTags(tags, rule.tags);
    }
  }

  // 3. 应用关键词规则
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(path)) {
      addTags(tags, rule.tags);
    }
  }

  // 4. 应用更具体的模式规则
  if (MODEL_PATH_PATTERN.test(path)) {
    tags.add("models");
  }
  if (MEDIA_PATH_PATTERN.test(path)) {
    tags.add("media");
  }
  if (AUTOMATION_PATH_PATTERN.test(path)) {
    tags.add("automation");
  }

  // 5. 根据现有的 hint 推断标签
  if (hint?.sensitive) {
    tags.add("security");
    if (AUTH_KEYWORD_PATTERN.test(path)) {
      tags.add("auth");
    }
  }
  if (hint?.advanced) {
    tags.add("advanced");
  }

  // 6. 如果经过所有规则后仍然没有标签，则默认给一个 "advanced" 标签。
  if (tags.size === 0) {
    tags.add("advanced");
  }

  // 7. 返回规范化（排序和去重）的标签列表。
  return normalizeTags([...tags]);
}

/**
 * 【主函数】将派生的标签应用到整个 `ConfigUiHints` 对象。
 * 它会遍历 `hints` 对象中的每个条目，并为其计算和添加标签。
 * @param hints - 包含所有字段基本提示的 `ConfigUiHints` 对象。
 * @returns 一个新的、包含了派生标签的 `ConfigUiHints` 对象。
 */
export function applyDerivedTags(hints: ConfigUiHints): ConfigUiHints {
  const next: ConfigUiHints = {};
  for (const [path, hint] of Object.entries(hints)) {
    const existingTags = Array.isArray(hint?.tags) ? hint.tags : [];
    const derivedTags = deriveTagsForPath(path, hint);
    // 将派生的标签与已有的标签合并
    const tags = normalizeTags([...derivedTags, ...existingTags]);
    next[path] = { ...hint, tags };
  }
  return next;
}
