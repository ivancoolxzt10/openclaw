// 本文件是 `$include` 功能的核心实现。
// 与 `includes-scan.ts`（只负责查找路径）不同，本文件负责读取、解析、合并和验证被包含的文件。
//
// @example
// ```json5
// {
//   "$include": "./base.json5",           // 包含单个文件
//   "$include": ["./a.json5", "./b.json5"] // 合并多个文件
// }
// ```

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { canUseBoundaryFileOpen, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isPathInside } from "../security/scan-paths.js";
import { isPlainObject } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

// --- 常量 ---
export const INCLUDE_KEY = "$include"; // 在 JSON5 文件中使用的特殊键
export const MAX_INCLUDE_DEPTH = 10; // 最大包含深度，防止无限递归
export const MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024; // 包含文件的最大体积（2MB）

// --- 类型定义 ---
export type IncludeResolver = {
  readFile: (path: string) => string;
  readFileWithGuards?: (params: IncludeFileReadParams) => string; // 带安全守卫的文件读取方法
  parseJson: (raw: string) => unknown;
};

export type IncludeFileReadParams = {
  includePath: string;
  resolvedPath: string;
  rootRealDir: string;
  ioFs?: typeof fs;
  maxBytes?: number;
};

// --- 自定义错误 ---
export class ConfigIncludeError extends Error {
  constructor(message: string, public readonly includePath: string, public readonly cause?: Error) {
    super(message);
    this.name = "ConfigIncludeError";
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  constructor(public readonly chain: string[]) {
    super(`检测到循环包含: ${chain.join(" -> ")}`, chain[chain.length - 1]);
    this.name = "CircularIncludeError";
  }
}

// --- 工具函数 ---

/**
 * 深度合并两个值。
 * 规则：数组会连接，对象会递归合并，其他原始类型则由 `source` 覆盖 `target`。
 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (isBlockedObjectKey(key)) continue; // 防止原型链污染
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

// --- 核心处理器类 ---

class IncludeProcessor {
  private visited = new Set<string>(); // 跟踪已访问的文件路径，以检测循环
  private depth = 0; // 当前的递归深度
  private readonly rootDir: string; // 配置的根目录
  private readonly rootRealDir: string; // 配置的真实根目录（解析了符号链接）

  constructor(private basePath: string, private resolver: IncludeResolver, rootDir?: string) {
    this.visited.add(path.normalize(basePath));
    this.rootDir = path.normalize(rootDir ?? path.dirname(basePath));
    this.rootRealDir = path.normalize(safeRealpath(this.rootDir));
  }

  /**
   * 处理一个未知类型的值，递归地解析其中的 `$include`。
   */
  process(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map((item) => this.process(item));
    }
    if (!isPlainObject(obj)) {
      return obj;
    }
    // 如果对象中没有 `$include` 键，则只需递归处理其子属性。
    if (!(INCLUDE_KEY in obj)) {
      return this.processObject(obj);
    }
    // 否则，处理 `$include` 指令。
    return this.processInclude(obj);
  }

  private processObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.process(value);
    }
    return result;
  }

  /**
   * 处理包含 `$include` 键的对象。
   */
  private processInclude(obj: Record<string, unknown>): unknown {
    const includeValue = obj[INCLUDE_KEY];
    const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
    // 解析 `$include` 指向的内容
    const included = this.resolveInclude(includeValue);

    // 如果没有其他同级键，直接返回包含的内容。
    if (otherKeys.length === 0) {
      return included;
    }
    // 如果有同级键，那么被包含的内容必须是一个对象，以便合并。
    if (!isPlainObject(included)) {
      throw new ConfigIncludeError(
        "当存在同级键时，被包含的内容必须是一个对象",
        typeof includeValue === "string" ? includeValue : INCLUDE_KEY,
      );
    }

    // 将被包含的内容与同级键进行合并。
    const rest: Record<string, unknown> = {};
    for (const key of otherKeys) {
      rest[key] = this.process(obj[key]); // 递归处理同级键的值
    }
    return deepMerge(included, rest);
  }

  /**
   * 根据 `$include` 的值（字符串或数组）解析内容。
   */
  private resolveInclude(value: unknown): unknown {
    if (typeof value === "string") {
      return this.loadFile(value);
    }
    if (Array.isArray(value)) {
      // 如果是数组，则加载并合并所有文件。
      return value.reduce<unknown>((merged, item) => {
        if (typeof item !== "string") {
          throw new ConfigIncludeError(`无效的 $include 数组成员：期望是字符串，但得到 ${typeof item}`, String(item));
        }
        return deepMerge(merged, this.loadFile(item));
      }, {});
    }
    throw new ConfigIncludeError(`无效的 $include 值：期望是字符串或字符串数组，但得到 ${typeof value}`, String(value));
  }

  /**
   * 加载、解析和处理单个被包含的文件。
   */
  private loadFile(includePath: string): unknown {
    const resolvedPath = this.resolvePath(includePath);
    this.checkCircular(resolvedPath);
    this.checkDepth(includePath);
    const raw = this.readFile(includePath, resolvedPath);
    const parsed = this.parseFile(includePath, resolvedPath, raw);
    return this.processNested(resolvedPath, parsed);
  }

  /**
   * 解析并验证文件路径的安全性。
   */
  private resolvePath(includePath: string): string {
    const configDir = path.dirname(this.basePath);
    const resolved = path.isAbsolute(includePath) ? includePath : path.resolve(configDir, includePath);
    const normalized = path.normalize(resolved);

    // 安全性检查：拒绝跨出顶级配置目录的路径（路径遍历攻击 CWE-22）。
    if (!isPathInside(this.rootDir, normalized)) {
      throw new ConfigIncludeError(`包含路径逃逸了配置目录: ${includePath} (根目录: ${this.rootDir})`, includePath);
    }

    // 安全性检查：解析符号链接并重新验证，以防止符号链接绕过。
    try {
      const real = fs.realpathSync(normalized);
      if (!isPathInside(this.rootRealDir, real)) {
        throw new ConfigIncludeError(`包含路径解析到了配置目录之外 (符号链接): ${includePath} (根目录: ${this.rootDir})`, includePath);
      }
    } catch (err) {
      if (err instanceof ConfigIncludeError) throw err;
      // 文件尚不存在 - 上面的规范化路径检查已足够。
    }
    return normalized;
  }

  private checkCircular(resolvedPath: string): void {
    if (this.visited.has(resolvedPath)) {
      throw new CircularIncludeError([...this.visited, resolvedPath]);
    }
  }

  private checkDepth(includePath: string): void {
    if (this.depth >= MAX_INCLUDE_DEPTH) {
      throw new ConfigIncludeError(`超过最大包含深度 (${MAX_INCLUDE_DEPTH}) 于: ${includePath}`, includePath);
    }
  }

  private readFile(includePath: string, resolvedPath: string): string {
    try {
      if (this.resolver.readFileWithGuards) {
        return this.resolver.readFileWithGuards({ includePath, resolvedPath, rootRealDir: this.rootRealDir });
      }
      return this.resolver.readFile(resolvedPath);
    } catch (err) {
      if (err instanceof ConfigIncludeError) throw err;
      throw new ConfigIncludeError(`读取包含文件失败: ${includePath} (解析后: ${resolvedPath})`, includePath, err instanceof Error ? err : undefined);
    }
  }

  private parseFile(includePath: string, resolvedPath: string, raw: string): unknown {
    try {
      return this.resolver.parseJson(raw);
    } catch (err) {
      throw new ConfigIncludeError(`解析包含文件失败: ${includePath} (解析后: ${resolvedPath})`, includePath, err instanceof Error ? err : undefined);
    }
  }
  
  /**
   * 为嵌套的包含创建一个新的处理器实例并进行处理。
   */
  private processNested(resolvedPath: string, parsed: unknown): unknown {
    const nested = new IncludeProcessor(resolvedPath, this.resolver, this.rootDir);
    nested.visited = new Set([...this.visited, resolvedPath]); // 继承已访问集合
    nested.depth = this.depth + 1; // 增加深度
    return nested.process(parsed);
  }
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * 使用额外的安全守卫读取包含文件。
 * 确保文件是常规文件，大小在限制内，并且不是硬链接。
 */
