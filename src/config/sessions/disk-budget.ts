// 本文件实现了会话存储的“磁盘预算（Disk Budget）”强制执行逻辑。
// 当会话目录的总大小超过配置的 `maxDiskBytes` 时，它会自动删除最旧的、
// 未被引用的会话文件和存档，直到总大小低于 `highWaterBytes`（高水位线）。
// 这是一个关键的维护功能，用于防止会话数据无限增长并耗尽磁盘空间。

import fs from "node:fs";
import path from "node:path";
import { isPrimarySessionTranscriptFileName, isSessionArchiveArtifactName } from "./artifacts.js";
import { resolveSessionFilePath } from "./paths.js";
import type { SessionEntry } from "./types.js";

/**
 * 会话磁盘预算的配置类型。
 */
export type SessionDiskBudgetConfig = {
  maxDiskBytes: number | null;  // 磁盘占用的最大字节数
  highWaterBytes: number | null; // 清理后要达到的目标字节数（高水位线）
};

/**
 * 磁盘预算清理操作的结果。
 */
export type SessionDiskBudgetSweepResult = {
  totalBytesBefore: number; // 清理前的总字节数
  totalBytesAfter: number;  // 清理后的总字节数
  removedFiles: number;     // 被移除的文件数量
  removedEntries: number;   // 从主存储中被移除的条目数量
  freedBytes: number;       // 释放的总字节数
  maxBytes: number;         // 配置的最大字节数
  highWaterBytes: number;   // 配置的高水位线字节数
  overBudget: boolean;      // 清理前是否超出了预算
};

export type SessionDiskBudgetLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
};

// 一个空的日志记录器，用于在未提供日志器时避免出错。
const NOOP_LOGGER: SessionDiskBudgetLogger = {
  warn: () => {},
  info: () => {},
};

type SessionsDirFileStat = {
  path: string;
  canonicalPath: string; // 解析了符号链接的规范化路径
  name: string;
  size: number;
  mtimeMs: number;
};

/**
 * 规范化文件路径以进行比较，主要是解析符号链接。
 */
function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 估算主会话存储对象（通常是 sessions.json 的内容）序列化后的大小。
 */
function measureStoreBytes(store: Record<string, SessionEntry>): number {
  return Buffer.byteLength(JSON.stringify(store, null, 2), "utf-8");
}

/**
 * 估算主存储中单个条目序列化后的大小。
 * 这比重新序列化整个对象要高效得多。
 */
function measureStoreEntryChunkBytes(key: string, entry: SessionEntry): number {
  const singleEntryStore = JSON.stringify({ [key]: entry }, null, 2);
  if (!singleEntryStore.startsWith("{\n") || !singleEntryStore.endsWith("\n}")) {
    return measureStoreBytes({ [key]: entry }) - 4;
  }
  const chunk = singleEntryStore.slice(2, -2);
  return Buffer.byteLength(chunk, "utf-8");
}

/**
 * 为主存储中的每个条目构建一个大小映射。
 */
function buildStoreEntryChunkSizeMap(store: Record<string, SessionEntry>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, entry] of Object.entries(store)) {
    out.set(key, measureStoreEntryChunkBytes(key, entry));
  }
  return out;
}

/**
 * 获取会话条目的最后更新时间。
 */
function getEntryUpdatedAt(entry?: SessionEntry): number {
  if (!entry) {
    return 0;
  }
  const updatedAt = entry.updatedAt;
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

/**
 * 计算每个 `sessionId` 在主存储中被引用的次数。
 * 这用于判断一个会话记录文件 (`.jsonl`) 是否可以被安全删除。
 */
function buildSessionIdRefCounts(store: Record<string, SessionEntry>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of Object.values(store)) {
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      continue;
    }
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  }
  return counts;
}

/**
 * 解析给定会话条目所对应的会话记录文件 (`.jsonl`) 的路径。
 */
function resolveSessionTranscriptPathForEntry(params: {
  sessionsDir: string;
  entry: SessionEntry;
}): string | null {
  // ... 实现细节，包括路径安全检查 ...
}

/**
 * 查找主存储中所有条目引用的所有唯一的会话记录文件路径。
 */
function resolveReferencedSessionTranscriptPaths(params: {
  sessionsDir: string;
  store: Record<string, SessionEntry>;
}): Set<string> {
  // ... 实现细节 ...
}

/**
 * 读取会话目录下的所有文件及其状态信息。
 */
async function readSessionsDirFiles(sessionsDir: string): Promise<SessionsDirFileStat[]> {
  // ... 实现细节 ...
}

