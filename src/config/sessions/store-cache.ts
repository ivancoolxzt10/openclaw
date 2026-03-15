// 本文件实现了一个用于会话存储（session store，即 `sessions.json` 的内容）的内存缓存系统。
//
// **目的**:
// `sessions.json` 文件可能很大，频繁地从磁盘读取和解析它会非常低效。
// 这个模块提供了一个简单的内存缓存，将已解析的会话存储对象保存在内存中，
// 以减少磁盘 I/O 并提高性能。
//
// **缓存失效策略**:
// 缓存的有效性通过以下几点来保证：
// 1. **TTL (Time-To-Live)**: 缓存条目在一段时间后会自动过期。
// 2. **文件状态**: 在读取缓存时，会检查原始文件的修改时间（`mtimeMs`）和大小（`sizeBytes`）。
//    如果文件在磁盘上发生了变化，缓存就会被视为无效。

import type { SessionEntry } from "./types.js";

/**
 * 定义缓存中单个条目的结构。
 */
type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>; // 缓存的会话存储对象
  loadedAt: number; // 此条目被加载到缓存时的时间戳（毫秒）
  storePath: string; // 原始文件在磁盘上的路径
  mtimeMs?: number; // 原始文件的最后修改时间
  sizeBytes?: number; // 原始文件的大小
  serialized?: string; // （可选）缓存的原始 JSON 字符串
};

// 使用 Map 作为缓存的存储后端。键是 storePath，值是缓存条目。
const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
// 一个独立的缓存，专门用于存储原始的、序列化后的 JSON 字符串。
const SESSION_STORE_SERIALIZED_CACHE = new Map<string, string>();

/**
 * 清空所有会话存储相关的缓存。
 */
export function clearSessionStoreCaches(): void {
  SESSION_STORE_CACHE.clear();
  SESSION_STORE_SERIALIZED_CACHE.clear();
}

/**
 * 使指定路径的会话存储缓存失效（即从缓存中移除）。
 * @param storePath - 要使其失效的存储文件路径。
 */
export function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
  SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
}

/**
 * 从缓存中获取序列化后的会话存储字符串。
 */
export function getSerializedSessionStore(storePath: string): string | undefined {
  return SESSION_STORE_SERIALIZED_CACHE.get(storePath);
}

/**
 * 将序列化后的会话存储字符串存入缓存。
 */
export function setSerializedSessionStore(storePath: string, serialized?: string): void {
  if (serialized === undefined) {
    SESSION_STORE_SERIALIZED_CACHE.delete(storePath);
    return;
  }
  SESSION_STORE_SERIALIZED_CACHE.set(storePath, serialized);
}

/**
 * 仅丢弃已解析的对象缓存，保留序列化字符串的缓存。
 */
export function dropSessionStoreObjectCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

/**
 * 从缓存中读取会话存储对象。
 * @param params - 包含路径、TTL 和文件状态信息的对象。
 * @returns 如果缓存有效，则返回一个会话存储对象的深拷贝；否则返回 `null`。
 */
export function readSessionStoreCache(params: {
  storePath: string;
  ttlMs: number;
  mtimeMs?: number;
  sizeBytes?: number;
}): Record<string, SessionEntry> | null {
  const cached = SESSION_STORE_CACHE.get(params.storePath);
  if (!cached) {
    return null; // 缓存未命中
  }
  
  // 检查 1: TTL 是否已过期
  const now = Date.now();
  if (now - cached.loadedAt > params.ttlMs) {
    invalidateSessionStoreCache(params.storePath);
    return null; // 缓存过期
  }
  
  // 检查 2: 文件的修改时间或大小是否已改变
  if (params.mtimeMs !== cached.mtimeMs || params.sizeBytes !== cached.sizeBytes) {
    invalidateSessionStoreCache(params.storePath);
    return null; // 文件已改变，缓存失效
  }
  
  // 缓存有效，返回一个深拷贝以防止外部代码意外修改缓存中的对象
  return structuredClone(cached.store);
}

/**
 * 将一个会话存储对象写入缓存。
 * @param params - 包含路径、要缓存的对象和文件状态信息的对象。
 */
export function writeSessionStoreCache(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
  mtimeMs?: number;
  sizeBytes?: number;
  serialized?: string;
}): void {
  // 存入一个深拷贝，确保缓存的独立性
  SESSION_STORE_CACHE.set(params.storePath, {
    store: structuredClone(params.store),
    loadedAt: Date.now(),
    storePath: params.storePath,
    mtimeMs: params.mtimeMs,
    sizeBytes: params.sizeBytes,
    serialized: params.serialized,
  });
  // 如果提供了序列化字符串，也将其存入相应的缓存
  if (params.serialized !== undefined) {
    SESSION_STORE_SERIALIZED_CACHE.set(params.storePath, params.serialized);
  }
}
