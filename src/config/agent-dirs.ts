// Copyright 2024 OpenClaw. 版权所有。
// 本源代码的使用受 BSD 风格的许可证约束，
// 该许可证可在 LICENSE 文件中找到。

// 本文件提供用于管理代理特定目录的实用工具。
// 它确保每个代理都有一个唯一的目录，以防止状态损坏
// 和身份验证问题，这在多代理设置中至关重要。

import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveStateDir } from "./paths.js";
import type { OpenClawConfig } from "./types.js";

/**
 * 表示一个重复的代理目录，列出目录路径和共享该目录的代理 ID。
 * 此类型用于识别和报告多个代理配置为使用同一目录的冲突。
 */
export type DuplicateAgentDir = {
  /**
   * 被共享目录的绝对路径。
   */
  agentDir: string;
  /**
   * 配置为使用同一个 `agentDir` 的所有代理 ID 的列表。
   */
  agentIds: string[];
};

/**
 * 当多个代理被配置为使用同一个代理目录时抛出的错误。
 * 这是一个问题，因为它可能导致状态损坏和身份验证问题，
 * 因为每个代理的状态和凭据会相互覆盖。
 */
export class DuplicateAgentDirError extends Error {
  /**
   * 一个对象列表，每个对象详细说明一个重复的目录和涉及的代理 ID。
   */
  readonly duplicates: DuplicateAgentDir[];

  /**
   * 构造一个新的 DuplicateAgentDirError。
   * @param duplicates 一个包含重复目录详细信息的数组。
   */
  constructor(duplicates: DuplicateAgentDir[]) {
    // 根据重复数据格式化一个用户友好的错误消息。
    super(formatDuplicateAgentDirError(duplicates));
    this.name = "DuplicateAgentDirError";
    this.duplicates = duplicates;
  }
}

/**
 * 将代理目录路径规范化，以提供跨平台的一致表示。
 * 它将路径解析为绝对路径，并在不区分大小写的文件系统（Windows、macOS）上将其转换为小写，
 * 以确保像 "/path/to/dir" 和 "/Path/To/Dir" 这样的路径被视为相同。
 * @param agentDir 要规范化的代理目录路径。
 * @returns 规范化的绝对路径字符串。
 */
function canonicalizeAgentDir(agentDir: string): string {
  // 将路径解析为绝对路径。
  const resolved = path.resolve(agentDir);
  // 在 Windows 和 macOS 上，文件系统通常不区分大小写，因此我们转换为小写。
  if (process.platform === "darwin" || process.platform === "win32") {
    return resolved.toLowerCase();
  }
  // 在区分大小写的系统（如 Linux）上，我们按原样返回解析后的路径。
  return resolved;
}

/**
 * 收集配置中引用的所有唯一的代理 ID。
 * 这包括默认代理、在 `agents.list` 数组中明确列出的所有代理，
 * 以及在通道绑定中指定的任何代理。
 * @param cfg OpenClaw 配置对象。
 * @returns 一个唯一的、规范化的代理 ID 数组。
 */
function collectReferencedAgentIds(cfg: OpenClawConfig): string[] {
  // 使用 Set 自动处理代理 ID 的唯一性。
  const ids = new Set<string>();

  // 提取代理列表，如果不存在则默认为空数组。
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  // 确定默认代理 ID。它是标记为 'default' 的代理、列表中的第一个代理，或一个备用常量。
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  // 将规范化的默认代理 ID 添加到集合中。
  ids.add(normalizeAgentId(defaultAgentId));

  // 遍历所有配置的代理并将其 ID 添加到集合中。
  for (const entry of agents) {
    if (entry?.id) {
      ids.add(normalizeAgentId(entry.id));
    }
  }

  // 如果存在，从绑定中提取代理 ID。
  const bindings = cfg.bindings;
  if (Array.isArray(bindings)) {
    for (const binding of bindings) {
      const id = binding?.agentId;
      // 如果绑定具有有效的代理 ID，则将其添加到集合中。
      if (typeof id === "string" && id.trim()) {
        ids.add(normalizeAgentId(id));
      }
    }
  }

  // 将 ID 集合转换为数组。
  return [...ids];
}

