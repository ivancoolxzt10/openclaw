// 本文件是为配置 schema 生成“UI 提示（UI Hints）”的元数据中心。
// 这些“提示”是关于每个配置字段的额外信息，例如它在 UI 中应如何显示（标签）、
// 其作用的详细描述（帮助文本）、以及它是否包含敏感信息。
// 这使得 UI 能够动态地、智能地渲染配置编辑器。

import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { applyDerivedTags } from "./schema.tags.js";
import { sensitive } from "./zod-schema.sensitive.js";

const log = createSubsystemLogger("config/schema");

// 重新导出核心类型，以便其他模块可以方便地使用它们。
export type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

/**
 * 一个字典，为顶层的配置分组定义人类可读的标签。
 * 例如，`gateway` 键将被显示为 "Gateway"。
 */
const GROUP_LABELS: Record<string, string> = {
  wizard: "Wizard",
  update: "Update",
  cli: "CLI",
  diagnostics: "Diagnostics",
  logging: "Logging",
  gateway: "Gateway",
  nodeHost: "Node Host",
  agents: "Agents",
  tools: "Tools",
  bindings: "Bindings",
  audio: "Audio",
  models: "Models",
  messages: "Messages",
  commands: "Commands",
  session: "Session",
  cron: "Cron",
  hooks: "Hooks",
  ui: "UI",
  browser: "Browser",
  talk: "Talk",
  channels: "Messaging Channels",
  skills: "Skills",
  plugins: "Plugins",
  discovery: "Discovery",
  presence: "Presence",
  voicewake: "Voice Wake",
};

/**
 * 定义了配置分组在 UI 中显示的顺序。
 * 数字越小，位置越靠前。
 */
const GROUP_ORDER: Record<string, number> = {
  wizard: 20,
  update: 25,
  cli: 26,
  diagnostics: 27,
  gateway: 30,
  nodeHost: 35,
  agents: 40,
  tools: 50,
  bindings: 55,
  audio: 60,
  models: 70,
  messages: 80,
  commands: 85,
  session: 90,
  cron: 100,
  hooks: 110,
  ui: 120,
  browser: 130,
  talk: 140,
  channels: 150,
  skills: 200,
  plugins: 205,
  discovery: 210,
  presence: 220,
  voicewake: 230,
  logging: 900,
};

/**
 * 为特定的配置字段提供在输入框中显示的占位符文本。
 */
const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.remote.url": "ws://host:18789",
  "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
  "gateway.remote.sshTarget": "user@host",
  "gateway.controlUi.basePath": "/openclaw",
  "gateway.controlUi.root": "dist/control-ui",
  "gateway.controlUi.allowedOrigins": "https://control.example.com",
  "gateway.push.apns.relay.baseUrl": "https://relay.example.com",
  "channels.mattermost.baseUrl": "https://chat.example.com",
  "agents.list[].identity.avatar": "avatars/openclaw.png",
};

/**
 * 一个白名单，包含了那些看起来像敏感键（例如包含 "token"），但实际上不是的字段名后缀。
 * 这可以防止误将非敏感字段（如 `maxTokens`）标记为敏感。
 */
const SENSITIVE_KEY_WHITELIST_SUFFIXES = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordFile",
] as const;
const NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES = SENSITIVE_KEY_WHITELIST_SUFFIXES.map((suffix) =>
  suffix.toLowerCase(),
);

/**
 * 用于“猜测”一个字段是否为敏感字段的正则表达式数组。
 * 如果一个字段的路径匹配这些模式之一，它就会被认为是敏感的。
 */
const SENSITIVE_PATTERNS = [
  /token$/i,
  /password/i,
  /secret/i,
  /api.?key/i,
  /serviceaccount(?:ref)?$/i,
];

/**
 * 检查一个路径是否在敏感键的白名单中。
 */
function isWhitelistedSensitivePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
}

/**
 * 检查一个路径是否匹配任何敏感模式。
 */
function matchesSensitivePattern(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * 【核心】判断一个给定的配置路径是否应被视为“敏感”的。
 * 一个路径是敏感的，如果它匹配敏感模式，并且不在白名单中。
 * @param path 点分表示法的配置路径。
 * @returns 如果路径是敏感的，则为 `true`。
 */
export function isSensitiveConfigPath(path: string): boolean {
  return !isWhitelistedSensitivePath(path) && matchesSensitivePattern(path);
}

/**
 * 构建基础的 UI 提示对象。
 * 它会从 `GROUP_LABELS`, `FIELD_LABELS`, `FIELD_HELP`, `FIELD_PLACEHOLDERS` 等常量中
 * 聚合所有预定义的元数据，形成一个初始的 `ConfigUiHints` 对象。
 * @returns 基础的 `ConfigUiHints` 对象。
 */
export function buildBaseHints(): ConfigUiHints {
  const hints: ConfigUiHints = {};
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    hints[group] = {
      label,
      group: label,
      order: GROUP_ORDER[group],
    };
  }
  for (const [path, label] of Object.entries(FIELD_LABELS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, label } : { label };
  }
  for (const [path, help] of Object.entries(FIELD_HELP)) {
    const current = hints[path];
    hints[path] = current ? { ...current, help } : { help };
  }
  for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, placeholder } : { placeholder };
  }
  // 最后，应用派生标签（例如，基于其他标签自动生成）
  return applyDerivedTags(hints);
}

