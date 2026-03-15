// 本文件提供了一组简单的实用函数，用于解析和规范化代理的 `model` 配置。
// `model` 配置支持两种格式：
// 1. 一个简单的字符串（仅表示主模型）。
// 2. 一个包含 `primary` 和 `fallbacks` 属性的对象。
// 本模块旨在优雅地处理这两种格式，使其他代码能以统一的方式处理模型配置。

import type { AgentModelConfig } from "./types.agents-shared.js";

/**
 * 代表模型列表的对象格式 `{ primary, fallbacks }`。
 */
type AgentModelListLike = {
  primary?: string;
  fallbacks?: string[];
};

/**
 * 解析并返回主（primary）模型的值。
 * 无论 `model` 配置是字符串还是对象，此函数都能正确提取出主模型 ID。
 * @param model 代理的模型配置。
 * @returns 主模型的 ID 字符串，如果未配置或为空，则返回 `undefined`。
 */
export function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined {
  // 如果是字符串格式
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed || undefined;
  }
  // 如果是对象格式
  if (!model || typeof model !== "object") {
    return undefined;
  }
  const primary = model.primary?.trim();
  return primary || undefined;
}

/**
 * 解析并返回备用（fallback）模型的列表。
 * @param model 代理的模型配置。
 * @returns 一个包含备用模型 ID 的字符串数组。如果配置不是对象格式，则返回空数组。
 */
export function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[] {
  if (!model || typeof model !== "object") {
    return [];
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}

/**
 * 将任意格式的 `model` 配置规范化为统一的对象格式 (`AgentModelListLike`)。
 * 这对于希望以一致、结构化的方式处理模型配置的代码非常有用。
 * @param model 代理的模型配置。
 * @returns `AgentModelListLike` 格式的对象，或在无效时返回 `undefined`。
 */
export function toAgentModelListLike(model?: AgentModelConfig): AgentModelListLike | undefined {
  if (typeof model === "string") {
    const primary = model.trim();
    return primary ? { primary } : undefined;
  }
  if (!model || typeof model !== "object") {
    return undefined;
  }
  return model;
}
