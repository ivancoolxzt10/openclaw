/**
 * 元数据读取工具
 * 
 * 功能概述：
 * 提供从元数据对象中安全读取各种类型值的工具函数
 * 
 * 主要功能：
 * 1. 读取字符串值（支持多个键名）
 * 2. 读取布尔值
 * 3. 读取数字值
 * 
 * 特点：
 * - 支持多个候选键名，按优先级顺序查找
 * - 类型安全，自动过滤无效值
 * - 支持null和undefined输入
 */

/**
 * 从元数据中读取字符串值
 * 按键的顺序依次查找，返回第一个有效的非空字符串
 * 
 * @param meta - 元数据对象，可以是Record、null或undefined
 * @param keys - 要查找的键列表，按优先级顺序
 * @returns 找到的第一个非空字符串，未找到则返回undefined
 * 
 * 示例：
 * - readString({name: "test"}, ["name"]) -> "test"
 * - readString({title: "test", name: "test2"}, ["name", "title"]) -> "test2"
 * - readString({name: ""}, ["name"]) -> undefined
 */
export function readString(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  // 如果元数据为空，返回undefined
  if (!meta) {
    return undefined;
  }
  // 遍历所有键，按优先级顺序查找
  for (const key of keys) {
    const value = meta[key];
    // 检查是否为非空字符串
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  // 未找到有效值，返回undefined
  return undefined;
}

/**
 * 从元数据中读取布尔值
 * 按键的顺序依次查找，返回第一个布尔值
 * 
 * @param meta - 元数据对象，可以是Record、null或undefined
 * @param keys - 要查找的键列表，按优先级顺序
 * @returns 找到的第一个布尔值，未找到则返回undefined
 * 
 * 示例：
 * - readBool({enabled: true}, ["enabled"]) -> true
 * - readBool({active: false, enabled: true}, ["enabled", "active"]) -> true
 * - readBool({enabled: "true"}, ["enabled"]) -> undefined
 */
export function readBool(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): boolean | undefined {
  // 如果元数据为空，返回undefined
  if (!meta) {
    return undefined;
  }
  // 遍历所有键，按优先级顺序查找
  for (const key of keys) {
    const value = meta[key];
    // 检查是否为布尔值
    if (typeof value === "boolean") {
      return value;
    }
  }
  // 未找到有效值，返回undefined
  return undefined;
}

/**
 * 从元数据中读取数字值
 * 按键的顺序依次查找，返回第一个有效的有限数字
 * 
 * @param meta - 元数据对象，可以是Record、null或undefined
 * @param keys - 要查找的键列表，按优先级顺序
 * @returns 找到的第一个有限数字，未找到则返回undefined
 * 
 * 注意：
 * - 排除Infinity和NaN
 * - 只接受number类型，不接受字符串形式的数字
 * 
 * 示例：
 * - readNumber({count: 42}, ["count"]) -> 42
 * - readNumber({total: 100, count: 42}, ["count", "total"]) -> 42
 * - readNumber({count: Infinity}, ["count"]) -> undefined
 * - readNumber({count: "42"}, ["count"]) -> undefined
 */
export function readNumber(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  // 如果元数据为空，返回undefined
  if (!meta) {
    return undefined;
  }
  // 遍历所有键，按优先级顺序查找
  for (const key of keys) {
    const value = meta[key];
    // 检查是否为有效的有限数字（排除Infinity和NaN）
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  // 未找到有效值，返回undefined
  return undefined;
}