export function readConfigIncludeFileWithGuards(params: IncludeFileReadParams): string {
  const ioFs = params.ioFs ?? fs;
  const maxBytes = params.maxBytes ?? MAX_INCLUDE_FILE_BYTES;
  if (!canUseBoundaryFileOpen(ioFs)) {
    return ioFs.readFileSync(params.resolvedPath, "utf-8");
  }

  const opened = openBoundaryFileSync({ ...params, absolutePath: params.resolvedPath, rootPath: params.rootRealDir, boundaryLabel: "config directory", skipLexicalRootCheck: true, maxBytes });
  if (!opened.ok) {
    if (opened.reason === "validation") {
      throw new ConfigIncludeError(`包含文件未通过安全检查 (常规文件, 最大 ${maxBytes} 字节, 无硬链接): ${params.includePath}`, params.includePath);
    }
    throw new ConfigIncludeError(`读取包含文件失败: ${params.includePath} (解析后: ${params.resolvedPath})`, params.includePath, opened.error instanceof Error ? opened.error : undefined);
  }

  try {
    return ioFs.readFileSync(opened.fd, "utf-8");
  } finally {
    ioFs.closeSync(opened.fd);
  }
}

// --- 公共 API ---

const defaultResolver: IncludeResolver = {
  readFile: (p) => fs.readFileSync(p, "utf-8"),
  readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) => readConfigIncludeFileWithGuards({ includePath, resolvedPath, rootRealDir }),
  parseJson: (raw) => JSON5.parse(raw),
};

/**
 * 解析已解析配置对象中的所有 `$include` 指令。
 * 这是此模块的主要公共入口点。
 */
export function resolveConfigIncludes(
  obj: unknown,
  configPath: string,
  resolver: IncludeResolver = defaultResolver,
): unknown {
  return new IncludeProcessor(configPath, resolver).process(obj);
}
