// 本文件负责将各种默认值和规范化规则应用于 `OpenClawConfig` 对象。
// 用户的配置文件可能不完整，本文件的目的就是用合理的默认值填充空白，
// 确保应用程序的其他部分可以使用一个完整且可预测的配置结构。
// 它就像一个“配置注入器”，能根据上下文智能地应用默认值（例如，自动检测 Anthropic 的认证模式）。

import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { normalizeProviderId, parseModelRef } from "../agents/model-selection.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import { resolveAgentModelPrimaryValue } from "./model-input.js";
import {
  DEFAULT_TALK_PROVIDER,
  normalizeTalkConfig,
  resolveActiveTalkProviderConfig,
  resolveTalkApiKey,
} from "./talk.js";
import type { OpenClawConfig } from "./types.js";
import type { ModelDefinitionConfig } from "./types.models.js";
import { hasConfiguredSecretInput } from "./types.secrets.js";

// 用于跟踪警告是否已经发出
type WarnState = { warned: boolean };
let defaultWarnState: WarnState = { warned: false };

// Anthropic 认证模式的类型
type AnthropicAuthDefaultsMode = "api_key" | "oauth";

// 默认的模型别名映射
const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic 模型
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",

  // OpenAI 模型
  gpt: "openai/gpt-5.4",
  "gpt-mini": "openai/gpt-5-mini",

  // Google Gemini 模型
  gemini: "google/gemini-3.1-pro-preview",
  "gemini-flash": "google/gemini-3-flash-preview",
  "gemini-flash-lite": "google/gemini-3.1-flash-lite-preview",
};

// 默认的模型成本
const DEFAULT_MODEL_COST: ModelDefinitionConfig["cost"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
// 默认的模型输入类型
const DEFAULT_MODEL_INPUT: ModelDefinitionConfig["input"] = ["text"];
// 默认的最大 token 数
const DEFAULT_MODEL_MAX_TOKENS = 8192;

// 类似于模型定义的类型，但部分属性是可选的
type ModelDefinitionLike = Partial<ModelDefinitionConfig> &
  Pick<ModelDefinitionConfig, "id" | "name">;

/**
 * 解析提供商的默认 API 端点。
 */
function resolveDefaultProviderApi(
  providerId: string,
  providerApi: ModelDefinitionConfig["api"] | undefined,
): ModelDefinitionConfig["api"] | undefined {
  if (providerApi) {
    return providerApi;
  }
  // Anthropic 提供商默认使用 "anthropic-messages" API
  return normalizeProviderId(providerId) === "anthropic" ? "anthropic-messages" : undefined;
}

/**
 * 检查值是否为正数。
 */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 解析模型的成本配置，填充缺失的默认值。
 */
function resolveModelCost(
  raw?: Partial<ModelDefinitionConfig["cost"]>,
): ModelDefinitionConfig["cost"] {
  return {
    input: typeof raw?.input === "number" ? raw.input : DEFAULT_MODEL_COST.input,
    output: typeof raw?.output === "number" ? raw.output : DEFAULT_MODEL_COST.output,
    cacheRead: typeof raw?.cacheRead === "number" ? raw.cacheRead : DEFAULT_MODEL_COST.cacheRead,
    cacheWrite:
      typeof raw?.cacheWrite === "number" ? raw.cacheWrite : DEFAULT_MODEL_COST.cacheWrite,
  };
}

/**
 * 智能地解析 Anthropic 的默认认证模式（API 密钥或 OAuth）。
 * 它会检查 auth.profiles, auth.order 和环境变量来做出最佳猜测。
 */
function resolveAnthropicDefaultAuthMode(cfg: OpenClawConfig): AnthropicAuthDefaultsMode | null {
  const profiles = cfg.auth?.profiles ?? {};
  const anthropicProfiles = Object.entries(profiles).filter(
    ([, profile]) => profile?.provider === "anthropic",
  );

  // 检查 `auth.order` 中定义的优先级
  const order = cfg.auth?.order?.anthropic ?? [];
  for (const profileId of order) {
    const entry = profiles[profileId];
    if (!entry || entry.provider !== "anthropic") {
      continue;
    }
    if (entry.mode === "api_key") return "api_key";
    if (entry.mode === "oauth" || entry.mode === "token") return "oauth";
  }

  // 根据已有的 profiles 类型猜测
  const hasApiKey = anthropicProfiles.some(([, profile]) => profile?.mode === "api_key");
  const hasOauth = anthropicProfiles.some(
    ([, profile]) => profile?.mode === "oauth" || profile?.mode === "token",
  );
  if (hasApiKey && !hasOauth) return "api_key";
  if (hasOauth && !hasApiKey) return "oauth";

  // 最后检查环境变量
  if (process.env.ANTHROPIC_OAUTH_TOKEN?.trim()) return "oauth";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "api_key";
  
  return null;
}

/**
 * 解析主模型引用，将别名（如 'opus'）转换为完整的模型 ID。
 */
function resolvePrimaryModelRef(raw?: string): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const aliasKey = trimmed.toLowerCase();
  return DEFAULT_MODEL_ALIASES[aliasKey] ?? trimmed;
}

