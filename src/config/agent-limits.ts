// 本文件定义了与代理（agent）和子代理（sub-agent）并发执行相关的限制。
// 这些设置有助于控制系统资源的使用，防止过多的并发进程导致性能问题。

import type { OpenClawConfig } from "./types.js";

/**
 * 默认的代理最大并发数。
 * 这限制了可以同时运行的顶层代理的数量。
 */
export const DEFAULT_AGENT_MAX_CONCURRENT = 4;

/**
 * 默认的子代理最大并发数。
 * 这限制了由一个代理派生出的可以同时运行的子代理的数量。
 */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;

/**
 * 默认的子代理最大派生深度。
 * 除非在配置中明确选择加入嵌套，否则保持深度为1的子代理作为叶子节点。
 * 这可以防止无限的递归派生。
 */
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;

/**
 * 从配置中解析代理的最大并发数。
 * 如果配置中提供了有效的数字，则使用该数字。否则，返回默认值。
 * @param cfg OpenClaw 配置对象。
 * @returns 解析后的最大并发数，最小为1。
 */
export function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.maxConcurrent;
  // 检查配置值是否为有效的有限数。
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // 确保值至少为1，并取整数部分。
    return Math.max(1, Math.floor(raw));
  }
  // 如果没有提供或无效，则返回默认值。
  return DEFAULT_AGENT_MAX_CONCURRENT;
}

/**
 * 从配置中解析子代理的最大并发数。
 * 如果配置中提供了有效的数字，则使用该数字。否则，返回默认值。
 * @param cfg OpenClaw 配置对象。
 * @returns 解析后的最大并发数，最小为1。
 */
export function resolveSubagentMaxConcurrent(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.subagents?.maxConcurrent;
  // 检查配置值是否为有效的有限数。
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // 确保值至少为1，并取整数部分。
    return Math.max(1, Math.floor(raw));
  }
  // 如果没有提供或无效，则返回默认值。
  return DEFAULT_SUBAGENT_MAX_CONCURRENT;
}
