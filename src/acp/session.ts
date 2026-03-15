/**
 * ACP会话存储管理
 * 
 * 功能概述：
 * 提供ACP会话的内存存储和管理功能
 * 
 * 主要功能：
 * 1. 创建和管理会话
 * 2. 跟踪会话的活跃状态
 * 3. 清理空闲会话
 * 4. 管理会话的运行状态
 * 
 * 特性：
 * - 支持会话数量限制
 * - 支持空闲超时清理
 * - 支持通过runId查找会话
 * - 支持取消活跃运行
 */

import { randomUUID } from "node:crypto";
// 导入UUID生成函数，用于创建会话ID

import type { AcpSession } from "./types.js";
// 导入ACP会话类型定义

/**
 * ACP会话存储接口
 * 定义了会话存储所需的所有操作
 * 
 * @property createSession - 创建新会话
 * @property hasSession - 检查会话是否存在
 * @property getSession - 获取会话
 * @property getSessionByRunId - 通过运行ID获取会话
 * @property setActiveRun - 设置活跃运行
 * @property clearActiveRun - 清除活跃运行
 * @property cancelActiveRun - 取消活跃运行
 * @property clearAllSessionsForTest - 清除所有会话（仅测试用）
 */
export type AcpSessionStore = {
  createSession: (params: { sessionKey: string; cwd: string; sessionId?: string }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionByRunId: (runId: string) => AcpSession | undefined;
  setActiveRun: (sessionId: string, runId: string, abortController: AbortController) => void;
  clearActiveRun: (sessionId: string) => void;
  cancelActiveRun: (sessionId: string) => boolean;
  clearAllSessionsForTest: () => void;
};

/**
 * ACP会话存储选项
 * 
 * @property maxSessions - 最大会话数，默认5000
 * @property idleTtlMs - 空闲超时（毫秒），默认24小时
 * @property now - 获取当前时间的函数，默认Date.now
 */
type AcpSessionStoreOptions = {
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
};

/**
 * 默认最大会话数
 */
const DEFAULT_MAX_SESSIONS = 5_000;

/**
 * 默认空闲超时（24小时，单位：毫秒）
 */
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * 创建内存会话存储
 * 
 * @param options - 存储选项
 * @returns 会话存储实例
 * 
 * 功能：
 * - 限制最大会话数
 * - 自动清理空闲会话
 * - 支持通过runId查找会话
 */
export function createInMemorySessionStore(options: AcpSessionStoreOptions = {}): AcpSessionStore {
  // 确保最大会话数至少为1
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  // 确保空闲超时至少为1秒
  const idleTtlMs = Math.max(1_000, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
  // 获取当前时间函数
  const now = options.now ?? Date.now;
  // 会话ID到会话的映射
  const sessions = new Map<string, AcpSession>();
  // 运行ID到会话ID的映射
  const runIdToSessionId = new Map<string, string>();

  /**
   * 更新会话的最后访问时间
   */
  const touchSession = (session: AcpSession, nowMs: number) => {
    session.lastTouchedAt = nowMs;
  };

  /**
   * 移除会话
   * @returns 是否成功移除
   */
  const removeSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return false;
    }
    // 如果有活跃运行，删除映射
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    // 中止会话的abortController
    session.abortController?.abort();
    // 从会话映射中删除
    sessions.delete(sessionId);
    return true;
  };

  /**
   * 清理空闲会话
   * 移除超过空闲超时的非活跃会话
   */
  const reapIdleSessions = (nowMs: number) => {
    // 计算空闲阈值
    const idleBefore = nowMs - idleTtlMs;
    // 遍历所有会话
    for (const [sessionId, session] of sessions.entries()) {
      // 跳过活跃会话
      if (session.activeRunId || session.abortController) {
        continue;
      }
      // 跳过未超时的会话
      if (session.lastTouchedAt > idleBefore) {
        continue;
      }
      // 移除空闲会话
      removeSession(sessionId);
    }
  };

  /**
   * 驱逐最旧的空闲会话
   * 当会话数达到上限时调用
   * @returns 是否成功驱除
   */
  const evictOldestIdleSession = () => {
    let oldestSessionId: string | null = null;
    let oldestLastTouchedAt = Number.POSITIVE_INFINITY;
    // 遍历所有会话，找到最旧的空闲会话
    for (const [sessionId, session] of sessions.entries()) {
      // 跳过活跃会话
      if (session.activeRunId || session.abortController) {
        continue;
      }
      // 跳过不是最旧的会话
      if (session.lastTouchedAt >= oldestLastTouchedAt) {
        continue;
      }
      // 更新最旧会话信息
      oldestLastTouchedAt = session.lastTouchedAt;
      oldestSessionId = sessionId;
    }
    // 如果没有找到可驱除的会话
    if (!oldestSessionId) {
      return false;
    }
    // 移除最旧的会话
    return removeSession(oldestSessionId);
  };

  /**
   * 创建会话
   */
  const createSession: AcpSessionStore["createSession"] = (params) => {
    // 获取当前时间
    const nowMs = now();
    // 生成或使用提供的会话ID
    const sessionId = params.sessionId ?? randomUUID();
    // 检查会话是否已存在
    const existingSession = sessions.get(sessionId);
    if (existingSession) {
      // 更新现有会话的属性
      existingSession.sessionKey = params.sessionKey;
      existingSession.cwd = params.cwd;
      touchSession(existingSession, nowMs);
      return existingSession;
    }
    // 清理空闲会话
    reapIdleSessions(nowMs);
    // 检查会话数是否达到上限
    if (sessions.size >= maxSessions && !evictOldestIdleSession()) {
      throw new Error(
        `ACP session limit reached (max ${maxSessions}). Close idle ACP clients and retry.`,
      );
    }
    // 创建新会话
    const session: AcpSession = {
      sessionId,
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      createdAt: nowMs,
      lastTouchedAt: nowMs,
      abortController: null,
      activeRunId: null,
    };
    // 存储会话
    sessions.set(sessionId, session);
    return session;
  };

  /**
   * 检查会话是否存在
   */
  const hasSession: AcpSessionStore["hasSession"] = (sessionId) => sessions.has(sessionId);

  /**
   * 获取会话并更新访问时间
   */
  const getSession: AcpSessionStore["getSession"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      // 更新最后访问时间
      touchSession(session, now());
    }
    return session;
  };

  /**
   * 通过运行ID获取会话
   */
  const getSessionByRunId: AcpSessionStore["getSessionByRunId"] = (runId) => {
    // 查找运行ID对应的会话ID
    const sessionId = runIdToSessionId.get(runId);
    if (!sessionId) {
      return undefined;
    }
    // 获取会话
    const session = sessions.get(sessionId);
    if (session) {
      // 更新最后访问时间
      touchSession(session, now());
    }
    return session;
  };

  /**
   * 设置会话的活跃运行
   */
  const setActiveRun: AcpSessionStore["setActiveRun"] = (sessionId, runId, abortController) => {
    // 获取会话
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    // 设置活跃运行ID
    session.activeRunId = runId;
    // 设置中止控制器
    session.abortController = abortController;
    // 建立运行ID到会话ID的映射
    runIdToSessionId.set(runId, sessionId);
    // 更新最后访问时间
    touchSession(session, now());
  };

  /**
   * 清除会话的活跃运行
   */
  const clearActiveRun: AcpSessionStore["clearActiveRun"] = (sessionId) => {
    // 获取会话
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }
    // 如果有活跃运行，删除映射
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    // 清除活跃运行ID
    session.activeRunId = null;
    // 清除中止控制器
    session.abortController = null;
    // 更新最后访问时间
    touchSession(session, now());
  };

  const cancelActiveRun: AcpSessionStore["cancelActiveRun"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session?.abortController) {
      return false;
    }
    session.abortController.abort();
    if (session.activeRunId) {
      runIdToSessionId.delete(session.activeRunId);
    }
    session.abortController = null;
    session.activeRunId = null;
    touchSession(session, now());
    return true;
  };

  const clearAllSessionsForTest: AcpSessionStore["clearAllSessionsForTest"] = () => {
    for (const session of sessions.values()) {
      session.abortController?.abort();
    }
    sessions.clear();
    runIdToSessionId.clear();
  };

  return {
    createSession,
    hasSession,
    getSession,
    getSessionByRunId,
    setActiveRun,
    clearActiveRun,
    cancelActiveRun,
    clearAllSessionsForTest,
  };
}

export const defaultAcpSessionStore = createInMemorySessionStore();