export type SessionDefaultsOptions = {
  warn?: (message: string) => void;
  warnState?: WarnState;
};

/**
 * 为消息确认（ack）行为应用默认值。
 */
export function applyMessageDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const messages = cfg.messages;
  const hasAckScope = messages?.ackReactionScope !== undefined;
  if (hasAckScope) {
    return cfg;
  }

  const nextMessages = messages ? { ...messages } : {};
  nextMessages.ackReactionScope = "group-mentions"; // 默认在群组提及中发送 ack
  return {
    ...cfg,
    messages: nextMessages,
  };
}

/**
 * 为会话（session）应用默认值，主要是规范化 `mainKey`。
 */
export function applySessionDefaults(
  cfg: OpenClawConfig,
  options: SessionDefaultsOptions = {},
): OpenClawConfig {
  const session = cfg.session;
  if (!session || session.mainKey === undefined) {
    return cfg;
  }

  const trimmed = session.mainKey.trim();
  const warn = options.warn ?? console.warn;
  const warnState = options.warnState ?? defaultWarnState;

  // 主会话的 key 总是 "main"，忽略用户的设置。
  const next: OpenClawConfig = {
    ...cfg,
    session: { ...session, mainKey: "main" },
  };

  if (trimmed && trimmed !== "main" && !warnState.warned) {
    warnState.warned = true;
    warn('session.mainKey 被忽略；主会话始终是 "main"。');
  }

  return next;
}

/**
 * 如果没有在配置中设置，则从环境变量应用 Talk API 密钥。
 */
export function applyTalkApiKey(config: OpenClawConfig): OpenClawConfig {
  const normalized = normalizeTalkConfig(config);
  const resolved = resolveTalkApiKey();
  if (!resolved) {
    return normalized;
  }

  const talk = normalized.talk;
  const active = resolveActiveTalkProviderConfig(talk);
  // 如果已配置了其他提供商，则不覆盖
  if (active?.provider && active.provider !== DEFAULT_TALK_PROVIDER) {
    return normalized;
  }
  
  // 如果已通过 `secrets` 或旧版方式配置了 API 密钥，则不覆盖
  const existingProviderApiKeyConfigured = hasConfiguredSecretInput(active?.config?.apiKey);
  const existingLegacyApiKeyConfigured = hasConfiguredSecretInput(talk?.apiKey);
  if (existingProviderApiKeyConfigured || existingLegacyApiKeyConfigured) {
    return normalized;
  }

  // 注入 API 密钥
  const providerId = active?.provider ?? DEFAULT_TALK_PROVIDER;
  const providers = { ...talk?.providers };
  const providerConfig = { ...providers[providerId], apiKey: resolved };
  providers[providerId] = providerConfig;

  const nextTalk = {
    ...talk,
    apiKey: resolved,
    provider: talk?.provider ?? providerId,
    providers,
  };

  return {
    ...normalized,
    talk: nextTalk,
  };
}

