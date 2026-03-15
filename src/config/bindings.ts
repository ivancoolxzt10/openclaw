// 本文件提供了一组用于处理 OpenClaw 配置中“绑定（bindings）”的实用函数。
// “绑定”似乎是将代理（agent）连接到“路由（routes）”或“ACP”的配置项。
// 这些函数有助于安全地访问和分类这些绑定。

import type { OpenClawConfig } from "./config.js";
import type { AgentAcpBinding, AgentBinding, AgentRouteBinding } from "./types.agents.js";

/**
 * 规范化绑定类型。
 * 这是一个辅助函数，用于统一绑定的 `type` 属性。
 * 如果类型明确是 "acp"，则返回 "acp"；否则，默认为 "route"。
 * @param binding 要规范化类型的绑定对象。
 * @returns "route" 或 "acp"。
 */
function normalizeBindingType(binding: AgentBinding): "route" | "acp" {
  return binding.type === "acp" ? "acp" : "route";
}

/**
 * 检查一个绑定是否是“路由（route）”绑定。
 * 这是一个类型保护函数，它使用 `normalizeBindingType` 来进行判断。
 * @param binding 要检查的绑定对象。
 * @returns 如果是路由绑定，则返回 `true`。
 */
export function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding {
  return normalizeBindingType(binding) === "route";
}

/**
 * 检查一个绑定是否是“ACP”绑定。
 * 这是一个类型保护函数。
 * @param binding 要检查的绑定对象。
 * @returns 如果是 ACP 绑定，则返回 `true`。
 */
export function isAcpBinding(binding: AgentBinding): binding is AgentAcpBinding {
  return normalizeBindingType(binding) === "acp";
}

/**
 * 从配置对象中安全地获取所有已配置的绑定。
 * @param cfg OpenClaw 配置对象。
 * @returns 绑定对象的数组，如果配置中没有绑定，则返回空数组。
 */
export function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

/**
 * 从配置中筛选并返回所有的“路由（route）”绑定。
 * @param cfg OpenClaw 配置对象。
 * @returns “路由”绑定对象的数组。
 */
export function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[] {
  return listConfiguredBindings(cfg).filter(isRouteBinding);
}

/**
 * 从配置中筛选并返回所有的“ACP”绑定。
 * @param cfg OpenClaw 配置对象。
 * @returns “ACP”绑定对象的数组。
 */
export function listAcpBindings(cfg: OpenClawConfig): AgentAcpBinding[] {
  return listConfiguredBindings(cfg).filter(isAcpBinding);
}
