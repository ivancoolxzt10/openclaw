// 本文件提供了一组实用函数，用于将配置验证中产生的问题（issues）
// 格式化为人类可读的字符串。当配置验证失败时，会生成一个错误或警告列表，
// 本模块的职责就是将这些结构化的数据转换成在终端中清晰、安全地显示的文本。

import { sanitizeTerminalText } from "../terminal/safe-text.js";
import type { ConfigValidationIssue } from "./types.js";

/**
 * 定义格式化函数所需的输入类型。
 */
type ConfigIssueLineInput = {
  path?: string | null; // 问题所在的配置路径
  message: string;      // 问题描述信息
};

type ConfigIssueFormatOptions = {
  normalizeRoot?: boolean; // 是否将根路径规范化为 "<root>"
};

/**
 * 规范化配置问题的路径。
 * 如果路径为空、null 或 undefined，则将其替换为字符串 `"<root>"`。
 * @param path 原始路径字符串。
 * @returns 规范化后的路径。
 */
export function normalizeConfigIssuePath(path: string | null | undefined): string {
  if (typeof path !== "string") {
    return "<root>";
  }
  const trimmed = path.trim();
  return trimmed ? trimmed : "<root>";
}

/**
 * 规范化单个配置验证问题对象。
 * 它会清理路径，并确保只有在有效时才包含 `allowedValues` 等可选字段。
 * @param issue 原始的验证问题对象。
 * @returns 经过清理和规范化的新问题对象。
 */
export function normalizeConfigIssue(issue: ConfigValidationIssue): ConfigValidationIssue {
  const hasAllowedValues = Array.isArray(issue.allowedValues) && issue.allowedValues.length > 0;
  return {
    path: normalizeConfigIssuePath(issue.path),
    message: issue.message,
    // 仅当 allowedValues 有效时才包含它
    ...(hasAllowedValues ? { allowedValues: issue.allowedValues } : {}),
    // 仅当 allowedValuesHiddenCount 有效时才包含它
    ...(hasAllowedValues &&
    typeof issue.allowedValuesHiddenCount === "number" &&
    issue.allowedValuesHiddenCount > 0
      ? { allowedValuesHiddenCount: issue.allowedValuesHiddenCount }
      : {}),
  };
}

/**
 * 将 `normalizeConfigIssue` 应用于一个问题数组。
 */
export function normalizeConfigIssues(
  issues: ReadonlyArray<ConfigValidationIssue>,
): ConfigValidationIssue[] {
  return issues.map((issue) => normalizeConfigIssue(issue));
}

/**
 * 内部辅助函数，根据选项决定如何显示路径。
 */
function resolveIssuePathForLine(
  path: string | null | undefined,
  opts?: ConfigIssueFormatOptions,
): string {
  if (opts?.normalizeRoot) {
    return normalizeConfigIssuePath(path);
  }
  return typeof path === "string" ? path : "";
}

/**
 * 格式化单个配置问题为一行字符串。
 * @param issue 要格式化的问题。
 * @param marker 行前缀标记，例如 "-"。
 * @param opts 格式化选项。
 * @returns 格式化后的单行字符串，例如 "- gateway.port: Must be a number"。
 */
export function formatConfigIssueLine(
  issue: ConfigIssueLineInput,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string {
  const prefix = marker ? `${marker} ` : "";
  // 对路径和消息进行清理，移除任何可能干扰终端显示的控制字符
  const path = sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts));
  const message = sanitizeTerminalText(issue.message);
  return `${prefix}${path}: ${message}`;
}

/**
 * 将 `formatConfigIssueLine` 应用于一个问题数组。
 * @returns 一个包含多行格式化后字符串的数组，可以直接打印到控制台。
 */
export function formatConfigIssueLines(
  issues: ReadonlyArray<ConfigIssueLineInput>,
  marker = "-",
  opts?: ConfigIssueFormatOptions,
): string[] {
  return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}