/**
 * 对 Talk 配置进行规范化处理。
 */
export function applyTalkConfigNormalization(config: OpenClawConfig): OpenClawConfig {
  return normalizeTalkConfig(config);
}

/**
 * 为模型定义应用默认值。
 * 遍历所有定义的模型，填充 `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, 和 `api` 等字段。
 */
export function applyModelDefaults(cfg: OpenClawConfig): OpenClawConfig {
  let mutated = false;
  let nextCfg = cfg;

  const providerConfig = nextCfg.models?.providers;
  if (providerConfig) {
    const nextProviders = { ...providerConfig };
    for (const [providerId, provider] of Object.entries(providerConfig)) {
      const models = provider.models;
      if (!Array.isArray(models) || models.length === 0) continue;

      const providerApi = resolveDefaultProviderApi(providerId, provider.api);
      let nextProvider = provider;
      if (providerApi && provider.api !== providerApi) {
        mutated = true;
        nextProvider = { ...nextProvider, api: providerApi };
      }

      let providerMutated = false;
      const nextModels = models.map((model) => {
        const raw = model as ModelDefinitionLike;
        let modelMutated = false;

        const reasoning = raw.reasoning ?? false;
        if (raw.reasoning !== reasoning) modelMutated = true;

        const input = raw.input ?? [...DEFAULT_MODEL_INPUT];
        if (raw.input === undefined) modelMutated = true;

        const cost = resolveModelCost(raw.cost);
        if (JSON.stringify(raw.cost) !== JSON.stringify(cost)) modelMutated = true;
        
        const contextWindow = isPositiveNumber(raw.contextWindow) ? raw.contextWindow : DEFAULT_CONTEXT_TOKENS;
        if (raw.contextWindow !== contextWindow) modelMutated = true;

        const defaultMaxTokens = Math.min(DEFAULT_MODEL_MAX_TOKENS, contextWindow);
        const rawMaxTokens = isPositiveNumber(raw.maxTokens) ? raw.maxTokens : defaultMaxTokens;
        const maxTokens = Math.min(rawMaxTokens, contextWindow);
        if (raw.maxTokens !== maxTokens) modelMutated = true;
        
        const api = raw.api ?? providerApi;
        if (raw.api !== api) modelMutated = true;

        if (!modelMutated) return model;
        providerMutated = true;
        return { ...raw, reasoning, input, cost, contextWindow, maxTokens, api } as ModelDefinitionConfig;
      });

      if (providerMutated || nextProvider !== provider) {
        nextProviders[providerId] = { ...nextProvider, models: nextModels };
        mutated = true;
      }
    }

    if (mutated) {
      nextCfg = { ...nextCfg, models: { ...nextCfg.models, providers: nextProviders } };
    }
  }

  const existingAgent = nextCfg.agents?.defaults;
  if (!existingAgent) return mutated ? nextCfg : cfg;
  
  const existingModels = existingAgent.models ?? {};
  if (Object.keys(existingModels).length === 0 && !mutated) return cfg;

  const nextModels: Record<string, { alias?: string }> = { ...existingModels };
  let modelsMutated = false;
  for (const [alias, target] of Object.entries(DEFAULT_MODEL_ALIASES)) {
    if (nextModels[target] && nextModels[target].alias === undefined) {
      nextModels[target] = { ...nextModels[target], alias };
      modelsMutated = true;
    }
  }

  if (!mutated && !modelsMutated) return cfg;
  return { ...nextCfg, agents: { ...nextCfg.agents, defaults: { ...existingAgent, models: nextModels } } };
}


/**
 * 为代理（agent）应用默认值，主要是并发限制。
 */