async function removeFileIfExists(filePath: string): Promise<number> {
  // ... 实现细节 ...
}

/**
 * 为执行预算清理而删除一个文件。
 * 支持 `dryRun`（模拟删除）模式。
 */
async function removeFileForBudget(params: {
  filePath: string;
  canonicalPath?: string;
  dryRun: boolean;
  fileSizesByPath: Map<string, number>;
  simulatedRemovedPaths: Set<string>;
}): Promise<number> {
  // ... 实现细节 ...
}

/**
 * 【核心函数】强制执行会话磁盘预算。
 *
 * @param params - 包含主存储内容、路径、预算配置和模式选项的对象。
 * @returns 如果超出了预算，则返回清理结果；否则返回 `null`。
 */
export async function enforceSessionDiskBudget(params: {
  store: Record<string, SessionEntry>; // 主存储对象（会被直接修改！）
  storePath: string;
  activeSessionKey?: string;
  maintenance: SessionDiskBudgetConfig;
  warnOnly: boolean; // 警告模式：只打印警告，不实际删除
  dryRun?: boolean;   // 模拟运行：计算将要删除的内容，但不实际删除
  log?: SessionDiskBudgetLogger;
}): Promise<SessionDiskBudgetSweepResult | null> {
  const maxBytes = params.maintenance.maxDiskBytes;
  const highWaterBytes = params.maintenance.highWaterBytes;
  if (maxBytes == null || highWaterBytes == null) {
    return null;
  }
  
  // 1. 计算当前总磁盘占用
  const files = await readSessionsDirFiles(sessionsDir);
  // ...
  let total = /* ... */;
  const totalBefore = total;

  // 2. 如果未超出预算，则直接返回
  if (total <= maxBytes) {
    return { /* ... overBudget: false ... */ };
  }
  
  // 3. 如果是“仅警告”模式，则打印警告并返回
  if (params.warnOnly) {
    log.warn("session disk budget exceeded (warn-only mode)", { /* ... */ });
    return { /* ... overBudget: true ... */ };
  }

  let removedFiles = 0;
  let removedEntries = 0;
  let freedBytes = 0;

  // 4. 【第一轮清理：删除孤立文件和存档】
  //    - 查找所有存档文件（.bak, .reset, .deleted）。
  //    - 查找所有未被主存储中任何条目引用的 .jsonl 文件。
  //    - 将这些文件按修改时间从旧到新排序。
  const removableFileQueue = files.filter(/* ... */).toSorted((a, b) => a.mtimeMs - b.mtimeMs);
  
  //    - 依次删除这些文件，直到总大小低于高水位线。
  for (const file of removableFileQueue) {
    if (total <= highWaterBytes) {
      break;
    }
    const deletedBytes = await removeFileForBudget({ /* ... */ });
    // ... 更新统计信息 ...
  }

  // 5. 【第二轮清理：删除主存储条目】
  //    如果磁盘占用仍然高于高水位线，则开始删除主存储 (`sessions.json`) 中的条目。
  if (total > highWaterBytes) {
    const sessionIdRefCounts = buildSessionIdRefCounts(params.store);
    const entryChunkBytesByKey = buildStoreEntryChunkSizeMap(params.store);
    // - 按最后更新时间从旧到新对所有条目进行排序。
    const keys = Object.keys(params.store).toSorted((a, b) => /* ... */);

    for (const key of keys) {
      if (total <= highWaterBytes) {
        break;
      }
      // - 跳过当前活动的会话
      if (activeSessionKey && key.trim().toLowerCase() === activeSessionKey) {
        continue;
      }
      
      // - 从主存储中删除条目（直接修改传入的 `params.store` 对象）
      delete params.store[key];
      // ... 更新大小和统计 ...
      removedEntries += 1;

      // - 检查与此条目关联的 .jsonl 文件是否还有其他引用。
      const sessionId = entry.sessionId;
      // ...
      const nextRefCount = (sessionIdRefCounts.get(sessionId) ?? 1) - 1;
      if (nextRefCount > 0) {
        // 如果还有其他引用，则不删除文件
        continue;
      }
      
      // - 如果没有其他引用，则删除对应的 .jsonl 文件。
      const transcriptPath = resolveSessionTranscriptPathForEntry({ /* ... */ });
      if (!transcriptPath) {
        continue;
      }
      const deletedBytes = await removeFileForBudget({ /* ... */ });
      // ... 更新大小和统计 ...
    }
  }

  // 6. 记录清理结果并返回。
  log.info("applied session disk budget cleanup", { /* ... */ });
  return { /* ... */ };
}
