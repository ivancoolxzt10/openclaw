// 本文件处理一个名为 `dangerouslyAllowNameMatching` 的功能标志。
// 从名称上看，这是一个有潜在风险的功能，默认是关闭的。
// 本文件的功能是收集所有启用了此功能的配置“范围（scopes）”，
// 这些范围可以是在“提供商”级别（例如 `channels.slack`），也可以是在提供商内部的“账户”级别（例如 `channels.slack.accounts.my-account`）。

import type { OpenClawConfig } from "./config.js";

/**
 * 定义一个可能包含 `dangerouslyAllowNameMatching` 标志的配置对象的类型。
 */
export type DangerousNameMatchingConfig = {
  dangerouslyAllowNameMatching?: boolean;
};

/**
 * 定义一个“提供商危险名称匹配范围”的类型。
 * 一个范围是一个对象，包含了关于此功能在一个特定配置块中是否启用的所有信息。
 */
export type ProviderDangerousNameMatchingScope = {
  /**
   * 到达此配置块的点分路径前缀（例如 "channels.slack.accounts.my-account"）。
   */
  prefix: string;
  /**
   * 该范围对应的实际配置对象。
   */
  account: Record<string, unknown>;
  /**
   * 在此范围内，该功能是否“有效”启用。
   * “有效”意味着如果账户级别没有设置，它会继承提供商级别的设置。
   */
  dangerousNameMatchingEnabled: boolean;
  /**
   * 决定 `dangerousNameMatchingEnabled` 值的那个标志的确切路径。
   * 用于调试或生成清晰的错误/警告信息。
   */
  dangerousFlagPath: string;
};

/**
 * 一个类型安全的转换函数，确保值是一个对象记录。
 */
function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * 一个类型安全的转换函数，将值转换为布尔值或 undefined。
 */
function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 检查 `dangerouslyAllowNameMatching` 标志是否在给定的配置对象上被明确设置为 `true`。
 */
export function isDangerousNameMatchingEnabled(
  config: DangerousNameMatchingConfig | null | undefined,
): boolean {
  return config?.dangerouslyAllowNameMatching === true;
}

/**
 * 收集给定提供商的所有“危险名称匹配范围”。
 * 它会遍历提供商本身以及该提供商下的所有账户，为每一个创建一个范围。
 * @param cfg 全局 OpenClaw 配置。
 * @param provider 提供商的名称（例如 "slack"）。
 * @returns 一个包含所有已识别范围的数组。
 */
export function collectProviderDangerousNameMatchingScopes(
  cfg: OpenClawConfig,
  provider: string,
): ProviderDangerousNameMatchingScope[] {
  const scopes: ProviderDangerousNameMatchingScope[] = [];
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return scopes;
  }

  const providerCfg = asObjectRecord(channels[provider]);
  if (!providerCfg) {
    return scopes;
  }

  // --- 处理提供商级别的范围 ---
  const providerPrefix = `channels.${provider}`;
  const providerDangerousFlagPath = `${providerPrefix}.dangerouslyAllowNameMatching`;
  const providerDangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(providerCfg);

  scopes.push({
    prefix: providerPrefix,
    account: providerCfg,
    dangerousNameMatchingEnabled: providerDangerousNameMatchingEnabled,
    dangerousFlagPath: providerDangerousFlagPath,
  });

  // --- 处理该提供商下所有账户的范围 ---
  const accounts = asObjectRecord(providerCfg.accounts);
  if (!accounts) {
    return scopes;
  }

  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (!account) {
      continue;
    }

    const accountPrefix = `${providerPrefix}.accounts.${key}`;
    const accountDangerousNameMatching = asOptionalBoolean(account.dangerouslyAllowNameMatching);

    scopes.push({
      prefix: accountPrefix,
      account,
      // 账户级别的有效值：如果账户本身设置了该标志，则使用该值；否则，继承提供商级别的值。
      dangerousNameMatchingEnabled:
        accountDangerousNameMatching ?? providerDangerousNameMatchingEnabled,
      // 标志的来源路径：如果账户级别未设置，则来源路径指向提供商的标志。
      dangerousFlagPath:
        accountDangerousNameMatching == null
          ? providerDangerousFlagPath
          : `${accountPrefix}.dangerouslyAllowNameMatching`,
    });
  }

  return scopes;
}
