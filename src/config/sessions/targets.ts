// 本文件负责解析和“发现”会话存储的目标（targets）。
// 一个“目标”是指一个 agentId 及其对应的会话存储文件（`sessions.json`）的路径。
//
// **核心功能**:
// 1. **解析用户意图**: 根据用户的命令行选项（如 `--agent <id>` 或 `--all-agents`），
//    确定需要操作哪些 `sessions.json` 文件。
// 2. **发现磁盘上的存储**: 实现了一个“发现”机制，该机制会扫描文件系统，
//    找出所有存在的代理会话目录。这对于需要处理所有（包括已“退役”）代理数据的
//    维护任务至关重要。
// 3. **安全验证**: 在发现过程中包含了严格的安全检查，以防止路径遍历等漏洞。

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
// ... 其他导入 ...
import { resolveAgentsDirFromSessionStorePath, resolveStorePath } from "./paths.js";

/**
 * 描述用户选择会话存储的命令行选项。
 */
export type SessionStoreSelectionOptions = {
  store?: string;      // --store: 指定一个具体的 sessions.json 文件路径
  agent?: string;      // --agent: 指定一个具体的 agent ID
  allAgents?: boolean; // --all-agents: 选择所有 agent
};

/**
 * 描述一个已解析的、具体的目标。
 */
export type SessionStoreTarget = {
  agentId: string;
  storePath: string;
};

// ...

/**
 * 辅助函数，用于对目标列表按 `storePath` 进行去重。
 * 因为多个 agentId 可能被配置为使用同一个 `sessions.json` 文件。
 */
function dedupeTargetsByStorePath(targets: SessionStoreTarget[]): SessionStoreTarget[] {
  // ...
}

// ...

/**
 * 【核心函数 1】根据用户的命令行选项解析会话存储目标。
 * @param cfg - 全局配置对象。
 * @param opts - 从命令行解析出的选项。
 * @returns 一个 `SessionStoreTarget` 数组。
 */
export function resolveSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
  params: { env?: NodeJS.ProcessEnv } = {},
): SessionStoreTarget[] {
  const env = params.env ?? process.env;
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const hasAgent = Boolean(opts.agent?.trim());
  const allAgents = opts.allAgents === true;
  // 1. 处理互斥选项
  if (hasAgent && allAgents) {
    throw new Error("--agent 和 --all-agents 不能同时使用");
  }
  if (opts.store && (hasAgent || allAgents)) {
    throw new Error("--store 不能与 --agent 或 --all-agents 组合使用");
  }

  // 2. 处理 --store 选项
  if (opts.store) {
    return [
      {
        agentId: defaultAgentId,
        storePath: resolveStorePath(opts.store, { agentId: defaultAgentId, env }),
      },
    ];
  }

  // 3. 处理 --all-agents 选项
  if (allAgents) {
    // 列出配置中定义的所有 agent，并为每个 agent 创建一个目标
    const targets = listAgentIds(cfg).map((agentId) => ({
      agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId, env }),
    }));
    return dedupeTargetsByStorePath(targets);
  }

  // 4. 处理 --agent 选项
  if (hasAgent) {
    // ... 检查 agent 是否存在并返回其目标 ...
  }

  // 5. 如果没有任何选项，则返回默认 agent 的目标。
  return [
    {
      agentId: defaultAgentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: defaultAgentId, env }),
    },
  ];
}

/**
 * 【核心函数 2 - 异步发现】解析所有存在的代理会话存储目标。
 * 这个函数不仅会查找配置中定义的代理，还会扫描磁盘以发现所有物理上存在的代理会话目录。
 *
 * @param cfg - 全局配置对象。
 * @returns 一个 Promise，解析为一个包含了所有已发现和验证的目标的数组。
 */
export async function resolveAllAgentSessionStoreTargets(
  cfg: OpenClawConfig,
  params: { env?: NodeJS.ProcessEnv } = {},
): Promise<SessionStoreTarget[]> {
  const env = params.env ?? process.env;
  // 1. 获取所有在配置中明确定义的目标，以及所有可能的 `agents` 根目录。
  const { configuredTargets, agentsRoots } = resolveSessionStoreDiscoveryState(cfg, env);
  
  // 2. 验证已配置目标的路径安全性。
  const validatedConfiguredTargets = (
    await Promise.all(
      configuredTargets.map(async (target) => {
        // ...
        // a. 找到其 `agents` 根目录。
        // b. 解析符号链接，获取真实路径。
        // c. 【安全检查】使用 `resolveValidatedDiscoveredStorePath` 确保 `sessions.json`
        //    是一个真实的文件，且其真实路径位于 `agents` 根目录之内，防止路径遍历。
        const validatedStorePath = await resolveValidatedDiscoveredStorePath({ /* ... */ });
        return validatedStorePath ? { ...target, storePath: validatedStorePath } : undefined;
      }),
    )
  ).filter(/* ... */);

  // 3. 在磁盘上发现其他目标。
  const discoveredTargets = (
    await Promise.all(
      // 遍历所有可能的 `agents` 根目录
      agentsRoots.map(async (agentsDir) => {
        try {
          // a. 在 `agents` 目录下查找所有代理的 `sessions` 子目录。
          const sessionsDirs = await resolveAgentSessionDirsFromAgentsDir(agentsDir);
          return (
            await Promise.all(
              sessionsDirs.map(async (sessionsDir) => {
                // b. 对每个找到的目录执行与步骤2中相同的安全验证。
                const validatedStorePath = await resolveValidatedDiscoveredStorePath({ /* ... */ });
                // c. 如果验证通过，则从目录名推断出 agentId 并创建一个目标。
                return validatedStorePath
                  ? toDiscoveredSessionStoreTarget(sessionsDir, validatedStorePath)
                  : undefined;
              }),
            )
          ).filter(/* ... */);
        } catch (err) {
          // 忽略权限错误等非致命的发现错误
          if (shouldSkipDiscoveryError(err)) {
            return [];
          }
          throw err;
        }
      }),
    )
  ).flat();

  // 4. 合并已配置的目标和已发现的目标，并去重。
  return dedupeTargetsByStorePath([...validatedConfiguredTargets, ...discoveredTargets]);
}
