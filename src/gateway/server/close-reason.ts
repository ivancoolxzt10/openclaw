// 本文件包含一个用于处理 WebSocket 关闭原因（close reason）的实用工具函数。
// 它的主要作用是确保关闭原因字符串的字节长度不会超过 WebSocket 协议规定的限制。

import { Buffer } from "node:buffer";

/**
 * WebSocket 协议规定，关闭帧中的原因描述字符串，其 UTF-8 编码后的字节长度不能超过 123 字节。
 * 这里使用 120 字节作为安全上限。
 */
const CLOSE_REASON_MAX_BYTES = 120;

/**
 * 截断一个 WebSocket 关闭原因字符串，以确保其字节长度符合协议要求。
 *
 * @param reason - 原始的原因字符串。
 * @param maxBytes - （可选）允许的最大字节数。
 * @returns 经过截断处理后、符合长度限制的字符串。
 */
export function truncateCloseReason(reason: string, maxBytes = CLOSE_REASON_MAX_BYTES): string {
  if (!reason) {
    // 如果没有提供原因，则返回一个默认的错误信息。
    return "invalid handshake";
  }

  // 1. 将字符串转换为 Buffer，以便准确地获取其 UTF-8 编码的字节长度。
  //    直接使用 `string.length` 是不准确的，因为它只计算字符数量。
  const buf = Buffer.from(reason);

  // 2. 如果字节长度未超过限制，则直接返回原始字符串。
  if (buf.length <= maxBytes) {
    return reason;
  }

  // 3. 如果超过限制，则截取 Buffer 的一部分，并将其转换回字符串。
  //    这可以确保最终的字符串字节长度不会超过 `maxBytes`。
  return buf.subarray(0, maxBytes).toString();
}
