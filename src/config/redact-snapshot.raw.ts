// 本文件是 `redact-snapshot.ts` 的一个辅助模块，专门处理对“原始（raw）”配置文件文本的编辑。
// 它提供了直接在字符串级别上替换敏感值的功能，并包含一个重要的验证步骤，以确保这种
// 粗粒度的替换不会意外地破坏配置文件的结构。

import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

/**
 * 在原始（raw）文本中替换敏感值。
 * 这是一个直接的、基于字符串的查找和替换操作。
 *
 * @param params - 包含以下属性的对象：
 *   - `raw`: 原始的 JSON5 配置文件字符串。
 *   - `sensitiveValues`: 一个包含所有需要被隐藏的敏感值的字符串数组（例如，`["sk-123", "abc"]`）。
 *   - `redactedSentinel`: 用于替换敏感值的占位符（例如，`"__OPENCLAW_REDACTED__"`）。
 * @returns 一个新的字符串，其中所有敏感值都已被替换为占位符。
 */
export function replaceSensitiveValuesInRaw(params: {
  raw: string;
  sensitiveValues: string[];
  redactedSentinel: string;
}): string {
  // 1. 对敏感值按长度进行降序排序。
  //    这是一个重要的启发式方法，用于防止一个值是另一个值的子串时出现问题。
  //    例如，如果列表是 `["token", "longertoken"]`，先替换 "token" 会破坏 "longertoken"。
  //    排序后，会先替换 "longertoken"，从而避免这个问题。
  const values = [...params.sensitiveValues].toSorted((a, b) => b.length - a.length);
  let result = params.raw;
  // 2. 遍历并替换所有敏感值。
  for (const value of values) {
    result = result.replaceAll(value, params.redactedSentinel);
  }
  return result;
}

/**
 * 检查是否应回退到“结构化”的原始文本编辑方法。
 *
 * “原始文本替换”是一种快速但有风险的方法，因为它可能会意外地替换掉 JSON5 结构中的
 * 关键字符（如引号或括号），从而导致文件损坏。
 *
 * 这个函数通过一个“往返检查（round-trip check）”来验证其安全性：
 * 1. 尝试重新解析经过原始文本编辑后的字符串。
 * 2. 尝试将编辑后的占位符恢复为原始值。
 * 3. 检查恢复后的对象是否与原始配置对象“深度相等”。
 *
 * 如果任何一步失败，或者最终结果不匹配，都意味着原始文本替换是“不安全的”，
 * 调用者应该使用一种更慢但更安全的、基于 AST（抽象语法树）的结构化方法来生成编辑后的文本。
 *
 * @param params - 包含以下属性的对象：
 *   - `redactedRaw`: 经过 `replaceSensitiveValuesInRaw` 处理后的文本。
 *   - `originalConfig`: 未经编辑的、原始的配置对象。
 *   - `restoreParsed`: 一个函数，用于尝试将占位符恢复为原始值。
 * @returns 如果原始文本编辑不安全，应回退到结构化方法，则返回 `true`。
 */
export function shouldFallbackToStructuredRawRedaction(params: {
  redactedRaw: string;
  originalConfig: unknown;
  restoreParsed: (parsed: unknown) => { ok: boolean; result?: unknown };
}): boolean {
  try {
    // 1. 尝试重新解析
    const parsed = JSON5.parse(params.redactedRaw);
    // 2. 尝试恢复
    const restored = params.restoreParsed(parsed);
    if (!restored.ok) {
      return true; // 恢复失败，需要回退
    }
    // 3. 检查深度相等性
    return !isDeepStrictEqual(restored.result, params.originalConfig);
  } catch {
    // 如果 JSON5 解析失败，说明结构已损坏，必须回退
    return true;
  }
}
