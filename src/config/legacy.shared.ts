// 本文件包含在不同 `legacy.migrations` 文件之间共享的辅助函数和类型定义。
// 它的目的是提供可复用的工具，使迁移脚本本身更清晰、可读性更高、重复性更少。
// 这是一种典型的“共享”工具模块。

export type LegacyConfigRule = {
  path: string[];
  message: string;
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
  // 如果为 true，则仅当旧版值存在于原始解析的源中时才报告
  // （而不仅仅是在 include/env 解析之后）。
  requireSourceLiteral?: boolean;
};

export type LegacyConfigMigration = {
  id: string; // 迁移的唯一标识符
  describe: string; // 对迁移目的的简短描述
  apply: (raw: Record<string, unknown>, changes: string[]) => void; // 执行迁移的函数
};

import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { isRecord } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
export { isRecord }; // 重新导出 isRecord 类型保护

/**
 * 一个便捷函数，如果值是一个记录（普通对象），则返回该值，否则返回 null。
 */
export const getRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

/**
 * 一个会产生副作用的辅助函数。它确保在根对象上的指定键是一个记录。
 * 如果键不存在或其值不是对象，它会在此处创建一个空对象并返回它。
 * 这对于安全地向可能不存在的嵌套对象添加属性非常有用。
 * @param root 根对象。
 * @param key 要确保为记录的键。
 * @returns 存在或新建的记录对象。
 */
export const ensureRecord = (
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const existing = root[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
};

/**
 * 一种特殊的“深度合并”函数。它递归地将 `source` 对象的属性复制到 `target` 对象，
 * 但 **仅当 `target` 中尚不存在该键时** 才复制。
 * 这对于将旧设置移动到新结构而不覆盖用户可能已经配置的新式设置至关重要。
 */
export const mergeMissing = (target: Record<string, unknown>, source: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
};

/**
 * 一个特定的辅助函数，将旧的 `transcription` 对象映射到 `tools.media.audio.models` 所需的新格式。
 */
export const mapLegacyAudioTranscription = (value: unknown): Record<string, unknown> | null => {
  const transcriber = getRecord(value);
  const command = Array.isArray(transcriber?.command) ? transcriber?.command : null;
  if (!command || command.length === 0 || typeof command[0] !== "string" || !isSafeExecutableValue(command[0].trim())) {
    return null;
  }
  // ... 其他验证和转换逻辑 ...
  const result: Record<string, unknown> = { command: command[0].trim(), type: "cli" };
  // ...
  return result;
};

/**
 * 从 `agents` 配置对象中安全地获取 `list` 数组。
 */
export const getAgentsList = (agents: Record<string, unknown> | null) => {
  const list = agents?.list;
  return Array.isArray(list) ? list : [];
};

/**
 * 一个复杂的辅助函数，通过在旧配置结构的多个位置查找来确定用户预期的“默认代理”。
 * 查找顺序：agents.list 中 `default: true` 的条目 -> 旧的 `routing.defaultAgentId` -> `agents.list` 中的第一个条目。
 */
export const resolveDefaultAgentIdFromRaw = (raw: Record<string, unknown>) => {
  const agents = getRecord(raw.agents);
  const list = getAgentsList(agents);
  const defaultEntry = list.find(/* ... */);
  if (defaultEntry) return (defaultEntry as { id: string }).id.trim();

  const routingDefault = typeof getRecord(raw.routing)?.defaultAgentId === "string" ? getRecord(raw.routing)!.defaultAgentId as string : "";
  if (routingDefault) return routingDefault.trim();

  const firstEntry = list.find(/* ... */);
  if (firstEntry) return (firstEntry as { id: string }).id.trim();
  
  return "main";
};

/**
 * 一个会产生副作用的辅助函数，用于 `agents.list` 数组。
 * 它查找具有给定 `id` 的代理。如果找到，则返回它。
 * 如果没有找到，它会创建一个具有该 `id` 的新代理对象，将其推入列表，然后返回新创建的对象。
 */
export const ensureAgentEntry = (list: unknown[], id: string): Record<string, unknown> => {
  const normalized = id.trim();
  const existing = list.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === "string" && entry.id.trim() === normalized,
  );
  if (existing) {
    return existing;
  }
  const created: Record<string, unknown> = { id: normalized };
  list.push(created);
  return created;
};
