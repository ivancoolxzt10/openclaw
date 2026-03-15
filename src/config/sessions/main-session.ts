// 本文件包含用于解析“主会话（main session）”密钥的逻辑。
// “主会话”通常指的是一个代理（agent）的默认、非群组、非话题的对话。
// 这些函数根据全局配置（如会话作用域、默认代理等）来确定这个主会话的
// 唯一标识符（sessionKey）。

import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { loadConfig } from "../config.js";
import type { SessionScope } from "./types.js";

/**
 * 【核心】解析整个应用的“主会话密钥”。
 *
 * @param cfg - （可选）OpenClaw 的配置对象。
 * @returns 主会话的唯一密钥字符串。
 */
export function resolveMainSessionKey(cfg?: {
  session?: { scope?: SessionScope; mainKey?: string };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  // 1. 如果会话作用域（scope）被配置为 "global"，那么所有会话都共享同一个全局会话，
  //    其密钥就是 "global"。
  if (cfg?.session?.scope === "global") {
    return "global";
  }
  // 2. 否则，主会话是与“默认代理”绑定的。
  const agents = cfg?.agents?.list ?? [];
  //    - 查找被标记为 `default: true` 的代理。
  //    - 如果没有，则使用列表中的第一个代理。
  //    - 如果列表为空，则使用一个硬编码的默认代理ID。
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(defaultAgentId);
  // 3. 规范化 `mainKey` (通常默认为 "main")。
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  // 4. 使用代理ID和 mainKey 构建最终的会话密钥（例如 `agent:my-agent:main`）。
  return buildAgentMainSessionKey({ agentId, mainKey });
}

/**
 * 一个便捷的包装函数，它会先加载全局配置，然后调用 `resolveMainSessionKey`。
 */
export function resolveMainSessionKeyFromConfig(): string {
  return resolveMainSessionKey(loadConfig());
}

// 重新导出，方便其他模块使用。
export { resolveAgentIdFromSessionKey };

/**
 * 为一个*特定*的代理ID解析其主会话密钥。
 * 与 `resolveMainSessionKey` 不同，这个函数接收一个明确的 agentId。
 * @param params - 包含配置和 agentId 的对象。
 * @returns 该代理的主会话密钥。
 */
export function resolveAgentMainSessionKey(params: {
  cfg?: { session?: { mainKey?: string } };
  agentId: string;
}): string {
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  return buildAgentMainSessionKey({ agentId: params.agentId, mainKey });
}

/**
 * 为一个*明确指定*的代理ID解析其会话密钥。
 * 如果没有提供 agentId，则返回 undefined。
 */
export function resolveExplicitAgentSessionKey(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId?: string | null;
}): string | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) {
    return undefined;
  }
  return resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
}

/**
 * 规范化一个可能是“主会话别名”的会话密钥。
 * 用户可能会使用像 "main" 这样的短语来指代主会话，这个函数会将这些别名
 * 转换为完整的、规范的会话密钥。
 *
 * @param params - 包含配置、当前代理ID和用户提供的会话密钥的对象。
 * @returns 规范化后的完整会话密钥。如果输入不是一个别名，则原样返回。
 */
export function canonicalizeMainSessionAlias(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId: string;
  sessionKey: string;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) {
    return raw;
  }

  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  const agentMainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  // `agent:my-agent:main` 的一个别名
  const agentMainAliasKey = buildAgentMainSessionKey({
    agentId,
    mainKey: "main",
  });

  // 检查输入是否是已知的别名之一
  const isMainAlias =
    raw === "main" || raw === mainKey || raw === agentMainSessionKey || raw === agentMainAliasKey;

  // 如果是别名，并且作用域是全局，则返回 "global"
  if (params.cfg?.session?.scope === "global" && isMainAlias) {
    return "global";
  }
  // 如果是别名，则返回完整的、规范的密钥
  if (isMainAlias) {
    return agentMainSessionKey;
  }
  // 否则，原样返回
  return raw;
}