/**
 * 将“猜测”出的敏感提示应用到 `hints` 对象中。
 * 它会遍历所有键，并使用 `isSensitiveConfigPath` 来决定是否将 `sensitive: true` 添加到提示中。
 * @param hints 基础的 `ConfigUiHints` 对象。
 * @param allowedKeys （可选）一个键的集合，只有在这个集合中的键才会被处理。
 * @returns 应用了敏感标志的新 `ConfigUiHints` 对象。
 */
export function applySensitiveHints(
  hints: ConfigUiHints,
  allowedKeys?: ReadonlySet<string>,
): ConfigUiHints {
  const next = { ...hints };
  for (const key of Object.keys(next)) {
    if (allowedKeys && !allowedKeys.has(key)) {
      continue;
    }
    // 如果 `sensitive` 标志已被明确设置，则跳过
    if (next[key]?.sensitive !== undefined) {
      continue;
    }
    // 否则，进行猜测
    if (isSensitiveConfigPath(key)) {
      next[key] = { ...next[key], sensitive: true };
    }
  }
  return next;
}

// 这是一个 TypeScript 的技巧，用于检查一个 Zod schema 是否是可“解包”的
// （即，是否有一个 `unwrap()` 方法，像 `z.optional()` 或 `z.default()` 那样）。
interface ZodDummy {
  unwrap: () => z.ZodType;
}
function isUnwrappable(object: unknown): object is ZodDummy {
  return (
    !!object &&
    typeof object === "object" &&
    "unwrap" in object &&
    typeof (object as Record<string, unknown>).unwrap === "function" &&
    !(object instanceof z.ZodArray) // 数组本身不可解包
  );
}

/**
 * 【核心】一个递归函数，它遍历一个 Zod schema，并根据 schema 的结构和元数据
 * （特别是 `sensitive` 标记）来填充 `ConfigUiHints` 对象。
 * @param schema 要遍历的 Zod schema。
 * @param path 当前的配置路径。
 * @param hints 正在构建的 `ConfigUiHints` 对象。
 * @returns 更新后的 `ConfigUiHints` 对象。
 */
export function mapSensitivePaths(
  schema: z.ZodType,
  path: string,
  hints: ConfigUiHints,
): ConfigUiHints {
  let next = { ...hints };
  let currentSchema = schema;
  // 检查当前 schema 或其任何包装器是否被 `sensitive.mark()` 标记过
  let isSensitive = sensitive.has(currentSchema);

  // 循环解包，直到找到最底层的核心 schema 类型
  while (isUnwrappable(currentSchema)) {
    currentSchema = currentSchema.unwrap();
    isSensitive ||= sensitive.has(currentSchema);
  }

  if (isSensitive) {
    // 如果被标记为敏感，则在 hints 中记录下来
    next[path] = { ...next[path], sensitive: true };
  } else if (isSensitiveConfigPath(path) && !next[path]?.sensitive) {
    // 如果它看起来像敏感的但未被标记，则打印一个调试日志
    log.debug(`possibly sensitive key found: (${path})`);
  }

  // 根据 schema 的类型进行递归遍历
  if (currentSchema instanceof z.ZodObject) {
    const shape = currentSchema.shape;
    for (const key in shape) {
      const nextPath = path ? `${path}.${key}` : key;
      next = mapSensitivePaths(shape[key], nextPath, next);
    }
    // 处理 `catchall` (用于像 `Record<string, ...>` 这样的类型)
    const catchallSchema = currentSchema._def.catchall as z.ZodType | undefined;
    if (catchallSchema && !(catchallSchema instanceof z.ZodNever)) {
      const nextPath = path ? `${path}.*` : "*";
      next = mapSensitivePaths(catchallSchema, nextPath, next);
    }
  } else if (currentSchema instanceof z.ZodArray) {
    const nextPath = path ? `${path}[]` : "[]";
    next = mapSensitivePaths(currentSchema.element as z.ZodType, nextPath, next);
  } else if (currentSchema instanceof z.ZodRecord) {
    const nextPath = path ? `${path}.*` : "*";
    next = mapSensitivePaths(currentSchema._def.valueType as z.ZodType, nextPath, next);
  } else if (
    currentSchema instanceof z.ZodUnion ||
    currentSchema instanceof z.ZodDiscriminatedUnion
  ) {
    for (const option of currentSchema.options) {
      next = mapSensitivePaths(option as z.ZodType, path, next);
    }
  } else if (currentSchema instanceof z.ZodIntersection) {
    next = mapSensitivePaths(currentSchema._def.left as z.ZodType, path, next);
    next = mapSensitivePaths(currentSchema._def.right as z.ZodType, path, next);
  }

  return next;
}

/**
 * (内部使用) 导出一个包含 `mapSensitivePaths` 的对象，以便在测试中可以访问它。
 * @internal
 */
export const __test__ = {
  mapSensitivePaths,
};
