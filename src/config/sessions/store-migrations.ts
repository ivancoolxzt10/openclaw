// 本文件包含用于对会话存储（session store）对象执行“就地迁移（in-place migrations）”的逻辑。
//
// 当 `SessionEntry` 的数据结构发生变化时（例如，一个字段被重命名），就需要迁移。
// 此函数会遍历存储中的所有会话条目，并将旧的字段名或结构更新为新的格式。
// 这是一个“尽力而为（best-effort）”的操作，旨在平滑地处理版本间的 schema 变更。

import type { SessionEntry } from "./types.js";

/**
 * 将所有会话存储迁移规则应用于给定的存储对象。
 * **注意**: 这个函数会直接修改（mutate）传入的 `store` 对象。
 *
 * @param store - 从 `sessions.json` 加载的会话存储对象。
 */
export function applySessionStoreMigrations(store: Record<string, SessionEntry>): void {
  // 遍历存储中的每一个会话条目
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;

    // --- 迁移 1: 将 `provider` 重命名为 `channel` ---
    // 这是为了在整个代码库中统一术语。
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    // 同时处理 `lastProvider` -> `lastChannel`
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // --- 迁移 2: 将旧的 `room` 字段重命名为 `groupChannel` ---
    // 新名称 `groupChannel` 更具描述性。
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      // 如果新字段不存在但旧字段存在，则迁移值。
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      // 如果新字段已存在，或旧字段值无效，则只删除旧字段以完成清理。
      delete rec.room;
    }
  }
}
