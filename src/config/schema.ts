// 本文件是配置 Schema（结构定义）的生成和查询中心。
// 它的核心职责是将使用 Zod 定义的底层 TypeScript schema 转换为一个标准的 JSON Schema，
// 并将所有 UI 相关的元数据（来自 schema.hints, schema.labels, schema.tags 等文件）
// 合并进去，形成一个可供外部（如 Web UI）使用的、完整的、自描述的配置规范。

import crypto from "node:crypto";
import { CHANNEL_IDS } from "../channels/registry.js";
import { VERSION } from "../version.js";
import type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";
import { applySensitiveHints, buildBaseHints, mapSensitivePaths } from "./schema.hints.js";
import { applyDerivedTags } from "./schema.tags.js";
// 导入由 Zod 定义的基础 schema
import { OpenClawSchema } from "./zod-schema.js";

export type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";

/**
 * 从 Zod schema 生成的 JSON Schema 的类型。
 */
export type ConfigSchema = ReturnType<typeof OpenClawSchema.toJSONSchema>;

type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
};

// 用于防止原型链污染的被阻止的键
const FORBIDDEN_LOOKUP_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
// ... 用于从 schema 中剥离非核心信息的键集合 ...
const LOOKUP_SCHEMA_STRING_KEYS = new Set([ /* ... */ ]);
const LOOKUP_SCHEMA_NUMBER_KEYS = new Set([ /* ... */ ]);
const LOOKUP_SCHEMA_BOOLEAN_KEYS = new Set([ /* ... */ ]);
const MAX_LOOKUP_PATH_SEGMENTS = 32;

function cloneSchema<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (type === "object") {
    return true;
  }
  if (Array.isArray(type) && type.includes("object")) {
    return true;
  }
  return Boolean(schema.properties || schema.additionalProperties);
}

/**
 * 深度合并两个 JSON Schema 对象。
 */
function mergeObjectSchema(base: JsonSchemaObject, extension: JsonSchemaObject): JsonSchemaObject {
  const mergedRequired = new Set<string>([...(base.required ?? []), ...(extension.required ?? [])]);
  const merged: JsonSchemaObject = {
    ...base,
    ...extension,
    properties: {
      ...base.properties,
      ...extension.properties,
    },
  };
  if (mergedRequired.size > 0) {
    merged.required = Array.from(mergedRequired);
  }
  const additional = extension.additionalProperties ?? base.additionalProperties;
  if (additional !== undefined) {
    merged.additionalProperties = additional;
  }
  return merged;
}

/**
 * 最终返回给客户端的、完整的配置 Schema 响应的类型。
 */
export type ConfigSchemaResponse = {
  schema: ConfigSchema;     // JSON Schema
  uiHints: ConfigUiHints;   // UI 元数据
  version: string;          // 应用版本
  generatedAt: string;      // 生成时间
};

// ...

export type PluginUiMetadata = { /* ... */ };
export type ChannelUiMetadata = { /* ... */ };


/**
 * 【核心】将从插件（plugins）和渠道（channels）中获取的 UI 提示（hints）应用到基础 hints 对象上。
 * 这是实现插件化 UI 的关键。
 */
function applyPluginHints(hints: ConfigUiHints, plugins: PluginUiMetadata[]): ConfigUiHints { /* ... */ }
function applyChannelHints(hints: ConfigUiHints, channels: ChannelUiMetadata[]): ConfigUiHints { /* ... */ }
// ...

/**
 * 【核心】将插件和渠道定义的 JSON Schema 合并到主 schema 中。
 */
function applyPluginSchemas(schema: ConfigSchema, plugins: PluginUiMetadata[]): ConfigSchema {
  // ... 逻辑 ...
  // 它会找到 `plugins.entries`，并为每个插件的 `config` 字段插入其自定义的 schema。
  return next;
}
function applyChannelSchemas(schema: ConfigSchema, channels: ChannelUiMetadata[]): ConfigSchema {
  // ... 逻辑 ...
  // 它会找到 `channels`，并为每个渠道（如 `channels.discord`）插入其自定义的 schema。
  return next;
}


// --- 缓存机制 ---
// 因为 schema 和 hints 的生成（特别是合并插件和渠道后）可能是一个昂贵的操作，
// 所以这里使用了缓存来避免重复计算。
let cachedBase: ConfigSchemaResponse | null = null;
const mergedSchemaCache = new Map<string, ConfigSchemaResponse>();
const MERGED_SCHEMA_CACHE_MAX = 64;

