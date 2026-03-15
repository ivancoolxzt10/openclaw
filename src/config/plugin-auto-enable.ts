// 本文件实现了一个“智能”的插件自动启用功能。
// 它的目标是根据用户的配置，自动启用那些必需的插件，从而省去用户手动启用的步骤。
// 例如，如果用户配置了 Telegram 的机器人令牌，那么 `telegram` 插件就应该被自动启用。

import { normalizeProviderId } from "../agents/model-selection.js";
// ... 其他导入 ...
import type { OpenClawConfig } from "./config.js";
import { ensurePluginAllowlisted } from "./plugins-allowlist.js";

type PluginEnableChange = {
  pluginId: string; // 需要启用的插件ID
  reason: string;   // 启用它的原因 (例如 "telegram 已配置")
};

export type PluginAutoEnableResult = {
  config: OpenClawConfig; // 可能被修改后的新配置对象
  changes: string[];      // 描述所有已执行更改的字符串列表
};

// 定义了哪些模型提供商需要特定的认证插件
const PROVIDER_PLUGIN_IDS: Array<{ pluginId: string; providerId: string }> = [
  { pluginId: "google-gemini-cli-auth", providerId: "google-gemini-cli" },
  // ...
];

// --- 一系列用于检测特定功能是否已配置的辅助函数 ---

function hasNonEmptyString(value: unknown): boolean { /* ... */ }
function recordHasKeys(value: unknown): boolean { /* ... */ }

/**
 * 定义了一组用于检测“结构化”渠道是否已配置的启发式规则。
 * 它会检查配置文件中的特定键和相关的环境变量。
 */
const STRUCTURED_CHANNEL_CONFIG_SPECS: Record<string, StructuredChannelConfigSpec> = {
  telegram: { envAny: ["TELEGRAM_BOT_TOKEN"], stringKeys: ["botToken", /*...*/] },
  discord: { envAny: ["DISCORD_BOT_TOKEN"], stringKeys: ["token"] },
  // ... 其他渠道的规则
};

/**
 * 检查一个渠道是否已被用户配置。
 * @param cfg - 配置对象
 * @param channelId - 要检查的渠道 ID
 * @param env - 环境变量
 * @returns {boolean} 如果已配置，则为 true
 */
export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (channelId === "whatsapp") return isWhatsAppConfigured(cfg);
  const spec = STRUCTURED_CHANNEL_CONFIG_SPECS[channelId];
  if (spec) return isStructuredChannelConfigured(cfg, channelId, env, spec);
  return isGenericChannelConfigured(cfg, channelId);
}

/**
 * 检查一个模型提供商是否已被用户配置。
 * 它会检查 `auth.profiles`，`models.providers`，以及所有引用的模型字符串。
 */
function isProviderConfigured(cfg: OpenClawConfig, providerId: string): boolean {
  // ... 实现细节 ...
}

// --- 主要逻辑实现 ---

/**
 * 遍历配置，找出所有因为用户配置了相关功能而“应该”被启用的插件。
 * @returns {PluginEnableChange[]} 一个包含待启用插件和原因的列表。
 */
function resolveConfiguredPlugins(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  registry: PluginManifestRegistry,
): PluginEnableChange[] {
  const changes: PluginEnableChange[] = [];
  
  // 1. 检查所有已知的渠道插件
  for (const channelId of collectCandidateChannelIds(cfg, env)) {
    if (isChannelConfigured(cfg, channelId, env)) {
      const pluginId = resolvePluginIdForChannel(channelId, /* ... */);
      changes.push({ pluginId, reason: `${channelId} 已配置` });
    }
  }

  // 2. 检查所有需要特殊认证插件的模型提供商
  for (const mapping of PROVIDER_PLUGIN_IDS) {
    if (isProviderConfigured(cfg, mapping.providerId)) {
      changes.push({ pluginId: mapping.pluginId, reason: `${mapping.providerId} 认证已配置` });
    }
  }
  
  // 3. 检查 ACPX 插件
  if (/* acp 已配置 */) {
    changes.push({ pluginId: "acpx", reason: "ACP 运行时已配置" });
  }

  return changes;
}

/**
 * 检查用户是否在配置中明确禁用了某个插件。
 */
function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  // ... 实现细节 ...
}

/**
 * 检查插件是否在 `plugins.deny` 列表中。
 */
function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  // ... 实现细节 ...
}

/**
 * 检查是否应该跳过某个插件的自动启用，因为存在一个“更优先”的已配置插件。
 * 例如，如果插件A "优于" 插件B，并且用户配置了插件A，那么即使插件B也被检测到需要启用，我们也不应该自动启用它。
 */
function shouldSkipPreferredPluginAutoEnable(
  // ...
): boolean {
  // ... 实现细节 ...
}

/**
 * 修改配置对象，将指定插件的 `enabled` 状态设置为 `true`。
 */
function registerPluginEntry(cfg: OpenClawConfig, pluginId: string): OpenClawConfig {
  // ... 实现细节 ...
}

/**
 * 格式化要显示给用户的、描述自动启用操作的消息。
 */
function formatAutoEnableChange(entry: PluginEnableChange): string {
  // ...
  return `${reason}, 已自动启用。`;
}

/**
 * 应用插件自动启用逻辑。这是本模块的主要入口点。
 */
export function applyPluginAutoEnable(params: { /* ... */ }): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  // ...
  // 1. 获取所有应该被启用的插件列表
  const configured = resolveConfiguredPlugins(params.config, env, registry);
  if (configured.length === 0) {
    return { config: params.config, changes: [] };
  }

  let next = params.config;
  const changes: string[] = [];

  // 如果用户全局禁用了所有插件，则直接返回。
  if (next.plugins?.enabled === false) {
    return { config: next, changes };
  }

  // 2. 遍历待启用列表，并应用启用逻辑
  for (const entry of configured) {
    // 3. 执行一系列检查，以尊重用户的明确配置
    if (isPluginDenied(next, entry.pluginId)) continue; // 检查是否被拒绝
    if (isPluginExplicitlyDisabled(next, entry.pluginId)) continue; // 检查是否被明确禁用
    if (shouldSkipPreferredPluginAutoEnable(next, entry, configured, env)) continue; // 检查是否有更优先的插件
    
    // ...
    // 如果所有检查都通过
    
    // 4. 修改配置以启用插件
    next = registerPluginEntry(next, entry.pluginId);
    // 5. 确保插件在 `allow` 列表中（如果 `allow` 列表被使用）
    next = ensurePluginAllowlisted(next, entry.pluginId);
    changes.push(formatAutoEnableChange(entry));
  }

  return { config: next, changes };
}
