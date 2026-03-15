/**
 * ACP (Agent Client Protocol) 类型定义
 * 
 * 功能概述：
 * 定义ACP系统中使用的核心类型、常量和配置选项
 * 
 * 主要内容：
 * 1. 来源模式(provenance mode)相关类型和常量
 * 2. ACP会话类型定义
 * 3. ACP服务器配置选项
 * 4. Agent信息常量
 */

import type { SessionId } from "@agentclientprotocol/sdk";
// 从ACP SDK导入SessionId类型

import { VERSION } from "../version.js";
// 导入版本号常量

/**
 * ACP来源模式的所有可能值
 * 
 * 来源模式定义了如何记录和追踪Agent操作的来源信息
 */
export const ACP_PROVENANCE_MODE_VALUES = ["off", "meta", "meta+receipt"] as const;
// - "off": 关闭来源追踪
// - "meta": 只记录元数据
// - "meta+receipt": 记录元数据和完整的接收信息

/**
 * ACP来源模式类型
 * 从ACP_PROVENANCE_MODE_VALUES派生的联合类型
 */
export type AcpProvenanceMode = (typeof ACP_PROVENANCE_MODE_VALUES)[number];

/**
 * 规范化ACP来源模式
 * 将输入字符串转换为标准的来源模式值
 * 
 * @param value - 输入值，可以是任意字符串或undefined
 * @returns 规范化后的来源模式，如果输入无效则返回undefined
 * 
 * 示例：
 * - normalizeAcpProvenanceMode("OFF") -> "off"
 * - normalizeAcpProvenanceMode("Meta") -> "meta"
 * - normalizeAcpProvenanceMode("invalid") -> undefined
 */
export function normalizeAcpProvenanceMode(
  value: string | undefined,
): AcpProvenanceMode | undefined {
  // 如果输入为空，返回undefined
  if (!value) {
    return undefined;
  }
  // 去除首尾空格并转换为小写
  const normalized = value.trim().toLowerCase();
  // 检查是否为有效的来源模式值
  return (ACP_PROVENANCE_MODE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as AcpProvenanceMode)
    : undefined;
}

/**
 * ACP会话类型
 * 表示一个活跃的ACP会话及其状态
 * 
 * @property sessionId - 会话唯一标识符
 * @property sessionKey - 会话密钥，用于会话验证
 * @property cwd - 会话的当前工作目录
 * @property createdAt - 会话创建时间戳（毫秒）
 * @property lastTouchedAt - 会话最后活动时间戳（毫秒）
 * @property abortController - 用于中止会话操作的控制器
 * @property activeRunId - 当前活跃的运行ID，如果没有则返回null
 */
export type AcpSession = {
  sessionId: SessionId; // 会话唯一标识符
  sessionKey: string; // 会话密钥
  cwd: string; // 当前工作目录
  createdAt: number; // 创建时间戳
  lastTouchedAt: number; // 最后活动时间戳
  abortController: AbortController | null; // 中止控制器
  activeRunId: string | null; // 活跃运行ID
};

/**
 * ACP服务器配置选项
 * 定义了启动和配置ACP服务器所需的所有选项
 * 
 * @property gatewayUrl - 网关URL，用于连接到外部网关服务
 * @property gatewayToken - 网关认证令牌
 * @property gatewayPassword - 网关密码
 * @property defaultSessionKey - 默认会话密钥
 * @property defaultSessionLabel - 默认会话标签
 * @property requireExistingSession - 是否要求使用已存在的会话
 * @property resetSession - 是否重置会话
 * @property prefixCwd - 是否在路径前添加当前工作目录
 * @property provenanceMode - 来源追踪模式
 * @property sessionCreateRateLimit - 会话创建速率限制
 * @property verbose - 是否启用详细日志输出
 */
export type AcpServerOptions = {
  gatewayUrl?: string; // 网关URL
  gatewayToken?: string; // 网关认证令牌
  gatewayPassword?: string; // 网关密码
  defaultSessionKey?: string; // 默认会话密钥
  defaultSessionLabel?: string; // 默认会话标签
  requireExistingSession?: boolean; // 是否要求已存在的会话
  resetSession?: boolean; // 是否重置会话
  prefixCwd?: boolean; // 是否添加工作目录前缀
  provenanceMode?: AcpProvenanceMode; // 来源追踪模式
  sessionCreateRateLimit?: { // 会话创建速率限制
    maxRequests?: number; // 最大请求数
    windowMs?: number; // 时间窗口（毫秒）
  };
  verbose?: boolean; // 详细日志
};

/**
 * ACP Agent信息常量
 * 定义了Agent的基本信息，用于标识和版本控制
 * 
 * @property name - Agent名称
 * @property title - Agent显示标题
 * @property version - Agent版本号
 */
export const ACP_AGENT_INFO = {
  name: "openclaw-acp", // Agent名称
  title: "OpenClaw ACP Gateway", // 显示标题
  version: VERSION, // 版本号
};
