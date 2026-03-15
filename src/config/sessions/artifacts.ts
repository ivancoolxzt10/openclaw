// 本文件定义了用于处理“会话存档（Session Artifacts）”文件名的实用工具。
// “会话存档”是会话文件的备份或历史版本，例如，当一个会话被重置或删除时，
// 它的记录文件就会被重命名为一个存档文件，而不是被立即删除。
// 本模块的函数负责创建、解析和识别这些存档文件的命名约定。

/**
 * 定义了会话被存档的可能原因。
 * - `bak`: 常规备份。
 * - `reset`: 会话被重置。
 * - `deleted`: 会话被删除。
 */
export type SessionArchiveReason = "bak" | "reset" | "deleted";

// 用于匹配存档文件名中 ISO 8601 时间戳部分的正则表达式。
// 例如：`2023-10-27T10-30-00.123Z`
const ARCHIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/;
// 用于匹配旧版（legacy）会话备份文件名的正则表达式。
const LEGACY_STORE_BACKUP_RE = /^sessions\.json\.bak\.\d+$/;

/**
 * 检查一个文件名是否以特定的存档后缀结尾。
 * 例如，检查 `some-file.reset.2023-10-27T...Z` 是否匹配 "reset" 原因。
 * @param fileName - 要检查的文件名。
 * @param reason - 存档的原因。
 * @returns 如果文件名匹配存档格式，则返回 `true`。
 */
function hasArchiveSuffix(fileName: string, reason: SessionArchiveReason): boolean {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return false;
  }
  // 提取并验证时间戳部分
  const raw = fileName.slice(index + marker.length);
  return ARCHIVE_TIMESTAMP_RE.test(raw);
}

/**
 * 检查一个文件名是否是一个会话存档文件。
 * 它会检查新版和旧版两种命名格式。
 * @param fileName - 要检查的文件名。
 * @returns 如果是存档文件，则返回 `true`。
 */
export function isSessionArchiveArtifactName(fileName: string): boolean {
  // 检查是否是旧格式，例如 `sessions.json.bak.1`
  if (LEGACY_STORE_BACKUP_RE.test(fileName)) {
    return true;
  }
  // 检查是否是新格式，例如 `...bak.TIMESTAMP`, `...reset.TIMESTAMP` 等
  return (
    hasArchiveSuffix(fileName, "deleted") ||
    hasArchiveSuffix(fileName, "reset") ||
    hasArchiveSuffix(fileName, "bak")
  );
}

/**
 * 检查一个文件名是否是一个“主要的”会话记录文件（而不是存档文件）。
 * 主要的会话记录文件通常以 `.jsonl` 结尾，并且不是存档文件。
 * @param fileName - 要检查的文件名。
 * @returns 如果是主要会话文件，则返回 `true`。
 */
export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
  // `sessions.json` 是旧版的主存储文件，不是单个会话的记录文件
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  // 必须不是一个存档文件
  return !isSessionArchiveArtifactName(fileName);
}

/**
 * 格式化一个当前时间戳，使其对于文件名是安全的。
 * 它将 ISO 8601 时间戳中的冒号 `:` 替换为连字符 `-`。
 * @param nowMs - （可选）要格式化的时间戳（毫秒），默认为当前时间。
 * @returns 格式化后的时间戳字符串。
 */
export function formatSessionArchiveTimestamp(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().replaceAll(":", "-");
}

/**
 * 从文件名安全的时间戳中恢复标准的 ISO 8601 时间戳格式。
 * 它将连字符 `-` 替换回冒号 `:`。
 * @param raw - 从文件名中提取的时间戳部分。
 * @returns 一个有效的 ISO 时间戳字符串。
 */
function restoreSessionArchiveTimestamp(raw: string): string {
  const [datePart, timePart] = raw.split("T");
  if (!datePart || !timePart) {
    return raw;
  }
  return `${datePart}T${timePart.replace(/-/g, ":")}`;
}

/**
 * 从存档文件名中解析出原始的时间戳（以毫秒为单位）。
 * @param fileName - 存档文件名。
 * @param reason - 存档的原因，用于定位时间戳。
 * @returns 时间戳（毫秒），如果解析失败则返回 `null`。
 */
export function parseSessionArchiveTimestamp(
  fileName: string,
  reason: SessionArchiveReason,
): number | null {
  const marker = `.${reason}.`;
  const index = fileName.lastIndexOf(marker);
  if (index < 0) {
    return null;
  }
  const raw = fileName.slice(index + marker.length);
  if (!raw) {
    return null;
  }
  if (!ARCHIVE_TIMESTAMP_RE.test(raw)) {
    return null;
  }
  // 1. 恢复标准时间戳格式
  // 2. 使用 Date.parse() 解析为毫秒
  const timestamp = Date.parse(restoreSessionArchiveTimestamp(raw));
  return Number.isNaN(timestamp) ? null : timestamp;
}
