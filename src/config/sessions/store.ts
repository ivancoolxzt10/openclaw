// 本文件是会话存储（session store）的中央 I/O 和生命周期管理器。
// 它负责对 `sessions.json` 文件的所有操作，包括：
//
// 1. **加载与缓存**:
//    - `loadSessionStore` 是从磁盘读取 `sessions.json` 的主要入口。
//    - 它实现了一个带 TTL 和文件状态验证的内存缓存（`store-cache.ts`），以减少磁盘读取。
//
// 2. **保存与锁定**:
//    - `updateSessionStore` 和 `saveSessionStore` 是写入文件的主要入口。
//    - 它实现了一个基于文件锁的、非阻塞的异步写入队列 (`withSessionStoreLock`)，
//      以防止多个并发写入操作导致的数据损坏（竞争条件）。
//
// 3. **维护**:
//    - 在每次保存之前，它会自动运行维护任务（来自 `store-maintenance.ts`），
//      例如清理过期条目、限制条目总数、以及在文件过大时进行轮换。
//
// 4. **数据规范化与迁移**:
//    - 在加载后，它会应用迁移脚本（`store-migrations.ts`）来更新旧的数据格式。
//    - 它还会规范化数据，例如，确保投递上下文（deliveryContext）的一致性。

import fs from "node:fs";
import path from "node:path";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  archiveSessionTranscripts,
  cleanupArchivedSessionTranscripts,
} from "../../gateway/session-utils.fs.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
// ... 其他导入 ...
import {
  clearSessionStoreCaches,
  dropSessionStoreObjectCache,
  getSerializedSessionStore,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import {
  capEntryCount,
  enforceSessionDiskBudget,
  getActiveSessionMaintenanceWarning,
  pruneStaleEntries,
  resolveMaintenanceConfig,
  rotateSessionFile,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  normalizeSessionRuntimeModelFields,
  type SessionEntry,
} from "./types.js";

const log = createSubsystemLogger("sessions/store");

// ============================================================================
// 会话存储加载、缓存与规范化
// ============================================================================

const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45秒缓存有效期

// ... 辅助函数 ...

/**
 * 规范化会话存储中的所有条目。
 * 这确保了数据在内存中的一致性，例如，统一 `deliveryContext` 格式。
 */
function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry));
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}


/**
 * 从磁盘加载会话存储文件 (`sessions.json`)。
 *
 * @param storePath - 文件的路径。
 * @param opts - 选项，例如 `skipCache` 来强制从磁盘读取。
 * @returns 一个包含了所有会话条目的对象。
 */
export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  // 1. 如果启用了缓存，则首先尝试从缓存中读取。
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      ttlMs: getSessionStoreTtl(),
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
    });
    if (cached) {
      return cached; // 缓存命中且有效
    }
  }

  // 2. 如果缓存未命中或被禁用，则从磁盘加载。
  //    包含一个针对 Windows 平台的重试逻辑，以处理因文件锁定导致的短暂读取失败。
  let store: Record<string, SessionEntry> = {};
  // ... 重试读取和解析的逻辑 ...
  
  // 3. 对从磁盘加载的数据应用迁移脚本，以更新旧格式。
  applySessionStoreMigrations(store);

  // 4. 如果启用了缓存，则将新加载的数据写入缓存。
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({ /* ... */ });
  }

  // 5. 返回对象的深拷贝，以防止外部代码意外修改缓存。
  return structuredClone(store);
}

// ============================================================================
// 会话存储写入、锁定与维护
// ============================================================================

/**
 * 在不加锁的情况下，将存储对象保存到磁盘。
 * 这个函数包含了所有的“写入前”维护逻辑。
 */
async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
  opts?: SaveSessionStoreOptions,
): Promise<void> {
  // 1. 规范化内存中的存储对象。
  normalizeSessionStore(store);

  // 2. 除非明确跳过，否则执行维护任务。
  if (!opts?.skipMaintenance) {
    const maintenance = { ...resolveMaintenanceConfig(), ...opts?.maintenanceOverride };
    
    if (maintenance.mode === "warn") {
      // 在“仅警告”模式下，只检查并记录问题，不实际修改数据。
      // ...
    } else {
      // 在“强制执行”模式下：
      // a. 清理过期的条目
      const pruned = pruneStaleEntries(store, /* ... */);
      // b. 限制条目总数
      const capped = capEntryCount(store, /* ... */);
      // c. 归档因清理而变得孤立的聊天记录文件
      archiveRemovedSessionTranscripts({ /* ... */ });
      // d. 如果文件大小超过阈值，则进行轮换
      await rotateSessionFile(storePath, maintenance.rotateBytes);
      // e. 强制执行磁盘预算
      await enforceSessionDiskBudget({ /* ... */ });
    }
  }

  // 3. 将最终的存储对象序列化为 JSON 字符串。
  const json = JSON.stringify(store, null, 2);
  // 如果内容没有变化，则无需写盘。
  if (getSerializedSessionStore(storePath) === json) {
    updateSessionStoreWriteCaches({ storePath, store, serialized: json });
    return;
  }

  // 4. 使用原子写入操作将 JSON 字符串写入文件，并更新缓存。
  await writeSessionStoreAtomic({ storePath, store, serialized: json });
}


/**
 * 【核心】更新会话存储。这是推荐的、最安全的写入方式。
 * 它实现了一个“读取-修改-写入”的原子操作模式。
 *
 * @param storePath - `sessions.json` 的路径。
 * @param mutator - 一个函数，它接收当前的存储对象，对其进行修改，并可以返回一个值。
 * @param opts - 保存选项。
 * @returns `mutator` 函数的返回值。
 */
export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
  opts?: SaveSessionStoreOptions,
): Promise<T> {
  // 1. 获取该文件路径的写入锁。
  //    这会确保在当前操作完成之前，没有其他代码可以写入同一个文件。
  return await withSessionStoreLock(storePath, async () => {
    // 2. 在锁内，*重新*从磁盘加载最新的存储状态，以避免覆盖其他并发写入者的更改。
    const store = loadSessionStore(storePath, { skipCache: true });
    // 3. 调用用户提供的 `mutator` 函数来修改 `store` 对象。
    const result = await mutator(store);
    // 4. 调用 `saveSessionStoreUnlocked` 将修改后的 `store` 写回磁盘（包含所有维护步骤）。
    await saveSessionStoreUnlocked(storePath, store, opts);
    return result;
  });
}

// --- 异步写入锁的实现 ---
// 这是一个非阻塞的锁，它为每个文件路径维护一个任务队列。
// 当多个写入请求同时到达时，它们会被放入队列中，然后由 `drainSessionStoreLockQueue`
// 函数按顺序依次执行，确保了写入的原子性。

const LOCK_QUEUES = new Map<string, SessionStoreLockQueue>();

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  // ...
  const promise = new Promise<T>((resolve, reject) => {
    // 将任务（fn）添加到队列中
    queue.pending.push(task);
    // 触发队列处理器
    void drainSessionStoreLockQueue(storePath);
  });
  return await promise;
}

// ... 其他更上层的、用于特定更新场景的便捷函数 ...
// 例如 `updateSessionStoreEntry`, `recordSessionMetaFromInbound`, `updateLastRoute`
// 它们内部都调用了 `updateSessionStore` 来保证写入安全。
