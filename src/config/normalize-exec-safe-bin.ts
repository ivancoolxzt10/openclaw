// 本文件负责规范化与 `exec` 工具（可能用于执行 shell 命令）相关的安全设置。
// 它确保定义了哪些命令是“安全的”（`safeBinProfiles`）以及哪些目录是“可信的”（`safeBinTrustedDirs`）的配置
// 处于一个干净、规范的格式。

import { normalizeSafeBinProfileFixtures } from "../infra/exec-safe-bin-policy.js";
import { normalizeTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
import type { OpenClawConfig } from "./types.js";

/**
 * 规范化配置对象中所有 `exec` 工具的安全设置。
 * 它会遍历全局的 `tools.exec` 以及每个 agent 的 `tools.exec` 配置。
 * @param cfg 要修改的 OpenClaw 配置对象。这是一个会产生副作用的函数，它会直接修改传入的 `cfg` 对象。
 */
export function normalizeExecSafeBinProfilesInConfig(cfg: OpenClawConfig): void {
  /**
   * 一个内部辅助函数，用于对单个 `exec` 配置块进行规范化。
   */
  const normalizeExec = (exec: unknown) => {
    if (!exec || typeof exec !== "object" || Array.isArray(exec)) {
      return;
    }
    const typedExec = exec as {
      safeBinProfiles?: Record<string, unknown>;
      safeBinTrustedDirs?: string[];
    };
    
    // 1. 调用外部辅助函数来清理“安全命令配置档案”（safeBinProfiles）。
    //    这可能包括移除无效标志、排序数组等。
    const normalizedProfiles = normalizeSafeBinProfileFixtures(/*...*/);
    // 如果清理后 profiles 对象变为空，则将其设置为 undefined 以从配置中移除该字段。
    typedExec.safeBinProfiles =
      Object.keys(normalizedProfiles).length > 0 ? normalizedProfiles : undefined;

    // 2. 调用外部辅助函数来清理“可信目录”列表。
    //    这可能包括解析为绝对路径、去重等。
    const normalizedTrustedDirs = normalizeTrustedSafeBinDirs(typedExec.safeBinTrustedDirs);
    // 如果清理后列表为空，则设置为 undefined。
    typedExec.safeBinTrustedDirs =
      normalizedTrustedDirs.length > 0 ? normalizedTrustedDirs : undefined;
  };

  // 3. 将规范化函数应用到所有可能出现 `exec` 配置的地方。
  
  // 应用于全局配置
  normalizeExec(cfg.tools?.exec);

  // 应用于每个 agent 的特定配置
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    normalizeExec(agent?.tools?.exec);
  }
}
