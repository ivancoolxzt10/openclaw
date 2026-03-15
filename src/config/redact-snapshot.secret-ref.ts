// 本文件是 `redact-snapshot.ts` 的另一个辅助模块，专门用于处理
// 一种特殊的数据结构——“秘密引用（Secret Reference）”。
//
// 一个“秘密引用”对象不是直接包含敏感值（如 API 密钥），而是通过 `source` 和 `id`
// 字段来“指向”一个秘密。本模块的功能就是识别这种结构，并安全地编辑（隐藏）
// 其中的 `id` 字段，同时保留其他信息。

/**
 * 类型保护函数，用于检查一个对象是否符合“秘密引用”的形状。
 * 一个秘密引用对象必须是一个普通对象，并且同时拥有 `source` 和 `id` 这两个字符串属性。
 * @param value - 要检查的未知值。
 * @returns 如果该值是一个有效的秘密引用对象，则返回 `true`。
 */
export function isSecretRefShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { source: string; id: string } {
  return typeof value.source === "string" && typeof value.id === "string";
}

/**
 * 编辑（隐藏）一个秘密引用对象中的 `id` 字段。
 *
 * @param params - 包含以下属性的对象：
 *   - `value`: 要编辑的秘密引用对象。
 *   - `values`: 一个字符串数组，用于收集所有需要被隐藏的真实敏感值。此函数会将 `value.id` 添加到这个数组中。
 *   - `redactedSentinel`: 用于替换真实 ID 的占位符字符串。
 *   - `isEnvVarPlaceholder`: 一个函数，用于检查一个字符串是否是环境变量占位符（例如，`${MY_SECRET}`）。
 * @returns 一个新的对象，其 `id` 字段已被替换为占位符。
 */
export function redactSecretRefId(params: {
  value: Record<string, unknown> & { source: string; id: string };
  values: string[];
  redactedSentinel: string;
  isEnvVarPlaceholder: (value: string) => boolean;
}): Record<string, unknown> {
  const { value, values, redactedSentinel, isEnvVarPlaceholder } = params;
  // 创建一个对象的浅拷贝以进行修改
  const redacted: Record<string, unknown> = { ...value };

  // 【关键逻辑】只有当 `id` 字段 *不是* 一个环境变量占位符时，才进行编辑。
  // 这是为了在编辑后的配置中保留 `${...}` 这样的引用，而不是将它们隐藏掉，
  // 因为它们本身不是秘密，而是指向秘密的指针。
  if (!isEnvVarPlaceholder(value.id)) {
    // 1. 将真实的 `id` 值（即敏感信息）推入 `values` 数组，以便上层调用者可以统一处理。
    values.push(value.id);
    // 2. 将 `id` 字段替换为安全的占位符。
    redacted.id = redactedSentinel;
  }

  return redacted;
}
