// 本文件实现了应用“合并补丁（Merge Patch）”的逻辑。
// 合并补丁是一种用于描述对 JSON 文档进行更改的特定格式，由 RFC 7386 定义。
// 此实现还包含一个自定义扩展，用于智能地合并对象数组。

import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  /**
   * 是否启用按 `id` 合并对象数组的自定义逻辑。
   */
  mergeObjectArraysById?: boolean;
};

/**
 * 类型保护函数，检查一个值是否是带有字符串 `id` 属性的对象。
 */
function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

/**
 * 【自定义扩展逻辑】按 `id` 键合并对象数组。
 *
 * 规则:
 * - 基础（base）数组必须完全由带 `id` 的对象组成；否则，此逻辑不适用。
 * - 补丁（patch）中带有效 `id` 的条目会通过 `id` 与基础数组中的条目合并。
 * - 补丁中 `id` 是新的或无效的条目，会被追加到数组末尾。
 *
 * @returns 合并后的新数组，如果基础数组不符合要求，则返回 `undefined`。
 */
function mergeObjectArraysById(
  base: unknown[],
  patch: unknown[],
  options: MergePatchOptions,
): unknown[] | undefined {
  // 检查基础数组是否符合要求
  if (!base.every(isObjectWithStringId)) {
    return undefined;
  }

  const merged: unknown[] = [...base];
  // 创建一个 id -> 索引 的映射，以提高查找效率
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (!isObjectWithStringId(entry)) return undefined; // 再次确认
    indexById.set(entry.id, index);
  }

  for (const patchEntry of patch) {
    if (!isObjectWithStringId(patchEntry)) {
      // 如果补丁条目没有 id，直接追加
      merged.push(structuredClone(patchEntry));
      continue;
    }

    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      // 如果 id 是新的，追加
      merged.push(structuredClone(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }

    // 如果 id 已存在，则递归地将补丁合并到现有条目上
    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, options);
  }

  return merged;
}

/**
 * 将一个合并补丁（patch）应用到一个基础值（base）上。
 *
 * @param base 原始值。
 * @param patch 描述更改的补丁对象。
 * @param options 合并选项，例如是否启用自定义的数组合并。
 * @returns 应用补丁后的新值。
 */
export function applyMergePatch(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions = {},
): unknown {
  // RFC 规则：如果补丁本身不是一个对象，则它会完全替换基础值。
  if (!isPlainObject(patch)) {
    return patch;
  }

  // 从基础对象的浅拷贝开始（如果是对象的话）
  const result: PlainObject = isPlainObject(base) ? { ...base } : {};

  for (const [key, value] of Object.entries(patch)) {
    // 安全性：跳过被阻止的键，以防止原型链污染。
    if (isBlockedObjectKey(key)) {
      continue;
    }
    // RFC 规则：如果补丁中某个键的值为 `null`，则从基础对象中删除该键。
    if (value === null) {
      delete result[key];
      continue;
    }
    
    // 自定义扩展：如果启用了 `mergeObjectArraysById` 并且对应的值都是数组，
    // 则尝试按 `id` 进行智能合并。
    if (options.mergeObjectArraysById && Array.isArray(result[key]) && Array.isArray(value)) {
      const mergedArray = mergeObjectArraysById(result[key] as unknown[], value, options);
      if (mergedArray) {
        result[key] = mergedArray;
        continue;
      }
      // 如果智能合并失败，则回退到默认的“替换”行为（在循环末尾处理）。
    }
    
    // RFC 规则：如果补丁中的值是一个对象，则递归地应用合并。
    if (isPlainObject(value)) {
      const baseValue = result[key];
      result[key] = applyMergePatch(isPlainObject(baseValue) ? baseValue : {}, value, options);
      continue;
    }
    
    // RFC 规则：对于所有其他类型（字符串、数字、布尔值、以及默认情况下的数组），
    // 补丁中的值会直接替换基础值。
    result[key] = value;
  }

  return result;
}
