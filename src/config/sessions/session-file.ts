// 本文件包含一个核心的实用函数，用于解析并持久化单个会话的记录文件（transcript file）路径。
//
// **核心职责**:
// 1. **解析路径**: 根据会话ID和其他上下文，确定这个会话的聊天记录（通常是一个 `.jsonl` 文件）应该存储在磁盘的哪个位置。
// 2. **持久化**: 确保这个解析出的文件路径被正确地保存在主会话存储（`sessions.json`）中对应的会话条目（SessionEntry）内。
//
// 这确保了程序在任何时候都能通过 `sessions.json` 准确地找到任何一个会话的聊天记录文件。

import { resolveSessionFilePath } from "./paths.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

/**
 * 解析并持久化一个会话的文件路径。
 *
 * @param params - 包含执行此操作所需的所有上下文的对象。
 * @returns 一个 Promise，解析为一个对象，其中包含：
 *   - `sessionFile`: 解析出的会话记录文件的绝对路径。
 *   - `sessionEntry`: 最新的、包含了正确文件路径的会话条目。
 */
export async function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>; // 对主会话存储的内存引用（会被直接修改）
  storePath: string; // 主会话存储在磁盘上的路径
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry }> {
  const { sessionId, sessionKey, sessionStore, storePath } = params;

  // 1. 确定基础的会话条目。优先使用传入的 `sessionEntry`，其次是在 store 中查找，
  //    如果都找不到，则创建一个新的基础条目。
  const baseEntry = params.sessionEntry ??
    sessionStore[sessionKey] ?? { sessionId, updatedAt: Date.now() };
  
  // 2. 为了向后兼容，如果基础条目没有 `sessionFile`，但提供了一个回退路径，则使用它。
  const fallbackSessionFile = params.fallbackSessionFile?.trim();
  const entryForResolve =
    !baseEntry.sessionFile && fallbackSessionFile
      ? { ...baseEntry, sessionFile: fallbackSessionFile }
      : baseEntry;
      
  // 3. 调用核心的路径解析函数来获取最终的文件路径。
  const sessionFile = resolveSessionFilePath(sessionId, entryForResolve, {
    agentId: params.agentId,
    sessionsDir: params.sessionsDir,
  });

  // 4. 创建一个“持久化”版本的新条目，其中包含了最新的 `sessionId`, `updatedAt` 和 `sessionFile`。
  const persistedEntry: SessionEntry = {
    ...baseEntry,
    sessionId,
    updatedAt: Date.now(),
    sessionFile,
  };

  // 5. 【关键】检查 `sessionId` 或 `sessionFile` 是否发生了变化。
  if (baseEntry.sessionId !== sessionId || baseEntry.sessionFile !== sessionFile) {
    // 如果有变化，说明 `sessions.json` 中的记录已过时或不完整。
    
    // a. 更新内存中的 `sessionStore`。
    sessionStore[sessionKey] = persistedEntry;
    
    // b. 异步地将此项更新写回磁盘上的 `sessions.json` 文件。
    //    这确保了更改被持久化。
    await updateSessionStore(
      storePath,
      (store) => {
        store[sessionKey] = {
          ...store[sessionKey],
          ...persistedEntry,
        };
      },
      params.activeSessionKey ? { activeSessionKey: params.activeSessionKey } : undefined,
    );
    return { sessionFile, sessionEntry: persistedEntry };
  }
  
  // 6. 如果没有变化，只更新内存中的条目（主要是更新 `updatedAt`），无需写盘。
  sessionStore[sessionKey] = persistedEntry;
  return { sessionFile, sessionEntry: persistedEntry };
}
