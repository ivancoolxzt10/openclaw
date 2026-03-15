// 本文件提供了一组实用函数，用于通过点分路径（例如 "foo.bar.baz"）来操作配置对象。
// 这允许动态地获取、设置和删除嵌套在普通 JavaScript 对象中的值。

import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

// 定义一个路径节点的类型，它是一个可以有任意字符串键和未知值的记录。
type PathNode = Record<string, unknown>;

/**
 * 解析一个原始的字符串路径。
 * 它验证路径的有效性，并将其分割成一个部分数组。
 * @param raw 原始的点分符号字符串路径。
 * @returns 一个结果对象，包含：
 *   - `ok`: 一个布尔值，表示解析是否成功。
 *   - `path`: 一个字符串数组，表示路径的各个部分（如果成功）。
 *   - `error`: 一个错误消息字符串（如果失败）。
 */
export function parseConfigPath(raw: string): {
  ok: boolean;
  path?: string[];
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "路径无效。请使用点分表示法 (例如 foo.bar)。",
    };
  }
  const parts = trimmed.split(".").map((part) => part.trim());
  // 检查是否有空的部分，例如 "foo..bar"
  if (parts.some((part) => !part)) {
    return {
      ok: false,
      error: "路径无效。请使用点分表示法 (例如 foo.bar)。",
    };
  }
  // 检查是否有被阻止的键，以防止原型链污染
  if (parts.some((part) => isBlockedObjectKey(part))) {
    return { ok: false, error: "路径段无效。" };
  }
  return { ok: true, path: parts };
}

/**
 * 在根对象中的指定路径上设置一个值。
 * 如果路径中的中间对象不存在，它会自动创建它们。
 * @param root 根配置对象。
 * @param path 路径部分的数组。
 * @param value 要设置的值。
 */
export function setConfigValueAtPath(root: PathNode, path: string[], value: unknown): void {
  let cursor: PathNode = root;
  // 遍历到路径的倒数第二部分
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = cursor[key];
    // 如果下一级不是一个普通对象，则创建一个新的空对象
    if (!isPlainObject(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as PathNode;
  }
  // 在路径的最后一部分设置值
  cursor[path[path.length - 1]] = value;
}

/**
 * 在根对象中删除指定路径上的值。
 * 删除值后，它会清理路径上留下的任何空对象。
 * @param root 根配置对象。
 * @param path 路径部分的数组。
 * @returns 如果值被成功删除，则返回 `true`；否则返回 `false`（例如，路径不存在）。
 */
export function unsetConfigValueAtPath(root: PathNode, path: string[]): boolean {
  // 堆栈用于存储遍历过程中的节点和键，以便后续清理
  const stack: Array<{ node: PathNode; key: string }> = [];
  let cursor: PathNode = root;
  // 遍历到路径的倒数第二部分
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = cursor[key];
    // 如果路径中的任何部分不是对象，则无法删除，返回 false
    if (!isPlainObject(next)) {
      return false;
    }
    stack.push({ node: cursor, key });
    cursor = next;
  }
  const leafKey = path[path.length - 1];
  // 如果叶子键不存在，则无法删除
  if (!(leafKey in cursor)) {
    return false;
  }
  // 删除叶子节点
  delete cursor[leafKey];
  // 从下往上回溯，清理空对象
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, key } = stack[idx];
    const child = node[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete node[key];
    } else {
      // 一旦遇到非空对象，就停止清理
      break;
    }
  }
  return true;
}

/**
 * 从根对象中的指定路径获取一个值。
 * @param root 根配置对象。
 * @param path 路径部分的数组。
 * @returns 路径处的值，如果路径无效或不存在，则返回 `undefined`。
 */
export function getConfigValueAtPath(root: PathNode, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}
