// 本文件是旧版配置迁移逻辑的第三部分，也是最后一部分。
// 它处理一些最新或最复杂的重构。

import {
  buildDefaultControlUiAllowedOrigins,
  hasConfiguredControlUiAllowedOrigins,
  isGatewayNonLoopbackBindMode,
  resolveGatewayPortWithDefault,
} from "./gateway-control-ui-origins.js";
import {
  ensureAgentEntry,
  ensureRecord,
  getAgentsList,
  getRecord,
  isRecord,
  type LegacyConfigMigration,
  mergeMissing,
  resolveDefaultAgentIdFromRaw,
} from "./legacy.shared.js";
import { DEFAULT_GATEWAY_PORT } from "./paths.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

// --- 辅助数据和函数 ---

// 定义了属于 agent 心跳和 channel 心跳的不同配置键
const AGENT_HEARTBEAT_KEYS = new Set([ /* ... */ ]);
const CHANNEL_HEARTBEAT_KEYS = new Set(["showOk", "showAlerts", "useIndicator"]);

/**
 * 将旧的、混合的 `heartbeat` 对象拆分为与 agent 相关的部分和与 channel 相关的部分。
 */
function splitLegacyHeartbeat(legacyHeartbeat: Record<string, unknown>): {
  agentHeartbeat: Record<string, unknown> | null;
  channelHeartbeat: Record<string, unknown> | null;
} {
  const agentHeartbeat: Record<string, unknown> = {};
  const channelHeartbeat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(legacyHeartbeat)) {
    if (isBlockedObjectKey(key)) continue;
    if (CHANNEL_HEARTBEAT_KEYS.has(key)) {
      channelHeartbeat[key] = value;
    } else {
      // 其他所有键（包括未知的）都归入 agentHeartbeat，以便后续验证能发现它们
      agentHeartbeat[key] = value;
    }
  }

  return {
    agentHeartbeat: Object.keys(agentHeartbeat).length > 0 ? agentHeartbeat : null,
    channelHeartbeat: Object.keys(channelHeartbeat).length > 0 ? channelHeartbeat : null,
  };
}

/**
 * 一个通用的辅助函数，用于将一个旧的配置值合并到新的 `defaults` 部分中。
 */
function mergeLegacyIntoDefaults(params: { /* ... */ }) {
  const root = ensureRecord(params.raw, params.rootKey);
  const defaults = ensureRecord(root, "defaults");
  const existing = getRecord(defaults[params.fieldKey]);
  if (!existing) {
    defaults[params.fieldKey] = params.legacyValue;
    params.changes.push(params.movedMessage);
  } else {
    // `defaults` 中的现有值有更高优先级；旧配置只用于填补缺失的字段。
    const merged = structuredClone(existing);
    mergeMissing(merged, params.legacyValue);
    defaults[params.fieldKey] = merged;
    params.changes.push(params.mergedMessage);
  }
  // ...
}

