// 本文件实现了会话存储（session store）的“维护（maintenance）”逻辑。
// 这包括自动清理（pruning）旧的会话条目，限制存储中的条目总数，
// 以及在存储文件变得过大时进行“轮换（rotation）”。
// 这些都是为了防止会话数据无限增长，保证系统的长期稳定运行。

import fs from "node:fs";
import path from "node:path";
import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadConfig } from "../config.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

// --- 默认常量 ---
const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 默认30天后清理
const DEFAULT_SESSION_MAX_ENTRIES = 500; // 默认最多保留500个会话条目
const DEFAULT_SESSION_ROTATE_BYTES = 10_485_760; // 默认文件大小超过 10MB 时轮换
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "warn"; // 默认维护模式：仅警告
const DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO = 0.8; // 磁盘预算清理的目标比例

export type SessionMaintenanceWarning = { /* ... */ };

/**
 * 描述一个已解析的、完整的维护配置。
 */
export type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode; // "warn" (仅警告) 或 "enforce" (实际执行)
  pruneAfterMs: number;       // 在多长时间不活动后清理条目（毫秒）
  maxEntries: number;         // 存储中允许的最大条目数
  rotateBytes: number;        // 文件轮换的阈值（字节）
  resetArchiveRetentionMs: number | null; // 重置存档的保留时间
  maxDiskBytes: number | null;        // 会话目录的最大磁盘预算
  highWaterBytes: number | null;      // 磁盘预算清理的目标水位线
};

/**
 * 从配置中解析“清理周期”（pruneAfter）的值。
 * 支持时间字符串（如 "30d", "2w"）和天数。
 */
function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter ?? maintenance?.pruneDays; // 兼容旧的 pruneDays
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(String(raw).trim(), { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

/**
 * 从配置中解析“文件轮换大小”（rotateBytes）的值。
 * 支持字节字符串（如 "10mb", "1gb"）。
 */
function resolveRotateBytes(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.rotateBytes;
  // ... 解析逻辑 ...
}

// ... 其他 resolve* 辅助函数，用于安全地解析配置中的每个维护参数 ...

/**
 * 【主解析函数】从 `openclaw.json` 中解析出完整的维护配置。
 * 它会为每个配置项（如 `pruneAfter`, `maxEntries` 等）调用相应的 `resolve*` 函数，
 * 如果配置中未提供，则使用硬编码的默认值。
 * @returns 一个包含了所有已解析和默认值的 `ResolvedSessionMaintenanceConfig` 对象。
 */
export function resolveMaintenanceConfig(): ResolvedSessionMaintenanceConfig {
  let maintenance: SessionMaintenanceConfig | undefined;
  try {
    maintenance = loadConfig().session?.maintenance;
  } catch {
    // 如果配置不可用（例如在测试中），则使用默认值。
  }
  const pruneAfterMs = resolvePruneAfterMs(maintenance);
  const maxDiskBytes = resolveMaxDiskBytes(maintenance);
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs,
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    rotateBytes: resolveRotateBytes(maintenance),
    resetArchiveRetentionMs: resolveResetArchiveRetentionMs(maintenance, pruneAfterMs),
    maxDiskBytes,
    highWaterBytes: resolveHighWaterBytes(maintenance, maxDiskBytes),
  };
}

/**
 * 【清理操作1】清理过期的条目。
 * 它会遍历存储对象，并删除所有 `updatedAt` 时间戳早于 `pruneAfterMs` 阈值的条目。
 * @param store - 会话存储对象（会被直接修改）。
 * @returns 被清理的条目数量。
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: { log?: boolean; onPruned?: (params: { key: string; entry: SessionEntry }) => void } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfig().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    // 如果条目有更新时间，并且早于截止时间，则删除
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs });
  }
  return pruned;
}

/**
 * 【诊断功能】检查当前活动的会话是否“即将”因为维护策略而被清理。
 * @returns 如果当前会话有被清理的风险，则返回一个包含详细信息的警告对象；否则返回 `null`。
 */
export function getActiveSessionMaintenanceWarning(params: {
  // ...
}): SessionMaintenanceWarning | null {
  // ... 逻辑：检查 activeEntry.updatedAt 是否小于清理阈值，
  // 或者在按数量上限清理时，此条目是否会被排在要删除的行列中。
  if (!wouldPrune && !wouldCap) {
    return null;
  }
  return { /* 警告信息 */ };
}


/**
 * 【清理操作2】限制条目总数。
 * 如果存储中的条目总数超过了 `maxEntries`，此函数会按 `updatedAt` 时间从旧到新排序，
 * 并删除超出限制的条目。
 * @param store - 会话存储对象（会被直接修改）。
 * @returns 被删除的条目数量。
 */
export function capEntryCount(
  store: Record<string, SessionEntry>,
  overrideMax?: number,
  opts: {
    onCapped?: (params: { key: string; entry: SessionEntry }) => void;
  } = {},
): number {
  const maxEntries = overrideMax ?? resolveMaintenanceConfig().maxEntries;
  const keys = Object.keys(store);
  if (keys.length <= maxEntries) {
    return 0;
  }

  // 按更新时间降序排序；没有更新时间的条目排在最后（优先被删除）。
  const sorted = keys.toSorted((a, b) => { /* ... */ });

  // 删除超出上限的部分
  const toRemove = sorted.slice(maxEntries);
  for (const key of toRemove) {
    // ...
    delete store[key];
  }
  // ...
  return toRemove.length;
}

/**
 * 【清理操作3】轮换会话文件。
 * 如果 `sessions.json` 文件大小超过了 `rotateBytes` 阈值：
 * 1. 将当前文件重命名为 `sessions.json.bak.{timestamp}`。
 * 2. 清理旧的备份文件，只保留最新的3个。
 * @param storePath - `sessions.json` 的路径。
 * @returns 如果执行了轮换，则返回 `true`。
 */
export async function rotateSessionFile(
  storePath: string,
  overrideBytes?: number,
): Promise<boolean> {
  const maxBytes = overrideBytes ?? resolveMaintenanceConfig().rotateBytes;

  const fileSize = await getSessionFileSize(storePath);
  if (fileSize == null || fileSize <= maxBytes) {
    return false;
  }

  // 重命名当前文件
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fs.promises.rename(storePath, backupPath);
    log.info("rotated session store file", { /* ... */ });
  } catch {
    return false;
  }

  // 清理旧备份
  try {
    // ... 读取目录，找到所有 .bak.* 文件，排序，删除多余的 ...
  } catch {
    // 尽力而为的清理；不应让主流程失败。
  }

  return true;
}