/**
 * 根据配置解析给定代理 ID 的有效目录。
 * 如果为代理配置了特定的 `agentDir`，则使用该目录。否则，在应用程序的主状态目录中
 * 构建一个默认路径。
 * @param cfg OpenClaw 配置对象。
 * @param agentId 需要解析其目录的代理的 ID。
 * @param deps 用于环境变量和主目录解析的可选依赖项，主要用于测试目的。
 * @returns 解析后的代理目录的绝对路径。
 */
function resolveEffectiveAgentDir(
  cfg: OpenClawConfig,
  agentId: string,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): string {
  // 规范化代理 ID 以确保一致的查找。
  const id = normalizeAgentId(agentId);
  // 查找代理的特定配置，看是否设置了自定义的 `agentDir`。
  const configured = Array.isArray(cfg.agents?.list)
    ? cfg.agents?.list.find((agent) => normalizeAgentId(agent.id) === id)?.agentDir
    : undefined;
  
  // 如果配置了自定义目录，则相对于用户路径进行解析。
  const trimmed = configured?.trim();
  if (trimmed) {
    return resolveUserPath(trimmed);
  }

  // 如果未设置自定义目录，则构造一个默认路径。
  // 使用提供的环境和主目录依赖项，或回退到系统默认值。
  const env = deps?.env ?? process.env;
  const root = resolveStateDir(
    env,
    deps?.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)),
  );
  // 默认路径是 <STATE_DIR>/agents/<AGENT_ID>/agent。
  return path.join(root, "agents", id, "agent");
}

/**
 * 扫描配置以查找多个代理共享同一个代理目录的实例。
 * 这是一个关键检查，以防止在多代理环境中出现状态和身份验证冲突。
 * @param cfg OpenClaw 配置对象。
 * @param deps 用于测试的可选依赖项，允许注入环境和主目录。
 * @returns 一个 `DuplicateAgentDir` 对象数组，每个对象对应一个由多个代理共享的目录。
 */
export function findDuplicateAgentDirs(
  cfg: OpenClawConfig,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): DuplicateAgentDir[] {
  // 一个 Map，用于按其规范化的目录路径对代理 ID 进行分组。
  const byDir = new Map<string, { agentDir: string; agentIds:string[] }>();

  // 遍历配置中找到的每个代理 ID。
  for (const agentId of collectReferencedAgentIds(cfg)) {
    // 解析当前代理的有效目录。
    const agentDir = resolveEffectiveAgentDir(cfg, agentId, deps);
    // 规范化目录路径以确保一致的比较。
    const key = canonicalizeAgentDir(agentDir);
    const entry = byDir.get(key);

    // 如果此目录已在 map 中，则将当前代理 ID 添加到列表中。
    if (entry) {
      entry.agentIds.push(agentId);
    } else {
      // 如果是第一次看到此目录，则创建一个新条目。
      byDir.set(key, { agentDir, agentIds: [agentId] });
    }
  }

  // 筛选 map 以查找与一个目录关联的代理 ID 多于一个的条目。
  return [...byDir.values()].filter((v) => v.agentIds.length > 1);
}

/**
 * 格式化一个用户友好的错误消息，解释哪些代理目录是重复的以及如何解决问题。
 * 这有助于用户快速理解和解决配置问题。
 * @param dups 描述重复目录和使用它们的代理 ID 的对象数组。
 * @returns 一个详细说明错误并提供清晰解决步骤的格式化字符串。
 */
export function formatDuplicateAgentDirError(dups: DuplicateAgentDir[]): string {
  const lines: string[] = [
    "检测到重复的 agentDir (多代理配置)。",
    "每个代理必须有一个唯一的 agentDir；共享它会导致身份验证/会话状态冲突和令牌失效。",
    "",
    "冲突:",
    // 列出每个冲突的目录和共享它的代理 ID。
    ...dups.map((d) => `- ${d.agentDir}: ${d.agentIds.map((id) => `"${id}"`).join(", ")}`),
    "",
    "修复: 移除共享的 agents.list[].agentDir 覆盖 (或为每个代理提供自己的目录)。",
    "如果你想共享凭据，请复制 auth-profiles.json 而不是共享整个 agentDir。",
  ];
  return lines.join("\n");
}
