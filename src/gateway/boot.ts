// 本文件实现了网关（Gateway）的“启动（boot）”执行逻辑。
//
// **核心功能**:
// 在启动时，它会查找并执行一个名为 `BOOT.md` 的特殊文件。
// 这个文件可以包含一系列指令，让代理（agent）在启动时执行一次性的设置、
// 检查或通知任务。
//
// **关键机制**:
// 为了执行 `BOOT.md`，它需要一个会话上下文。它会“借用”主会话（main session）
// 来运行这个一次性任务。为了确保这个启动任务不影响用户的正常对话历史，
// 它实现了一个“快照与恢复”机制：
// 1. 在运行前，为当前的主会话条目拍摄一个“快照”。
// 2. 以 `BOOT.md` 的内容作为提示，运行代理命令。
// 3. 运行结束后（无论成功或失败），使用快照将主会话条目恢复到其原始状态。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";

/**
 * 为本次启动运行生成一个唯一的会话ID。
 * 格式为 `boot-YYYY-MM-DD_HH-MM-SS-RANDOM`，便于追踪和调试。
 */
function generateBootSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `boot-${ts}-${suffix}`;
}

/**
 * 描述会话映射快照的数据结构。
 */
type SessionMappingSnapshot = {
  storePath: string; // 会话存储文件的路径
  sessionKey: string; // 主会话的密钥
  canRestore: boolean; // 是否可以恢复（例如，如果文件不可读，则为 false）
  hadEntry: boolean; // 在运行前，该会话条目是否存在
  entry?: SessionEntry; // （可选）原始会话条目的深拷贝
};

const log = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";

export type BootRunResult =
  | { status: "skipped"; reason: "missing" | "empty" } // 跳过执行（文件不存在或为空）
  | { status: "ran" }                               // 成功执行
  | { status: "failed"; reason: string };             // 执行失败

/**
 * 将 `BOOT.md` 的内容包装成一个给代理的、完整的系统提示。
 * 它会明确指示代理如何行动，例如使用 `message` 工具并以静默方式回复。
 */
function buildBootPrompt(content: string) {
  return [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "",
    "BOOT.md:",
    content,
    "",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
    "Use the `target` field (not `to`) for message tool destinations.",
    `After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
    `If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
  ].join("\n");
}

/**
 * 从工作区目录加载 `BOOT.md` 文件。
 * @returns 一个包含文件内容和状态的对象。
 */
async function loadBootFile(
  workspaceDir: string,
): Promise<{ content?: string; status: "ok" | "missing" | "empty" }> {
  const bootPath = path.join(workspaceDir, BOOT_FILENAME);
  try {
    const content = await fs.readFile(bootPath, "utf-8");
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty" };
    }
    return { status: "ok", content: trimmed };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
}

/**
 * 【快照步骤】为给定的主会话拍摄快照。
 * 它会读取当前的 `sessions.json` 文件，并保存主会话条目的当前状态。
 */
function snapshotMainSessionMapping(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): SessionMappingSnapshot {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    if (!entry) {
      return { storePath, sessionKey: params.sessionKey, canRestore: true, hadEntry: false, };
    }
    return {
      storePath,
      sessionKey: params.sessionKey,
      canRestore: true,
      hadEntry: true,
      entry: structuredClone(entry), // 保存一个深拷贝，以防被修改
    };
  } catch (err) {
    // ... 错误处理 ...
    return { storePath, sessionKey: params.sessionKey, canRestore: false, hadEntry: false, };
  }
}

/**
 * 【恢复步骤】根据快照将主会话恢复到其原始状态。
 */
async function restoreMainSessionMapping(
  snapshot: SessionMappingSnapshot,
): Promise<string | undefined> {
  if (!snapshot.canRestore) {
    return undefined;
  }
  try {
    await updateSessionStore(
      snapshot.storePath,
      (store) => {
        // 如果快照中包含了原始条目，则将其写回。
        if (snapshot.hadEntry && snapshot.entry) {
          store[snapshot.sessionKey] = snapshot.entry;
          return;
        }
        // 否则（即运行前该条目不存在），则将其删除。
        delete store[snapshot.sessionKey];
      },
      { activeSessionKey: snapshot.sessionKey },
    );
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 【主函数】执行一次启动运行。
 */
export async function runBootOnce(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  workspaceDir: string;
  agentId?: string;
}): Promise<BootRunResult> {
  // ...
  // 1. 加载 BOOT.md 文件。
  const result = await loadBootFile(params.workspaceDir);
  if (result.status === "missing" || result.status === "empty") {
    return { status: "skipped", reason: result.status };
  }

  // 2. 准备启动运行的上下文
  const sessionKey = /* ... 解析主会话密钥 ... */;
  const message = buildBootPrompt(result.content ?? "");
  const sessionId = generateBootSessionId();
  
  // 3. 【关键】在运行代理之前，为该会话拍摄快照。
  const mappingSnapshot = snapshotMainSessionMapping({
    cfg: params.cfg,
    sessionKey,
  });

  let agentFailure: string | undefined;
  try {
    // 4. 调用 `agentCommand` 来执行 BOOT.md 的内容。
    //    这会“借用”并可能修改主会话。
    await agentCommand(
      { message, sessionKey, sessionId, deliver: false, senderIsOwner: true, },
      bootRuntime,
      params.deps,
    );
  } catch (err) {
    // ... 捕获代理运行失败 ...
  }

  // 5. 【关键】在代理运行之后（无论成功与否），恢复会话快照。
  const mappingRestoreFailure = await restoreMainSessionMapping(mappingSnapshot);
  // ... 错误处理 ...
  
  // 6. 返回最终结果。
  if (!agentFailure && !mappingRestoreFailure) {
    return { status: "ran" };
  }
  // ...
  return { status: "failed", reason: /* ... */ };
}