export const LEGACY_CONFIG_MIGRATIONS_PART_3: LegacyConfigMigration[] = [
  // --- 迁移 1: 关键的“热修复”迁移 ---
  // 解决了因 `gateway.bind` 设置为 "lan" 等非环回模式时，
  // 缺少 `gateway.controlUi.allowedOrigins` 而导致的启动崩溃循环问题。
  {
    id: "gateway.controlUi.allowedOrigins-seed-for-non-loopback",
    describe: "为现有的非环回网关安装植入 gateway.controlUi.allowedOrigins",
    apply: (raw, changes) => {
      const gateway = getRecord(raw.gateway);
      if (!gateway || !isGatewayNonLoopbackBindMode(gateway.bind)) {
        return;
      }
      const controlUi = getRecord(gateway.controlUi) ?? {};
      // 如果用户已经配置了 allowedOrigins，则不进行任何操作。
      if (hasConfiguredControlUiAllowedOrigins({ /* ... */ })) {
        return;
      }
      // 植入一个安全的默认值来防止启动崩溃。
      const port = resolveGatewayPortWithDefault(gateway.port, DEFAULT_GATEWAY_PORT);
      const origins = buildDefaultControlUiAllowedOrigins({ /* ... */ });
      gateway.controlUi = { ...controlUi, allowedOrigins: origins };
      raw.gateway = gateway;
      changes.push(`为 bind=${String(gateway.bind)} 植入了 gateway.controlUi.allowedOrigins ${JSON.stringify(origins)}。`);
    },
  },

  // --- 迁移 2: 移动顶层键 ---
  {
    id: "memorySearch->agents.defaults.memorySearch",
    describe: "将顶层的 memorySearch 移动到 agents.defaults.memorySearch",
    apply: (raw, changes) => {
      const legacyMemorySearch = getRecord(raw.memorySearch);
      if (!legacyMemorySearch) return;

      mergeLegacyIntoDefaults({
        raw,
        rootKey: "agents",
        fieldKey: "memorySearch",
        legacyValue: legacyMemorySearch,
        changes,
        movedMessage: "移动了 memorySearch → agents.defaults.memorySearch。",
        mergedMessage: "合并了 memorySearch → agents.defaults.memorySearch。",
      });
      delete raw.memorySearch;
    },
  },

  // --- 迁移 3: 修改特定值 ---
  {
    id: "auth.anthropic-claude-cli-mode-oauth",
    describe: "将 anthropic:claude-cli auth profile 的模式切换为 oauth",
    apply: (raw, changes) => {
      const claudeCli = getRecord(getRecord(getRecord(raw.auth)?.profiles)?.[
        "anthropic:claude-cli"
      ]);
      if (claudeCli?.mode === "token") {
        claudeCli.mode = "oauth";
        changes.push('更新了 auth.profiles["anthropic:claude-cli"].mode → "oauth"。');
      }
    },
  },
  
  // --- 迁移 4: 重命名键 ---
  {
    id: "tools.bash->tools.exec",
    describe: "移动 tools.bash → tools.exec",
    apply: (raw, changes) => { /* ... */ },
  },

  // --- 迁移 5: 转换值的格式 ---
  {
    id: "messages.tts.enabled->auto",
    describe: "移动 messages.tts.enabled → messages.tts.auto",
    apply: (raw, changes) => {
      const tts = getRecord(getRecord(raw.messages)?.tts);
      if (tts?.auto !== undefined) { /* ... 如果新键已存在，则只删除旧键 ... */ return; }
      if (typeof tts.enabled !== "boolean") return;
      // 将布尔值 `true`/`false` 转换为新的枚举值 `"always"`/`"off"`
      tts.auto = tts.enabled ? "always" : "off";
      delete tts.enabled;
      changes.push(`移动了 messages.tts.enabled → messages.tts.auto (${String(tts.auto)})。`);
    },
  },

  // --- 迁移 6: 拆分和重构 `agent` 对象 ---
  {
    id: "agent.defaults-v2",
    describe: "将 agent 配置移动到 agents.defaults 和 tools",
    apply: (raw, changes) => {
      const agent = getRecord(raw.agent);
      if (!agent) return;
      const defaults = getRecord(ensureRecord(raw, "agents").defaults) ?? {};
      const tools = ensureRecord(raw, "tools");

      // 将 agent 下的工具相关设置（如 `tools`, `elevated`, `bash`）移动到顶层的 `tools` 对象。
      // ...
      
      // 将剩余的、非工具相关的设置合并到 `agents.defaults` 中。
      const agentCopy = structuredClone(agent);
      // ... 删除已移动的键 ...
      mergeMissing(defaults, agentCopy);
      
      delete raw.agent;
      changes.push("移动了 agent → agents.defaults。");
    },
  },
  
  // --- 迁移 7: 拆分 `heartbeat` 对象 ---
  {
    id: "heartbeat->agents.defaults.heartbeat",
    describe: "移动顶层 heartbeat 到 agents.defaults.heartbeat/channels.defaults.heartbeat",
    apply: (raw, changes) => {
      const legacyHeartbeat = getRecord(raw.heartbeat);
      if (!legacyHeartbeat) return;

      const { agentHeartbeat, channelHeartbeat } = splitLegacyHeartbeat(legacyHeartbeat);
      if (agentHeartbeat) {
        mergeLegacyIntoDefaults({ /* ... 合并到 agents.defaults.heartbeat ... */ });
      }
      if (channelHeartbeat) {
        mergeLegacyIntoDefaults({ /* ... 合并到 channels.defaults.heartbeat ... */ });
      }
      delete raw.heartbeat;
    },
  },
  
  // --- 迁移 8: 移动到动态确定的目标 ---
  {
    id: "identity->agents.list",
    describe: "移动 identity 到 agents.list[].identity",
    apply: (raw, changes) => {
      const identity = getRecord(raw.identity);
      if (!identity) return;

      // 1. 确定默认 agent 的 ID。
      const defaultId = resolveDefaultAgentIdFromRaw(raw);
      // 2. 在 `agents.list` 中找到或创建该 agent 的条目。
      const entry = ensureAgentEntry(getAgentsList(ensureRecord(raw, "agents")), defaultId);
      // 3. 将 `identity` 对象移动到该条目下。
      if (entry.identity === undefined) {
        entry.identity = identity;
        changes.push(`移动了 identity → agents.list (id "${defaultId}").identity。`);
      }
      delete raw.identity;
    },
  },
];
