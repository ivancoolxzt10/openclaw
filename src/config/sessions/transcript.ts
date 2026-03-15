// 本文件负责管理单个会話的“聊天记录（transcript）”文件的生命周期。
// 这包括解析文件路径、确保文件存在并已初始化、以及向文件中追加消息。

import fs from "node:fs";
import path from "node:path";
// 似乎是用于处理聊天记录文件的核心库
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { parseSessionThreadInfo } from "./delivery-info.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

/**
 * 从 URL 中提取文件名。
 * @param value - 原始 URL 字符串。
 * @returns 文件名，或在无法提取时返回 `null`。
 */
function extractFileNameFromMediaUrl(value: string): string | null {
  // ... 实现细节：去除查询参数和哈希，然后解析路径 ...
}

/**
 * 为要写入聊天记录的“镜像”消息解析出其文本表示。
 * 如果消息包含媒体文件，则优先使用媒体文件名；否则使用消息的文本内容。
 * 这主要用于记录机器人自己发送的消息（例如，转发了一张图片）。
 * @param params - 包含文本和媒体 URL 的对象。
 * @returns 用于表示消息的字符串，如果消息为空，则返回 `null`。
 */
export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    return "media";
  }

  const text = params.text ?? "";
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/**
 * 确保一个会话的聊天记录文件存在，并且包含一个“头部（header）”行。
 * 如果文件不存在，此函数会创建它，并写入一个包含会话元数据（如ID、版本、时间戳）的 JSON 对象作为第一行。
 * @param params - 包含文件路径和会话ID的对象。
 */
async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * 解析并确认一个会话的聊天记录文件路径。
 * 这是一个协调函数，它调用 `resolveAndPersistSessionFile` 来确保不仅路径被正确解析，
 * 而且这个路径也被持久化回了主会话存储（`sessions.json`）中。
 * @returns 一个包含最终文件路径和更新后会话条目的对象。
 */
export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  // ...
  // 调用核心的解析和持久化函数
  const resolvedSessionFile = await resolveAndPersistSessionFile({ /* ... */ });
  // ...
  return {
    sessionFile,
    sessionEntry,
  };
}

/**
 * 【主函数】向一个会话的聊天记录文件中追加一条“助手（assistant）”消息。
 *
 * @param params - 包含会话标识、消息内容和幂等键等信息的对象。
 * @returns 如果成功，则返回 `{ ok: true, ... }`；否则返回 `{ ok: false, ... }`。
 */
export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string; // 幂等键，用于防止重复追加
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  // 1. 获取消息的文本表示
  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  // 2. 加载主会话存储，找到对应的会话条目
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey] as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${sessionKey}` };
  }

  // 3. 解析并持久化该会话的聊天记录文件路径
  let sessionFile: string;
  try {
    const resolvedSessionFile = await resolveAndPersistSessionFile({ /* ... */ });
    sessionFile = resolvedSessionFile.sessionFile;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), };
  }

  // 4. 确保文件头存在
  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  // 5. 【幂等性检查】如果提供了幂等键，则检查该消息是否已经存在于文件中。
  if (
    params.idempotencyKey &&
    (await transcriptHasIdempotencyKey(sessionFile, params.idempotencyKey))
  ) {
    // 如果已存在，则直接成功返回，不重复追加。
    return { ok: true, sessionFile };
  }

  // 6. 使用 `SessionManager` 库来实际执行追加操作。
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: mirrorText }],
    // ... 其他消息元数据 ...
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  });

  // 7. 发出一个事件，通知应用的其他部分聊天记录已更新。
  emitSessionTranscriptUpdate(sessionFile);
  return { ok: true, sessionFile };
}

/**
 * 检查一个聊天记录文件中是否已存在具有给定幂等键的消息。
 * @returns 如果找到，则返回 `true`。
 */
async function transcriptHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<boolean> {
  try {
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    // 逐行解析 JSONL 文件
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
        if (parsed.message?.idempotencyKey === idempotencyKey) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}
