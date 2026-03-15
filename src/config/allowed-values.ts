// 本文件提供用于处理和显示“允许值”列表的功能。
// 主要用于在错误消息或提示中，向用户展示一个字段可以接受哪些可能的值。
// 它包括对值进行截断、去重和格式化，以生成一个清晰、简洁的摘要。

const MAX_ALLOWED_VALUES_HINT = 12; // 提示中显示的最大允许值的数量
const MAX_ALLOWED_VALUE_CHARS = 160; // 允许值的最大字符数

/**
 * 表示允许值的摘要信息。
 */
export type AllowedValuesSummary = {
  /**
   * 摘要中显示的值的列表（可能被截断）。
   */
  values: string[];
  /**
   * 由于空间限制而被隐藏的允许值的数量。
   */
  hiddenCount: number;
  /**
   * 格式化后的字符串，用于在 UI 或日志中显示，例如 "value1, value2, ... (+3 more)"。
   */
  formatted: string;
};

/**
 * 如果文本超过限制，则截断文本。
 * @param text 要截断的文本。
 * @param limit 字符数限制。
 * @returns 截断后的文本，或原始文本（如果未超过限制）。
 */
function truncateHintText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}... (+${text.length - limit} chars)`;
}

/**
 * 安全地将值转换为 JSON 字符串。
 * 如果 `JSON.stringify` 失败（例如，对于循环引用），则回退到 `String()`。
 * @param value 要转换的值。
 * @returns 值的字符串表示形式。
 */
function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // 当值不是 JSON 可序列化时，回退到字符串强制转换。
  }
  return String(value);
}

/**
 * 将任意值转换为用于显示的标签。
 * 字符串会被截断，其他值会先转换为字符串再被截断。
 * @param value 要转换的值。
 * @returns 格式化后的标签字符串。
 */
function toAllowedValueLabel(value: unknown): string {
  if (typeof value === "string") {
    // 对字符串进行截断并用引号包裹
    return JSON.stringify(truncateHintText(value, MAX_ALLOWED_VALUE_CHARS));
  }
  // 对其他类型，先字符串化再截断
  return truncateHintText(safeStringify(value), MAX_ALLOWED_VALUE_CHARS);
}

/**
 * 将任意值转换为其最终的字符串值。
 * @param value 要转换的值。
 * @returns 值的字符串表示。
 */
function toAllowedValueValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return safeStringify(value);
}

/**
 * 为值生成一个用于去重的唯一键。
 * 这可以区分不同类型但字符串表示相同的值，例如 `null` 和 `"null"`。
 * @param value 要生成键的值。
 * @returns 一个唯一的键字符串，格式为 "类型:值"。
 */
function toAllowedValueDedupKey(value: unknown): string {
  if (value === null) {
    return "null:null";
  }
  const kind = typeof value;
  if (kind === "string") {
    return `string:${value as string}`;
  }
  return `${kind}:${safeStringify(value)}`;
}

/**
 * 总结一个允许值的数组，用于清晰地显示。
 * 它会对值进行去重，并如果列表太长，则进行截断。
 * @param values 只读的允许值数组。
 * @returns 一个 `AllowedValuesSummary` 对象，如果输入数组为空，则返回 `null`。
 */
export function summarizeAllowedValues(
  values: ReadonlyArray<unknown>,
): AllowedValuesSummary | null {
  if (values.length === 0) {
    return null;
  }

  // 用于存储去重后的值和标签
  const deduped: Array<{ value: string; label: string }> = [];
  // 用于跟踪已经见过的去重键
  const seenValues = new Set<string>();
  
  for (const item of values) {
    const dedupeKey = toAllowedValueDedupKey(item);
    if (seenValues.has(dedupeKey)) {
      continue; // 跳过重复值
    }
    seenValues.add(dedupeKey);
    deduped.push({
      value: toAllowedValueValue(item),
      label: toAllowedValueLabel(item),
    });
  }

  // 截取要在提示中显示的部分
  const shown = deduped.slice(0, MAX_ALLOWED_VALUES_HINT);
  const hiddenCount = deduped.length - shown.length;
  // 格式化核心部分
  const formattedCore = shown.map((entry) => entry.label).join(", ");
  // 如果有隐藏的值，则添加 "... (+N more)"
  const formatted =
    hiddenCount > 0 ? `${formattedCore}, ... (+${hiddenCount} more)` : formattedCore;

  return {
    values: shown.map((entry) => entry.value),
    hiddenCount,
    formatted,
  };
}

/**
 * 检查消息字符串是否已经包含了允许值的提示。
 * @param message 要检查的消息字符串。
 * @returns 如果消息已包含提示，则为 `true`。
 */
function messageAlreadyIncludesAllowedValues(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("(allowed:") || lower.includes("expected one of");
}

/**
 * 将允许值的摘要提示附加到消息字符串中。
 * 如果消息已经包含此类提示，则不进行任何操作。
 * @param message 原始消息。
 * @param summary 允许值的摘要。
 * @returns 附加了提示的消息。
 */
export function appendAllowedValuesHint(message: string, summary: AllowedValuesSummary): string {
  if (messageAlreadyIncludesAllowedValues(message)) {
    return message;
  }
  return `${message} (allowed: ${summary.formatted})`;
}
