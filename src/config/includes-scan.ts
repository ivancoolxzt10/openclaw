// 本文件实现了处理配置文件中 `$include` 指令的逻辑。
// 这个功能允许一个配置文件被拆分成多个更小、可复用的部分。
// 本文件的任务就是递归地找到所有被包含的文件。

import * as fs from "node:fs/promises";
import path from "node:path";
import JSON5 from "json5";
import { INCLUDE_KEY, MAX_INCLUDE_DEPTH } from "./includes.js";

/**
 * 从一个已解析的对象中列出所有直接的 `$include` 路径。
 * 它会递归地遍历对象和数组，寻找 `INCLUDE_KEY`（例如 "$include"）并收集其值。
 * @param parsed 已解析的 JSON5 对象。
 * @returns 一个包含所有找到的 `$include` 路径的字符串数组。
 */
function listDirectIncludes(parsed: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (!value) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (typeof value !== "object") return;

    const rec = value as Record<string, unknown>;
    const includeVal = rec[INCLUDE_KEY];
    // `$include` 的值可以是一个字符串或一个字符串数组
    if (typeof includeVal === "string") {
      out.push(includeVal);
    } else if (Array.isArray(includeVal)) {
      for (const item of includeVal) {
        if (typeof item === "string") out.push(item);
      }
    }
    // 继续遍历对象的其他所有值
    for (const v of Object.values(rec)) {
      visit(v);
    }
  };
  visit(parsed);
  return out;
}

/**
 * 解析 `$include` 路径。
 * 如果 includePath 是相对路径，它会根据基础配置文件（baseConfigPath）的目录来解析成绝对路径。
 * 如果 includePath 本身就是绝对路径，则直接使用它。
 * @param baseConfigPath 当前正在处理的配置文件的路径。
 * @param includePath 从文件中读取到的 `$include` 路径。
 * @returns 规范化的绝对路径。
 */
function resolveIncludePath(baseConfigPath: string, includePath: string): string {
  return path.normalize(
    path.isAbsolute(includePath)
      ? includePath
      : path.resolve(path.dirname(baseConfigPath), includePath),
  );
}

/**
 * 递归地收集所有 `$include` 的文件路径。
 * 这是本模块的主要函数。
 * @param params 包含根配置文件路径及其已解析内容的对象。
 * @returns 一个扁平化的、包含了所有唯一且递归发现的被包含文件路径的数组。
 */
export async function collectIncludePathsRecursive(params: {
  configPath: string;
  parsed: unknown;
}): Promise<string[]> {
  const visited = new Set<string>(); // 用于防止循环引用和重复处理
  const result: string[] = [];

  /**
   * 递归的遍历函数。
   * @param basePath 当前文件的路径。
   * @param parsed 当前文件已解析的内容。
   * @param depth 当前的递归深度。
   */
  const walk = async (basePath: string, parsed: unknown, depth: number): Promise<void> => {
    // 防止无限递归
    if (depth > MAX_INCLUDE_DEPTH) {
      return;
    }

    for (const raw of listDirectIncludes(parsed)) {
      const resolved = resolveIncludePath(basePath, raw);
      if (visited.has(resolved)) {
        continue; // 如果已经访问过，则跳过
      }
      visited.add(resolved);
      result.push(resolved);

      // 异步读取被包含的文件内容
      const rawText = await fs.readFile(resolved, "utf-8").catch(() => null);
      if (!rawText) {
        continue; // 如果文件读取失败，则跳过
      }

      // 解析被包含的文件
      const nestedParsed = (() => {
        try {
          return JSON5.parse(rawText);
        } catch {
          return null;
        }
      })();

      if (nestedParsed) {
        // 如果解析成功，则对这个新文件进行递归遍历
        // eslint-disable-next-line no-await-in-loop
        await walk(resolved, nestedParsed, depth + 1);
      }
    }
  };

  // 从根配置文件开始遍历
  await walk(params.configPath, params.parsed, 0);
  return result;
}
