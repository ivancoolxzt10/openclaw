// 本文件负责在运行时为不同的渠道提供商解析生效的“群组策略（group policy）”。
// “群组策略”决定了机器人在群聊中的行为模式（例如 `"open"`, `"allowlist"`, `"disabled"`）。
// 本模块解决的一个关键挑战是：当某个渠道提供商的配置完全缺失时，应该应用什么策略。

import type { GroupPolicy } from "./types.base.js";

/**
 * 运行时群组策略的解析结果。
 */
export type RuntimeGroupPolicyResolution = {
  groupPolicy: GroupPolicy; // 最终生效的策略
  providerMissingFallbackApplied: boolean; // 是否应用了“提供商缺失”的回退策略
};

export type RuntimeGroupPolicyParams = {
  providerConfigPresent: boolean; // 提供商的配置块是否存在
  groupPolicy?: GroupPolicy; // 特定于账户或渠道的策略
  defaultGroupPolicy?: GroupPolicy; // 全局默认策略
  configuredFallbackPolicy?: GroupPolicy; // “已配置但缺少键”时的回退策略
  missingProviderFallbackPolicy?: GroupPolicy; // “未配置”时的回退策略
};

/**
 * 【核心逻辑】解析运行时的群组策略。
 *
 * @returns 返回最终的策略和是否应用了“提供商缺失”回退的标志。
 */
export function resolveRuntimeGroupPolicy(
  params: RuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  // 定义两种回退场景的默认值
  const configuredFallbackPolicy = params.configuredFallbackPolicy ?? "open";
  const missingProviderFallbackPolicy = params.missingProviderFallbackPolicy ?? "allowlist";

  // 【关键判断】根据提供商配置是否存在，来决定使用哪条逻辑链路
  const groupPolicy = params.providerConfigPresent
    // 场景 A: 提供商已配置。解析顺序: 特定策略 -> 全局默认策略 -> “已配置”回退策略 ("open")
    ? (params.groupPolicy ?? params.defaultGroupPolicy ?? configuredFallbackPolicy)
    // 场景 B: 提供商未配置。解析顺序: 特定策略 -> “未配置”回退策略 ("allowlist")
    // 这实现了“故障关闭（fail-closed）”原则：未配置时，默认为最安全的限制性策略。
    : (params.groupPolicy ?? missingProviderFallbackPolicy);
  
  const providerMissingFallbackApplied =
    !params.providerConfigPresent && params.groupPolicy === undefined;
    
  return { groupPolicy, providerMissingFallbackApplied };
}

export type ResolveProviderRuntimeGroupPolicyParams = { /* ... */ };
export type GroupPolicyDefaultsConfig = { /* ... */ };

/**
 * 从配置中解析全局默认的群组策略。
 */
export function resolveDefaultGroupPolicy(cfg: GroupPolicyDefaultsConfig): GroupPolicy | undefined {
  return cfg.channels?.defaults?.groupPolicy;
}

export const GROUP_POLICY_BLOCKED_LABEL = { /* ... */ } as const;

/**
 * “开放”提供商的运行时策略。
 * 这是大多数提供商使用的预设配置。
 * - 如果已配置，回退到 "open"。
 * - 如果未配置，回退到 "allowlist" (故障关闭)。
 */
export function resolveOpenProviderRuntimeGroupPolicy(
  params: ResolveProviderRuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  return resolveRuntimeGroupPolicy({
    ...params,
    configuredFallbackPolicy: "open",
    missingProviderFallbackPolicy: "allowlist",
  });
}

/**
 * “严格”提供商的运行时策略。
 * 总是回退到 "allowlist"。
 */
export function resolveAllowlistProviderRuntimeGroupPolicy(
  params: ResolveProviderRuntimeGroupPolicyParams,
): RuntimeGroupPolicyResolution {
  return resolveRuntimeGroupPolicy({
    ...params,
    configuredFallbackPolicy: "allowlist",
    missingProviderFallbackPolicy: "allowlist",
  });
}

const warnedMissingProviderGroupPolicy = new Set<string>();

/**
 * 当“故障关闭”回退被应用时，向用户打印一次警告。
 * 这会引导用户去正确地配置该渠道，而不是让机器人静默地不工作。
 * 使用 Set 来确保对于同一个渠道和账户，警告只显示一次。
 */
export function warnMissingProviderGroupPolicyFallbackOnce(params: {
  providerMissingFallbackApplied: boolean;
  providerKey: string;
  accountId?: string;
  blockedLabel?: string;
  log: (message: string) => void;
}): boolean {
  if (!params.providerMissingFallbackApplied) {
    return false;
  }
  const key = `${params.providerKey}:${params.accountId ?? "*"}`;
  if (warnedMissingProviderGroupPolicy.has(key)) {
    return false;
  }
  warnedMissingProviderGroupPolicy.add(key);
  const blockedLabel = params.blockedLabel?.trim() || "群组消息";
  params.log(
    `${params.providerKey}: channels.${params.providerKey} 未配置；groupPolicy 默认回退到 "allowlist" (${blockedLabel} 已被阻止，直到被明确配置)。`,
  );
  return true;
}

/**
 * (仅供测试使用) 重置警告缓存。
 */
export function resetMissingProviderGroupPolicyFallbackWarningsForTesting(): void {
  warnedMissingProviderGroupPolicy.clear();
}