export function applyAgentDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const agents = cfg.agents;
  const defaults = agents?.defaults;
  const hasMax = typeof defaults?.maxConcurrent === "number" && Number.isFinite(defaults.maxConcurrent);
  const hasSubMax = typeof defaults?.subagents?.maxConcurrent === "number" && Number.isFinite(defaults.subagents.maxConcurrent);
  if (hasMax && hasSubMax) {
    return cfg;
  }

  let mutated = false;
  const nextDefaults = defaults ? { ...defaults } : {};
  if (!hasMax) {
    nextDefaults.maxConcurrent = DEFAULT_AGENT_MAX_CONCURRENT;
    mutated = true;
  }

  const nextSubagents = defaults?.subagents ? { ...defaults.subagents } : {};
  if (!hasSubMax) {
    nextSubagents.maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT;
    mutated = true;
  }

  if (!mutated) return cfg;

  return { ...cfg, agents: { ...agents, defaults: { ...nextDefaults, subagents: nextSubagents } } };
}

/**
 * 为日志（logging）应用默认值，默认启用敏感信息编辑。
 */
export function applyLoggingDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const logging = cfg.logging;
  if (!logging || logging.redactSensitive) {
    return cfg;
  }
  return { ...cfg, logging: { ...logging, redactSensitive: "tools" } };
}

/**
 * 为上下文修剪（context pruning）和心跳（heartbeat）应用默认值。
 * 特别地，它会根据检测到的 Anthropic 认证模式调整心跳间隔和缓存保留策略。
 */
export function applyContextPruningDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults) return cfg;

  const authMode = resolveAnthropicDefaultAuthMode(cfg);
  if (!authMode) return cfg;

  let mutated = false;
  const nextDefaults = { ...defaults };
  
  if (defaults.contextPruning?.mode === undefined) {
    nextDefaults.contextPruning = { ...defaults.contextPruning, mode: "cache-ttl", ttl: defaults.contextPruning?.ttl ?? "1h" };
    mutated = true;
  }

  if (defaults.heartbeat?.every === undefined) {
    nextDefaults.heartbeat = { ...defaults.heartbeat, every: authMode === "oauth" ? "1h" : "30m" };
    mutated = true;
  }

  if (authMode === "api_key") {
    const nextModels = defaults.models ? { ...defaults.models } : {};
    let modelsMutated = false;
    const isAnthropicCacheRetentionTarget = (parsed?: { provider: string; model: string } | null) =>
      Boolean(parsed && (parsed.provider === "anthropic" || (parsed.provider === "amazon-bedrock" && parsed.model.toLowerCase().includes("anthropic.claude"))));

    Object.entries(nextModels).forEach(([key, entry]) => {
      const parsed = parseModelRef(key, "anthropic");
      if (isAnthropicCacheRetentionTarget(parsed)) {
        const params = (entry as { params?: Record<string, unknown> })?.params ?? {};
        if (typeof params.cacheRetention !== "string") {
          nextModels[key] = { ...(entry as Record<string, unknown>), params: { ...params, cacheRetention: "short" } };
          modelsMutated = true;
        }
      }
    });

    const primary = resolvePrimaryModelRef(resolveAgentModelPrimaryValue(defaults.model) ?? undefined);
    if (primary) {
      const parsedPrimary = parseModelRef(primary, "anthropic");
      if (isAnthropicCacheRetentionTarget(parsedPrimary)) {
        const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
        const params = (nextModels[key] as { params?: Record<string, unknown> })?.params ?? {};
        if (typeof params.cacheRetention !== "string") {
          nextModels[key] = { ...(nextModels[key] as Record<string, unknown>), params: { ...params, cacheRetention: "short" } };
          modelsMutated = true;
        }
      }
    }

    if (modelsMutated) {
      nextDefaults.models = nextModels;
      mutated = true;
    }
  }

  if (!mutated) return cfg;

  return { ...cfg, agents: { ...cfg.agents, defaults: nextDefaults } };
}

/**
 * 为内存压缩（compaction）应用默认值。
 */
export function applyCompactionDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  if (!defaults || defaults.compaction?.mode) {
    return cfg;
  }

  return { ...cfg, agents: { ...cfg.agents, defaults: { ...defaults, compaction: { ...defaults.compaction, mode: "safeguard" } } } };
}

/**
 * (仅供测试使用) 重置会话默认值的警告状态。
 */
export function resetSessionDefaultsWarningForTests() {
  defaultWarnState = { warned: false };
}
