// 本文件提供了用于从配置中解析和验证字节大小值的功能。
// 它可以处理原始数字（表示字节）和人类可读的字符串（如 "2mb"、"512kb"）。

import { parseByteSize } from "../cli/parse-bytes.js";

/**
 * 从配置中解析一个可选的、非负的字节大小值。
 * 接受非负数字或像 "2mb" 这样的字符串。
 * @param value 要解析的未知类型的值。
 * @returns 解析出的字节数（数字），如果输入无效、为空或为负数，则返回 `null`。
 */
export function parseNonNegativeByteSize(value: unknown): number | null {
  // 如果值是数字
  if (typeof value === "number" && Number.isFinite(value)) {
    const int = Math.floor(value); // 取整数部分
    return int >= 0 ? int : null; // 必须是非负数
  }
  // 如果值是字符串
  if (typeof value === "string") {
    const trimmed = value.trim(); // 去除首尾空格
    if (!trimmed) {
      return null; // 空字符串无效
    }
    try {
      // 使用 `parseByteSize` 库进行解析，默认单位是字节 'b'
      const bytes = parseByteSize(trimmed, { defaultUnit: "b" });
      return bytes >= 0 ? bytes : null; // 必须是非负数
    } catch {
      // 如果解析失败（例如，格式不正确），返回 null
      return null;
    }
  }
  // 其他所有类型都无效
  return null;
}

/**
 * 验证一个字符串是否是有效的非负字节大小表示。
 * @param value 要验证的字符串。
 * @returns 如果字符串可以被成功解析为一个非负字节数，则返回 `true`。
 */
export function isValidNonNegativeByteSizeString(value: string): boolean {
  // 尝试解析字符串，如果不返回 null，则表示有效。
  return parseNonNegativeByteSize(value) !== null;
}
