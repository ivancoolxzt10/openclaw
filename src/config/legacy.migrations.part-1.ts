// 本文件是旧版配置迁移逻辑的第一部分。
// 它包含一个 `LegacyConfigMigration` 对象数组，其中每个对象都定义了
// 一个从旧配置结构到新配置结构的具体转换。

import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "./discord-preview-streaming.js";
import {
  ensureRecord,
  getRecord,
  isRecord,
  type LegacyConfigMigration,
  mergeMissing,
} from "./legacy.shared.js";

// --- 辅助函数 ---

/**
 * 一个通用的迁移辅助函数，用于修改 `bindings` 数组中的条目。
 */
function migrateBindings(
  raw: Record<string, unknown>,
  changes: string[],
  changeNote: string,
  mutator: (match: Record<string, unknown>) => boolean,
) {
  const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
  if (!bindings) return;

  let touched = false;
  for (const entry of bindings) {
    if (!isRecord(entry)) continue;
    const match = getRecord(entry.match);
    if (!match) continue;

    // 调用 mutator 函数来实际修改 match 对象
    if (!mutator(match)) continue;

    entry.match = match;
    touched = true;
  }

  if (touched) {
    raw.bindings = bindings;
    changes.push(changeNote);
  }
}

/**
 * 确保在给定的配置节中存在一个默认的（通配符 `*`）群组条目。
 */
function ensureDefaultGroupEntry(section: Record<string, unknown>): {
  groups: Record<string, unknown>;
  entry: Record<string, unknown>;
} {
  const groups: Record<string, unknown> = isRecord(section.groups) ? section.groups : {};
  const defaultKey = "*";
  const entry: Record<string, unknown> = isRecord(groups[defaultKey]) ? groups[defaultKey] : {};
  return { groups, entry };
}

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function escapeControlForLog(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/**
 * 为给定的路径迁移 `threadBindings.ttlHours`。
 */
function migrateThreadBindingsTtlHoursForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) {
    return false;
  }

  const hadIdleHours = threadBindings.idleHours !== undefined;
  // 仅在 `idleHours` 不存在时才进行迁移
  if (!hadIdleHours) {
    threadBindings.idleHours = threadBindings.ttlHours;
  }
  delete threadBindings.ttlHours;
  params.owner.threadBindings = threadBindings;

  if (hadIdleHours) {
    params.changes.push(`移除了 ${params.pathPrefix}.threadBindings.ttlHours (因为 ${params.pathPrefix}.threadBindings.idleHours 已存在)。`);
  } else {
    params.changes.push(`移动了 ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours。`);
  }
  return true;
}

// --- 迁移规则定义 ---

/**
 * `LEGACY_CONFIG_MIGRATIONS_PART_1` 是一个迁移规则数组。
 * `legacy.ts` 中的 `applyLegacyMigrations` 函数会遍历这个数组，并为每个规则调用 `apply` 函数。
 * `apply` 函数会直接修改传入的 `raw` 配置对象。
 */
export const LEGACY_CONFIG_MIGRATIONS_PART_1: LegacyConfigMigration[] = [
  // --- 迁移示例 1: 重命名键 ---
  // 将 `bindings[].match.provider` 重命名为 `bindings[].match.channel`
  {
    id: "bindings.match.provider->bindings.match.channel",
    describe: "将 bindings[].match.provider 移动到 bindings[].match.channel",
    apply: (raw, changes) => {
      migrateBindings(
        raw,
        changes,
        "移动了 bindings[].match.provider → bindings[].match.channel。",
        (match) => {
          if (typeof match.channel === "string" && match.channel.trim()) return false;
          const provider = typeof match.provider === "string" ? match.provider.trim() : "";
          if (!provider) return false;
          match.channel = provider;
          delete match.provider;
          return true;
        },
      );
    },
  },
  // ... 其他 `bindings` 相关的重命名 ...

  // --- 迁移示例 2: 移动整个配置节 ---
  // 将顶层的 `whatsapp`, `telegram` 等移动到 `channels.*` 下
  {
    id: "providers->channels",
    describe: "将提供商配置节移动到 channels.*",
    apply: (raw, changes) => {
      const legacyKeys = ["whatsapp", "telegram", "discord", "slack", "signal", "imessage", "msteams"];
      const legacyEntries = legacyKeys.filter((key) => isRecord(raw[key]));
      if (legacyEntries.length === 0) return;

      const channels = ensureRecord(raw, "channels"); // 确保 `channels` 对象存在
      for (const key of legacyEntries) {
        const legacy = getRecord(raw[key]);
        if (!legacy) continue;
        const channelEntry = ensureRecord(channels, key);
        const hadEntries = Object.keys(channelEntry).length > 0;
        mergeMissing(channelEntry, legacy); // 将旧对象的内容合并到新位置
        channels[key] = channelEntry;
        delete raw[key]; // 删除旧的顶层键
        changes.push(hadEntries ? `合并了 ${key} → channels.${key}。` : `移动了 ${key} → channels.${key}。`);
      }
      raw.channels = channels;
    },
  },

  // --- 迁移示例 3: 规范化值 ---
  // 将旧的 `gateway.bind` 主机别名（如 "0.0.0.0"）规范化为新的绑定模式（如 "lan"）
  {
    id: "gateway.bind.host-alias->bind-mode",
    describe: "将 gateway.bind 的主机别名规范化为支持的绑定模式",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway) return;
      const bindRaw = gateway.bind;
      if (typeof bindRaw !== "string") return;

      const normalized = bindRaw.trim().toLowerCase();
      let mapped: "lan" | "loopback" | undefined;
      if (["0.0.0.0", "::", "[::]", "*"].includes(normalized)) {
        mapped = "lan";
      } else if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalized)) {
        mapped = "loopback";
      }

      if (!mapped || normalized === mapped) return;

      gateway.bind = mapped;
      raw.gateway = gateway;
      changes.push(`规范化 gateway.bind "${escapeControlForLog(bindRaw)}" → "${mapped}"。`);
    },
  },

  // ... 其他各种迁移规则 ...
];
