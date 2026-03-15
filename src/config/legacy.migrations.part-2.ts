// 本文件是旧版配置迁移逻辑的第二部分。
// 它包含了更复杂的迁移规则，特别是那些涉及将旧的、庞大的 `agent` 和 `routing` 配置
// 重构为更结构化的 `agents.list`、`tools` 和 `messages` 等新部分的规则。

import {
  ensureAgentEntry,
  ensureRecord,
  getAgentsList,
  getRecord,
  isRecord,
  type LegacyConfigMigration,
  mapLegacyAudioTranscription,
  mergeMissing,
} from "./legacy.shared.js";

/**
 * 一个辅助函数，用于迁移旧的音频转录设置。
 */
function applyLegacyAudioTranscriptionModel(params: {
  raw: Record<string, unknown>;
  source: unknown;
  changes: string[];
  movedMessage: string;
  alreadySetMessage: string;
  invalidMessage: string;
}) {
  const mapped = mapLegacyAudioTranscription(params.source);
  if (!mapped) {
    params.changes.push(params.invalidMessage);
    return;
  }
  const tools = ensureRecord(params.raw, "tools");
  const media = ensureRecord(tools, "media");
  const mediaAudio = ensureRecord(media, "audio");
  const models = Array.isArray(mediaAudio.models) ? (mediaAudio.models as unknown[]) : [];
  if (models.length === 0) {
    mediaAudio.enabled = true;
    mediaAudio.models = [mapped];
    params.changes.push(params.movedMessage);
    return;
  }
  params.changes.push(params.alreadySetMessage);
}

export const LEGACY_CONFIG_MIGRATIONS_PART_2: LegacyConfigMigration[] = [
  // --- 迁移 1: 重构 agent 的模型配置 ---
  // 这是一个非常大的迁移，将分散在多个旧键中的模型配置
  // (`agent.model`, `agent.allowedModels`, `agent.modelAliases` 等)
  // 整合到新的、结构化的 `agents.defaults.models` 和 `agents.defaults.model` 对象中。
  {
    id: "agent.model-config-v2",
    describe: "将旧的 agent.model/allowedModels/etc 迁移到新的 agent.models 结构",
    apply: (raw, changes) => {
      const agentRoot = getRecord(raw.agent);
      const defaults = getRecord(getRecord(raw.agents)?.defaults);
      const agent = agentRoot ?? defaults; // 获取旧的 agent 配置
      if (!agent) return;
      const label = agentRoot ? "agent" : "agents.defaults";

      // 1. 读取所有旧的、与模型相关的键
      const legacyModel = typeof agent.model === "string" ? String(agent.model) : undefined;
      const legacyImageModel = typeof agent.imageModel === "string" ? String(agent.imageModel) : undefined;
      const legacyAllowed = Array.isArray(agent.allowedModels) ? agent.allowedModels.map(String) : [];
      // ... 其他旧键 ...

      // 如果没有任何旧键，则无需迁移
      if (!legacyModel && !legacyImageModel && legacyAllowed.length === 0 /* ... */) return;

      const models = isRecord(agent.models) ? (agent.models as Record<string, unknown>) : {};

      // 2. 确保所有在旧配置中引用的模型都在新的 `models` 字典中有一个条目
      const ensureModel = (rawKey?: string) => {
        if (typeof rawKey !== "string") return;
        const key = rawKey.trim();
        if (key && !models[key]) models[key] = {};
      };
      ensureModel(legacyModel);
      legacyAllowed.forEach(ensureModel);
      // ... 为其他旧键调用 ensureModel ...

      // 3. 处理模型别名
      // ...

      // 4. 构建新的 `model` 和 `imageModel` 对象，包含 `primary` 和 `fallbacks`
      if (!isRecord(agent.model) && (legacyModel || legacyModelFallbacks.length > 0)) {
        agent.model = {
          primary: legacyModel,
          fallbacks: legacyModelFallbacks.length > 0 ? legacyModelFallbacks : [],
        };
      }
      // ... 类似地处理 imageModel ...

      agent.models = models;
      changes.push(`迁移了 ${label} 的模型配置到新结构。`);

      // 5. 删除所有旧键
      delete agent.allowedModels;
      delete agent.modelAliases;
      // ...
    },
  },

  // --- 迁移 2: 重构 routing.agents ---
  // 将旧的 `routing.agents` 字典和 `routing.defaultAgentId` 迁移到新的 `agents.list` 数组。
  {
    id: "routing.agents-v2",
    describe: "将 routing.agents/defaultAgentId 移动到 agents.list",
    apply: (raw, changes) => {
      const routing = getRecord(raw.routing);
      if (!routing) return;

      const routingAgents = getRecord(routing.agents);
      const agents = ensureRecord(raw, "agents");
      const list = getAgentsList(agents);

      // 1. 遍历旧的 `routing.agents` 字典
      if (routingAgents) {
        for (const [agentId, entryRaw] of Object.entries(routingAgents)) {
          const entry = getRecord(entryRaw);
          if (!agentId || !entry) continue;

          // 2. 在新的 `agents.list` 中找到或创建一个对应的条目
          const target = ensureAgentEntry(list, agentId);
          // ... 深度合并旧条目的属性到新条目中，并处理嵌套属性 ...
          mergeMissing(target, entry);
        }
        delete routing.agents;
        changes.push("移动了 routing.agents → agents.list。");
      }

      // 3. 处理 `defaultAgentId`
      const defaultAgentId = typeof routing.defaultAgentId === "string" ? routing.defaultAgentId.trim() : "";
      if (defaultAgentId) {
        const hasDefault = list.some((entry) => isRecord(entry) && entry.default === true);
        if (!hasDefault) {
          const entry = ensureAgentEntry(list, defaultAgentId);
          entry.default = true;
          changes.push(`移动了 routing.defaultAgentId → agents.list (id "${defaultAgentId}").default。`);
        }
        delete routing.defaultAgentId;
      }
      // ... 清理工作 ...
    },
  },

  // --- 迁移 3: 重构 `routing` 下的其他键 ---
  // 将 `routing` 对象下的其他几个键移动到它们各自的新家。
  {
    id: "routing.config-v2",
    describe: "移动 routing 下的 bindings/groupChat/queue/agentToAgent/transcribeAudio",
    apply: (raw, changes) => {
      const routing = getRecord(raw.routing);
      if (!routing) return;

      // `routing.bindings` -> `bindings` (顶层)
      if (routing.bindings !== undefined) {
        if (raw.bindings === undefined) {
          raw.bindings = routing.bindings;
          changes.push("移动了 routing.bindings → bindings。");
        }
        delete routing.bindings;
      }

      // `routing.agentToAgent` -> `tools.agentToAgent`
      if (routing.agentToAgent !== undefined) {
        // ...
      }
      
      // ... 其他键的迁移 ...
      
      if (Object.keys(routing).length === 0) {
        delete raw.routing;
      }
    },
  },
  // ...
];