/**
 * 为给定的插件和渠道组合生成一个唯一的缓存键。
 */
function buildMergedSchemaCacheKey(params: {
  plugins: PluginUiMetadata[];
  channels: ChannelUiMetadata[];
}): string {
  // ... 实现细节：对插件和渠道元数据进行排序和哈希 ...
  return hash.digest("hex");
}

/**
 * 构建基础的、不含任何插件或渠道扩展的配置 schema 和 hints。
 * 结果会被缓存。
 */
function buildBaseConfigSchema(): ConfigSchemaResponse {
  if (cachedBase) {
    return cachedBase;
  }
  // 1. 从 Zod schema 生成 JSON Schema
  const schema = OpenClawSchema.toJSONSchema({ /* ... */ });
  // 2. 构建基础的 UI hints（标签、帮助文本等）
  const baseHints = buildBaseHints();
  // 3. 从 schema 中推断敏感字段和标签
  const hints = applyDerivedTags(mapSensitivePaths(OpenClawSchema, "", baseHints));
  
  const next = {
    schema: stripChannelSchema(schema), // 移除一些不需要暴露给 UI 的部分
    uiHints: hints,
    version: VERSION,
    generatedAt: new Date().toISOString(),
  };
  cachedBase = next;
  return next;
}

/**
 * 【主函数】构建最终的、完整的配置 schema 响应。
 *
 * @param params - （可选）包含插件和渠道元数据的对象。
 * @returns 一个包含了合并后 schema 和 hints 的 `ConfigSchemaResponse` 对象。
 */
export function buildConfigSchema(params?: {
  plugins?: PluginUiMetadata[];
  channels?: ChannelUiMetadata[];
}): ConfigSchemaResponse {
  const base = buildBaseConfigSchema();
  const plugins = params?.plugins ?? [];
  const channels = params?.channels ?? [];

  // 如果没有插件或渠道扩展，直接返回缓存的基础版本
  if (plugins.length === 0 && channels.length === 0) {
    return base;
  }

  // 检查合并后的 schema 是否已有缓存
  const cacheKey = buildMergedSchemaCacheKey({ plugins, channels });
  const cached = mergedSchemaCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 1. 合并 UI Hints
  const mergedWithoutSensitiveHints = applyHeartbeatTargetHints(
    applyChannelHints(applyPluginHints(base.uiHints, plugins), channels),
    channels,
  );
  // ... 应用敏感和派生标签 ...
  const mergedHints = /* ... */
  
  // 2. 合并 JSON Schema
  const mergedSchema = applyChannelSchemas(applyPluginSchemas(base.schema, plugins), channels);

  // 3. 组装最终结果并存入缓存
  const merged = {
    ...base,
    schema: mergedSchema,
    uiHints: mergedHints,
  };
  setMergedSchemaCache(cacheKey, merged);
  return merged;
}


// --- Schema 查询功能 ---

/**
 * 在一个完整的 `ConfigSchemaResponse` 中查找特定路径的 schema 和 UI 提示。
 * 这使得 UI 可以为用户点击或关注的任何一个配置项动态地显示其详细信息。
 *
 * @param response - 完整的 schema 响应对象。
 * @param path - 要查询的点分路径 (例如 "gateway.auth.token")。
 * @returns 一个包含该路径的 schema、hint 和子节点信息的结果对象，如果路径无效则返回 `null`。
 */
export function lookupConfigSchema(
  response: ConfigSchemaResponse,
  path: string,
): ConfigSchemaLookupResult | null {
  // ... 路径解析和验证 ...

  let current = asSchemaObject(response.schema);
  if (!current) {
    return null;
  }
  // 1. 遍历路径，深入到 schema 树的指定位置
  for (const segment of parts) {
    const next = resolveLookupChildSchema(current, segment);
    if (!next) {
      return null;
    }
    current = next;
  }

  // 2. 在 UI hints 中查找最匹配的提示（支持通配符）
  const resolvedHint = resolveUiHintMatch(response.uiHints, normalizedPath);
  
  // 3. 构建并返回结果，包括子节点的摘要信息
  return {
    path: normalizedPath,
    schema: stripSchemaForLookup(current), // 清理 schema，只保留 UI 需要的字段
    hint: resolvedHint?.hint,
    hintPath: resolvedHint?.path,
    children: buildLookupChildren(current, normalizedPath, response.uiHints),
  };
}
