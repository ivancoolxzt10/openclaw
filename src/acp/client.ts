/**
 * ACP (Agent Client Protocol) 客户端实现
 * 
 * 功能概述：
 * 1. 与Agent服务器建立通信连接
 * 2. 处理工具调用的权限请求和验证
 * 3. 实现细粒度的安全控制机制
 * 4. 提供交互式用户界面
 * 5. 管理会话生命周期
 * 
 * 主要组件：
 * - 权限解析系统：自动批准安全工具，提示用户确认危险操作
 * - 路径安全检查：确保文件操作限制在指定范围内
 * - 环境变量管理：控制传递给服务器的环境变量
 * - 会话管理：创建、初始化和维护会话
 */

import { spawn, type ChildProcess } from "node:child_process";
// 导入Node.js的子进程模块，用于启动和管理Agent服务器进程

import fs from "node:fs";
// 导入文件系统模块，用于文件操作

import { homedir } from "node:os";
// 导入操作系统模块的homedir函数，用于获取用户主目录

import path from "node:path";
// 导入路径处理模块，用于路径解析和规范化

import * as readline from "node:readline";
// 导入readline模块，用于处理交互式命令行输入

import { Readable, Writable } from "node:stream";
// 导入流模块，用于处理数据流

import { fileURLToPath } from "node:url";
// 导入URL转换模块，用于将文件URL转换为文件路径

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
// 从ACP SDK导入核心类型和工具

import { isKnownCoreToolId } from "../agents/tool-catalog.js";
// 导入工具目录检查函数，用于验证是否为已知的核心工具

import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
// 导入路径环境管理工具

import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "../plugin-sdk/windows-spawn.js";
// 导入Windows平台的进程启动工具

import {
  listKnownProviderAuthEnvVarNames,
  omitEnvKeysCaseInsensitive,
} from "../secrets/provider-env-vars.js";
// 导入环境变量管理工具

import { DANGEROUS_ACP_TOOLS } from "../security/dangerous-tools.js";
// 导入危险工具列表，用于安全控制

// 定义可以自动批准的安全工具ID集合
const SAFE_AUTO_APPROVE_TOOL_IDS = new Set(["read", "search", "web_search", "memory_search"]);

// 定义受信任的安全工具别名
const TRUSTED_SAFE_TOOL_ALIASES = Set(["search"]);

// 定义read工具中可能包含路径的参数键名
const READ_TOOL_PATH_KEYS = ["path", "file_path", "filePath"];

// 定义工具名称的最大长度限制
const TOOL_NAME_MAX_LENGTH = 128;

// 定义工具名称的合法格式正则表达式（只允许小写字母、数字、点、下划线和短横线）
const TOOL_NAME_PATTERN = /^[a-z0-9._-]+$/;

// 定义工具ID到工具类型的映射
const TOOL_KIND_BY_ID = new Map<string, string>([
  ["read", "read"],
  ["search", "search"],
  ["web_search", "search"],
  ["memory_search", "search"],
]);

// 定义权限选项类型
type PermissionOption = RequestPermissionRequest["options"][number];

// 定义权限解析器的依赖项类型
type PermissionResolverDeps = {
  prompt?: (toolName: string | undefined, toolTitle?: string) => Promise<boolean>;
  // 可选的提示函数，用于询问用户是否批准权限
  log?: (line: string) => void;
  // 可选的日志函数，用于记录权限处理过程
  cwd?: string;
  // 可选的当前工作目录，用于路径解析
};

/**
 * 将未知值转换为Record对象
 * @param value - 要转换的值
 * @returns 如果值是对象且非数组，则返回Record对象，否则返回undefined
 * 
 * 这是一个类型守卫函数，用于安全地将unknown类型转换为Record类型
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  // 检查value是否存在，且是对象类型，且不是数组
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 从源对象中按指定键的顺序查找第一个非空字符串值
 * @param source - 要查找的源对象
 * @param keys - 要查找的键列表，按优先级顺序
 * @returns 找到的第一个非空字符串值，未找到则返回undefined
 * 
 * 这个函数用于从工具调用的元数据或参数中提取特定值
 */
function readFirstStringValue(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  // 如果源对象不存在，直接返回undefined
  if (!source) {
    return undefined;
  }
  // 遍历所有键，按顺序查找
  for (const key of keys) {
    const value = source[key];
    // 检查值是否为非空字符串
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  // 所有键都查找完毕仍未找到，返回undefined
  return undefined;
}

/**
 * 规范化工具名称
 * @param value - 原始工具名称
 * @returns 规范化后的工具名称（小写、去除空格），如果不符合规则则返回undefined
 * 
 * 规范化规则：
 * 1. 去除首尾空格
 * 2. 转换为小写
 * 3. 长度不超过128字符
 * 4. 只包含小写字母、数字、点、下划线和短横线
 */
function normalizeToolName(value: string): string | undefined {
  // 去除首尾空格并转换为小写
  const normalized = value.trim().toLowerCase();
  // 检查是否为空或超过最大长度
  if (!normalized || normalized.length > TOOL_NAME_MAX_LENGTH) {
    return undefined;
  }
  // 检查是否符合命名规则
  if (!TOOL_NAME_PATTERN.test(normalized)) {
    return undefined;
  }
  // 返回规范化后的名称
  return normalized;
}

/**
 * 从工具标题中解析工具名称
 * @param title - 工具标题，格式通常为 "工具名: 描述"
 * @returns 解析出的工具名称，解析失败则返回undefined
 * 
 * 示例：
 * - "read: 读取文件内容" -> "read"
 * - "search: 搜索代码" -> "search"
 */
function parseToolNameFromTitle(title: string | undefined | null): string | undefined {
  // 如果标题不存在，返回undefined
  if (!title) {
    return undefined;
  }
  // 按冒号分割标题，取第一部分
  const head = title.split(":", 1)[0]?.trim();
  // 如果第一部分为空，返回undefined
  if (!head) {
    return undefined;
  }
  // 规范化工具名称
  return normalizeToolName(head);
}

/**
 * 根据工具名称解析工具类型用于权限控制
 * @param toolName - 工具名称
 * @returns 工具类型（read/search/other），未知类型返回"other"
 * 
 * 工具类型用于权限决策，不同类型可能有不同的安全策略
 */
function resolveToolKindForPermission(toolName: string | undefined): string | undefined {
  // 如果工具名称不存在，返回undefined
  if (!toolName) {
    return undefined;
  }
  // 从映射表中查找工具类型，未找到则返回"other"
  return TOOL_KIND_BY_ID.get(toolName) ?? "other";
}

/**
 * 从权限请求参数中解析工具名称
 * 依次从元数据、原始输入和标题中尝试获取工具名称
 * @param params - 权限请求参数
 * @returns 规范化后的工具名称，未找到则返回undefined
 * 
 * 解析优先级：
 * 1. 工具调用元数据中的toolName/tool_name/name字段
 * 2. 原始输入中的tool/toolName/tool_name/name字段
 * 3. 工具标题中的工具名部分
 */
function resolveToolNameForPermission(params: RequestPermissionRequest): string | undefined {
  // 获取工具调用对象
  const toolCall = params.toolCall;
  // 从元数据中提取工具信息
  const toolMeta = asRecord(toolCall?._meta);
  // 从原始输入中提取工具信息
  const rawInput = asRecord(toolCall?.rawInput);

  // 优先从元数据中查找工具名称
  const fromMeta = readFirstStringValue(toolMeta, ["toolName", "tool_name", "name"]);
  // 其次从原始输入中查找
  const fromRawInput = readFirstStringValue(rawInput, ["tool", "toolName", "tool_name", "name"]);
  // 最后从标题中解析
  const fromTitle = parseToolNameFromTitle(toolCall?.title);
  // 规范化并返回找到的工具名称
  return normalizeToolName(fromMeta ?? fromRawInput ?? fromTitle ?? "");
}

/**
 * 从工具标题中提取文件路径
 * 支持两种格式: "工具名: path: 文件路径" 或 "工具名: 文件路径"(仅read工具)
 * @param toolTitle - 工具标题
 * @param toolName - 工具名称
 * @returns 提取的文件路径，未找到则返回undefined
 * 
 * 示例：
 * - "read: path: /path/to/file" -> "/path/to/file"
 * - "read: /path/to/file" (当toolName为read时) -> "/path/to/file"
 */
function extractPathFromToolTitle(
  toolTitle: string | undefined,
  toolName: string | undefined,
): string | undefined {
  // 如果标题不存在，返回undefined
  if (!toolTitle) {
    return undefined;
  }
  // 查找冒号位置
  const separator = toolTitle.indexOf(":");
  // 如果没有冒号，返回undefined
  if (separator < 0) {
    return undefined;
  }
  // 提取冒号后的内容
  const tail = toolTitle.slice(separator + 1).trim();
  // 如果冒号后没有内容，返回undefined
  if (!tail) {
    return undefined;
  }
  // 尝试匹配"path:"、"file_path:"或"filePath:"格式
  const keyedMatch = tail.match(/(?:^|,\s*)(?:path|file_path|filePath)\s*:\s*([^,]+)/);
  if (keyedMatch?.[1]) {
    return keyedMatch[1].trim();
  }
  // 对于read工具，整个尾部都是路径
  if (toolName === "read") {
    return tail;
  }
  // 其他情况返回undefined
  return undefined;
}

/**
 * 解析工具调用的文件路径
 * 从原始输入参数和工具标题中尝试获取文件路径
 * @param params - 权限请求参数
 * @param toolName - 工具名称
 * @param toolTitle - 工具标题
 * @returns 解析出的文件路径，未找到则返回undefined
 */
function resolveToolPathCandidate(
  params: RequestPermissionRequest,
  toolName: string | undefined,
  toolTitle: string | undefined,
): string | undefined {
  // 从原始输入中提取路径
  const rawInput = asRecord(params.toolCall?.rawInput);
  const fromRawInput = readFirstStringValue(rawInput, READ_TOOL_PATH_KEYS);
  // 从工具标题中提取路径
  const fromTitle = extractPathFromToolTitle(toolTitle, toolName);
  // 优先使用原始输入中的路径
  return fromRawInput ?? fromTitle;
}

/**
 * 解析并返回绝对路径
 * 支持相对路径、绝对路径、file:// URL、~和~/等格式
 * @param value - 要解析的路径
 * @param cwd - 当前工作目录，用于解析相对路径
 * @returns 解析后的绝对路径，解析失败则返回undefined
 * 
 * 支持的路径格式：
 * - 绝对路径：/path/to/file
 * - 相对路径：./file 或 ../file
 * - URL格式：file:///path/to/file
 * - 主目录：~ 或 ~/path/to/file
 */
function resolveAbsoluteScopedPath(value: string, cwd: string): string | undefined {
  // 去除首尾空格
  let candidate = value.trim();
  // 如果路径为空，返回undefined
  if (!candidate) {
    return undefined;
  }
  // 处理file:// URL格式
  if (candidate.startsWith("file://")) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname || "");
    } catch {
      // URL解析失败，返回undefined
      return undefined;
    }
  }
  // 处理~（用户主目录）
  if (candidate === "~") {
    candidate = homedir();
  } else if (candidate.startsWith("~/")) {
    // 处理~/开头的路径
    candidate = path.join(homedir(), candidate.slice(2));
  }
  // 解析为绝对路径
  const absolute = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd, candidate);
  return absolute;
}

/**
 * 检查路径是否在指定根目录范围内
 * @param candidatePath - 要检查的路径
 * @param root - 根目录路径
 * @returns 如果路径在根目录内则返回true，否则返回false
 * 
 * 安全检查：
 * - 路径不能包含..（父目录引用）
 * - 路径不能是绝对路径
 * - 路径必须在root目录或其子目录中
 */
function isPathWithinRoot(candidatePath: string, root: string): boolean {
  // 计算相对路径
  const relative = path.relative(root, candidatePath);
  // 检查相对路径是否有效（不以..开头且不是绝对路径）
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 检查read工具调用是否限制在当前工作目录范围内
 * @param params - 权限请求参数
 * @param toolName - 工具名称
 * @param toolTitle - 工具标题
 * @param cwd - 当前工作目录
 * @returns 如果read工具访问的路径在cwd范围内则返回true
 * 
 * 这个函数用于确保read工具只能访问指定目录内的文件
 */
function isReadToolCallScopedToCwd(
  params: RequestPermissionRequest,
  toolName: string | undefined,
  toolTitle: string | undefined,
  cwd: string,
): boolean {
  // 只检查read工具
  if (toolName !== "read") {
    return false;
  }
  // 解析文件路径
  const rawPath = resolveToolPathCandidate(params, toolName, toolTitle);
  if (!rawPath) {
    return false;
  }
  // 解析为绝对路径
  const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
  if (!absolutePath) {
    return false;
  }
  // 检查路径是否在cwd范围内
  return isPathWithinRoot(absolutePath, path.resolve(cwd));
}

/**
 * 判断工具调用是否可以自动批准
 * 安全的工具（如read/search）在特定条件下可以自动批准
 * @param params - 权限请求参数
 * @param toolName - 工具名称
 * @param toolTitle - 工具标题
 * @param cwd - 当前工作目录
 * @returns 如果工具调用可以自动批准则返回true
 * 
 * 自动批准条件：
 * 1. 工具必须是已知的受信任工具
 * 2. 工具必须在安全自动批准列表中
 * 3. 如果是read工具，路径必须在当前工作目录范围内
 */
function shouldAutoApproveToolCall(
  params: RequestPermissionRequest,
  toolName: string | undefined,
  toolTitle: string | undefined,
  cwd: string,
): boolean {
  // 检查工具是否受信任
  const isTrustedToolId =
    typeof toolName === "string" &&
    (isKnownCoreToolId(toolName) || TRUSTED_SAFE_TOOL_ALIASES.has(toolName));
  // 如果工具不在安全列表中，不能自动批准
  if (!toolName || !isTrustedToolId || !SAFE_AUTO_APPROVE_TOOL_IDS.has(toolName)) {
    return false;
  }
  // 如果是read工具，需要检查路径范围
  if (toolName === "read") {
    return isReadToolCallScopedToCwd(params, toolName, toolTitle, cwd);
  }
  // 其他安全工具可以自动批准
  return true;
}

/**
 * 从选项列表中按类型优先级选择第一个匹配的选项
 * @param options - 权限选项列表
 * @param kinds - 要匹配的类型列表，按优先级顺序
 * @returns 找到的第一个匹配选项，未找到则返回undefined
 * 
 * 示例：
 * pickOption(options, ["allow_once", "allow_always"])
 * 会优先查找"allow_once"选项，找不到再查找"allow_always"
 */
function pickOption(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  // 按优先级遍历类型
  for (const kind of kinds) {
    // 查找匹配的选项
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  // 没有找到任何匹配的选项
  return undefined;
}

/**
 * 创建一个已选择的权限响应
 * @param optionId - 被选中的选项ID
 * @returns 权限响应对象
 */
function selectedPermission(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

/**
 * 创建一个已取消的权限响应
 * @returns 权限响应对象
 */
function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

/**
 * 提示用户确认权限请求
 * 在交互式终端中询问用户是否允许工具调用，30秒超时
 * @param toolName - 工具名称
 * @param toolTitle - 工具标题
 * @returns Promise<boolean> 用户是否批准权限
 * 
 * 功能：
 * - 检查是否为交互式终端
 * - 显示工具名称和标题
 * - 等待用户输入y/N
 * - 30秒无响应自动拒绝
 */
function promptUserPermission(toolName: string | undefined, toolTitle?: string): Promise<boolean> {
  // 如果不是交互式终端，直接拒绝
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);
  }
  // 创建Promise等待用户响应
  return new Promise((resolve) => {
    let settled = false;
    // 创建readline接口用于交互
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    // 完成函数，确保只执行一次
    const finish = (approved: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rl.close();
      resolve(approved);
    };

    // 设置30秒超时
    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);

    // 构建显示标签
    const label = toolTitle
      ? toolName
        ? `${toolTitle} (${toolName})`
        : toolTitle
      : (toolName ?? "unknown tool");
    // 询问用户
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = answer.trim().toLowerCase() === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}

/**
 * 解析并处理权限请求
 * 根据工具类型、安全级别和用户配置决定是否自动批准或需要用户确认
 * @param params - 权限请求参数
 * @param deps - 依赖项，包括日志、提示函数和工作目录
 * @returns 权限响应对象
 * 
 * 处理流程：
 * 1. 检查是否有可用选项
 * 2. 查找允许和拒绝选项
 * 3. 判断是否可以自动批准
 * 4. 如果需要提示，询问用户
 * 5. 返回相应的权限响应
 */
export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  deps: PermissionResolverDeps = {},
): Promise<RequestPermissionResponse> {
  // 获取依赖项
  const log = deps.log ?? ((line: string) => console.error(line));
  const prompt = deps.prompt ?? promptUserPermission;
  const cwd = deps.cwd ?? process.cwd();
  
  // 解析工具信息
  const options = params.options ?? [];
  const toolTitle = params.toolCall?.title ?? "tool";
  const toolName = resolveToolNameForPermission(params);
  const toolKind = resolveToolKindForPermission(toolName);

  // 如果没有可用选项，取消请求
  if (options.length === 0) {
    log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
    return cancelledPermission();
  }

  // 查找允许和拒绝选项
  const allowOption = pickOption(options, ["allow_once", "allow_always"]);
  const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
  
  // 判断是否需要提示用户
  const autoApproveAllowed = shouldAutoApproveToolCall(params, toolName, toolTitle, cwd);
  const promptRequired = !toolName || !autoApproveAllowed || DANGEROUS_ACP_TOOLS.has(toolName);

  // 如果不需要提示，自动批准
  if (!promptRequired) {
    const option = allowOption ?? options[0];
    if (!option) {
      log(`[permission cancelled] ${toolName}: no selectable options`);
      return cancelledPermission();
    }
    log(`[permission auto-approved] ${toolName} (${toolKind ?? "unknown"})`);
    return selectedPermission(option.optionId);
  }

  // 需要提示用户
  log(
    `\n[permission requested] ${toolTitle}${toolName ? ` (${toolName})` : ""}${toolKind ? ` [${toolKind}]` : ""}`,
  );
  const approved = await prompt(toolName, toolTitle);

  // 根据用户选择返回响应
  if (approved && allowOption) {
    return selectedPermission(allowOption.optionId);
  }
  if (!approved && rejectOption) {
    return selectedPermission(rejectOption.optionId);
  }

  // 没有合适的选项，取消请求
  log(
    `[permission cancelled] ${toolName ?? "unknown"}: missing ${approved ? "allow" : "reject"} option`,
  );
  return cancelledPermission();
}

// 定义ACP客户端选项类型
export type AcpClientOptions = {
  cwd?: string;
  // 工作目录
  serverCommand?: string;
  // 服务器命令
  serverArgs?: string[];
  // 服务器参数
  serverVerbose?: boolean;
  // 服务器是否输出详细日志
  verbose?: boolean;
  // 客户端是否输出详细日志
};

// 定义ACP客户端句柄类型
export type AcpClientHandle = {
  client: ClientSideConnection;
  // 客户端连接对象
  agent: ChildProcess;
  // Agent服务器进程
  sessionId: string;
  // 会话ID
};

/**
 * 将值转换为字符串数组
 * @param value - 字符串、字符串数组或undefined
 * @returns 字符串数组
 */
function toArgs(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * 构建服务器启动参数
 * @param opts - ACP客户端选项
 * @returns 服务器参数数组
 */
function buildServerArgs(opts: AcpClientOptions): string[] {
  const args = ["acp", ...toArgs(opts.serverArgs)];
  // 如果需要详细日志且未指定，添加--verbose参数
  if (opts.serverVerbose && !args.includes("--verbose") && !args.includes("-v")) {
    args.push("--verbose");
  }
  return args;
}

// 定义环境变量选项类型
type AcpClientSpawnEnvOptions = {
  stripKeys?: Iterable<string>;
  // 要移除的环境变量键
};

/**
 * 解析ACP客户端的环境变量配置
 * 从基础环境变量中移除指定的键，并添加OPENCLAW_SHELL标识
 * @param baseEnv - 基础环境变量，默认为process.env
 * @param options - 选项，包含要移除的环境变量键
 * @returns 配置后的环境变量对象
 */
export function resolveAcpClientSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: AcpClientSpawnEnvOptions = {},
): NodeJS.ProcessEnv {
  // 移除指定的环境变量键
  const env = omitEnvKeysCaseInsensitive(baseEnv, options.stripKeys ?? []);
  // 添加OPENCLAW_SHELL标识
  env.OPENCLAW_SHELL = "acp-client";
  return env;
}

/**
 * 判断是否需要为ACP服务器移除提供商认证环境变量
 * 只有在使用默认服务器命令和参数时才移除
 * @param params - 服务器命令和参数配置
 * @returns 如果使用默认配置则返回true
 * 
 * 安全考虑：
 * - 只在默认配置下移除认证信息
 * - 自定义服务器配置可能需要保留认证信息
 */
export function shouldStripProviderAuthEnvVarsForAcpServer(
  params: {
    serverCommand?: string;
    serverArgs?: string[];
    defaultServerCommand?: string;
    defaultServerArgs?: string[];
  } = {},
): boolean {
  const serverCommand = params.serverCommand?.trim();
  // 如果没有指定服务器命令，使用默认配置
  if (!serverCommand) {
    return true;
  }
  const defaultServerCommand = params.defaultServerCommand?.trim();
  // 如果服务器命令与默认命令不同，不移除
  if (!defaultServerCommand || serverCommand !== defaultServerCommand) {
    return false;
  }
  // 检查参数是否匹配
  const serverArgs = params.serverArgs ?? [];
  const defaultServerArgs = params.defaultServerArgs ?? [];
  return (
    serverArgs.length === defaultServerArgs.length &&
    serverArgs.every((arg, index) => arg === defaultServerArgs[index])
  );
}

/**
 * 构建需要从环境变量中移除的键集合
 * 包括活跃技能的环境变量键和提供商认证环境变量
 * @param params - 配置参数
 * @returns 需要移除的环境变量键集合
 */
export function buildAcpClientStripKeys(params: {
  stripProviderAuthEnvVars?: boolean;
  activeSkillEnvKeys?: Iterable<string>;
}): Set<string> {
  // 初始化键集合
  const stripKeys = new Set<string>(params.activeSkillEnvKeys ?? []);
  // 如果需要移除提供商认证环境变量
  if (params.stripProviderAuthEnvVars) {
    for (const key of listKnownProviderAuthEnvVarNames()) {
      stripKeys.add(key);
    }
  }
  return stripKeys;
}

// 定义运行时环境类型
type AcpSpawnRuntime = {
  platform: NodeJS.Platform;
  // 操作系统平台
  env: NodeJS.ProcessEnv;
  // 环境变量
  execPath: string;
  // Node.js可执行文件路径
};

// 默认运行时环境
const DEFAULT_ACP_SPAWN_RUNTIME: AcpSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

/**
 * 解析ACP客户端的启动调用参数
 * 处理Windows平台的特殊需求，返回适合spawn调用的参数
 * @param params - 服务器命令和参数
 * @param runtime - 运行时环境配置
 * @returns 启动参数对象
 * 
 * 跨平台处理：
 * - Windows平台需要特殊处理
 * - 支持shell模式
 * - 处理windowsHide选项
 */
export function resolveAcpClientSpawnInvocation(
  params: { serverCommand: string; serverArgs: string[] },
  runtime: AcpSpawnRuntime = DEFAULT_ACP_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  // 解析Windows平台的程序路径
  const program = resolveWindowsSpawnProgram({
    command: params.serverCommand,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "openclaw",
    allowShellFallback: true,
  });
  // 具体化启动参数
  const resolved = materializeWindowsSpawnProgram(program, params.serverArgs);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

/**
 * 解析当前模块的入口文件路径
 * 首先尝试从构建模块位置查找，然后尝试从进程argv获取
 * @returns 入口文件路径，未找到则返回null
 * 
 * 查找策略：
 * 1. 从当前模块位置向上查找entry.js
 * 2. 使用进程argv[1]作为入口文件
 */
function resolveSelfEntryPath(): string | null {
  // 优先使用相对于构建模块位置的路径
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = path.resolve(path.dirname(here), "..", "entry.js");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // 忽略错误
  }

  // 尝试使用进程argv[1]
  const argv1 = process.argv[1]?.trim();
  if (argv1) {
    return path.isAbsolute(argv1) ? argv1 : path.resolve(process.cwd(), argv1);
  }
  return null;
}

/**
 * 打印会话更新信息到控制台
 * 处理不同类型的会话更新，包括消息、工具调用和命令更新
 * @param notification - 会话通知对象
 * 
 * 支持的更新类型：
 * - agent_message_chunk: 代理消息片段
 * - tool_call: 工具调用
 * - tool_call_update: 工具调用更新
 * - available_commands_update: 可用命令更新
 */
function printSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;
  // 检查是否是会话更新
  if (!("sessionUpdate" in update)) {
    return;
  }

  // 根据更新类型处理
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      // 打印代理消息片段
      if (update.content?.type === "text") {
        process.stdout.write(update.content.text);
      }
      return;
    }
    case "tool_call": {
      // 打印工具调用信息
      console.log(`\n[tool] ${update.title} (${update.status})`);
      return;
    }
    case "tool_call_update": {
      // 打印工具调用更新
      if (update.status) {
        console.log(`[tool update] ${update.toolCallId}: ${update.status}`);
      }
      return;
    }
    case "available_commands_update": {
      // 打印可用命令列表
      const names = update.availableCommands?.map((cmd) => `/${cmd.name}`).join(" ");
      if (names) {
        console.log(`\n[commands] ${names}`);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * 创建ACP客户端连接
 * @param opts - 客户端配置选项
 * @returns 客户端句柄，包含客户端连接、Agent进程和会话ID
 * 
 * 创建流程：
 * 1. 配置工作目录和日志
 * 2. 解析服务器命令和参数
 * 3. 配置环境变量
 * 4. 启动Agent服务器进程
 * 5. 建立客户端连接
 * 6. 初始化协议和会话
 */
export async function createAcpClient(opts: AcpClientOptions = {}): Promise<AcpClientHandle> {
  // 获取配置
  const cwd = opts.cwd ?? process.cwd();
  const verbose = Boolean(opts.verbose);
  const log = verbose ? (msg: string) => console.error(`[acp-client] ${msg}`) : () => {};

  // 确保CLI在PATH中
  ensureOpenClawCliOnPath();
  // 构建服务器参数
  const serverArgs = buildServerArgs(opts);

  // 解析入口文件路径
  const entryPath = resolveSelfEntryPath();
  const defaultServerCommand = entryPath ? process.execPath : "openclaw";
  const defaultServerArgs = entryPath ? [entryPath, ...serverArgs] : serverArgs;
  const serverCommand = opts.serverCommand ?? defaultServerCommand;
  const effectiveArgs = opts.serverCommand || !entryPath ? serverArgs : defaultServerArgs;
  
  // 配置环境变量
  const { getActiveSkillEnvKeys } = await import("../agents/skills/env-overrides.runtime.js");
  const stripProviderAuthEnvVars = shouldStripProviderAuthEnvVarsForAcpServer({
    serverCommand,
    serverArgs: effectiveArgs,
    defaultServerCommand,
    defaultServerArgs,
  });
  const stripKeys = buildAcpClientStripKeys({
    stripProviderAuthEnvVars,
    activeSkillEnvKeys: getActiveSkillEnvKeys(),
  });
  const spawnEnv = resolveAcpClientSpawnEnv(process.env, { stripKeys });
  
  // 解析启动参数
  const spawnInvocation = resolveAcpClientSpawnInvocation(
    { serverCommand, serverArgs: effectiveArgs },
    {
      platform: process.platform,
      env: spawnEnv,
      execPath: process.execPath,
    },
  );

  // 记录启动信息
  log(`spawning: ${spawnInvocation.command} ${spawnInvocation.args.join(" ")}`);

  // 启动Agent服务器进程
  const agent = spawn(spawnInvocation.command, spawnInvocation.args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: spawnEnv,
    shell: spawnInvocation.shell,
    windowsHide: spawnInvocation.windowsHide,
  });

  // 检查stdio管道
  if (!agent.stdin || !agent.stdout) {
    throw new Error("Failed to create ACP stdio pipes");
  }

  // 创建流连接
  const input = Writable.toWeb(agent.stdin);
  const output = Readable.toWeb(agent.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  // 创建客户端连接
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params: SessionNotification) => {
        printSessionUpdate(params);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        return resolvePermissionRequest(params, { cwd });
      },
    }),
    stream,
  );

  // 初始化客户端
  log("initializing");
  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "openclaw-acp-client", version: "1.0.0" },
  });

  // 创建会话
  log("creating session");
  const session = await client.newSession({
    cwd,
    mcpServers: [],
  });

  // 返回客户端句柄
  return {
    client,
    agent,
    sessionId: session.sessionId,
  };
}

/**
 * 运行交互式ACP客户端
 * @param opts - 客户端配置选项
 * @returns Promise<void>
 * 
 * 功能：
 * 1. 创建客户端连接
 * 2. 提供交互式命令行界面
 * 3. 处理用户输入和Agent响应
 * 4. 支持exit/quit命令退出
 */
export async function runAcpClientInteractive(opts: AcpClientOptions = {}): Promise<void> {
  // 创建客户端
  const { client, agent, sessionId } = await createAcpClient(opts);

  // 创建readline接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 打印欢迎信息
  console.log("OpenClaw ACP client");
  console.log(`Session: ${sessionId}`);
  console.log('Type a prompt, or "exit" to quit.\n');

  // 定义提示函数
  const prompt = () => {
    rl.question("> ", async (input) => {
      const text = input.trim();
      // 空输入继续提示
      if (!text) {
        prompt();
        return;
      }
      // 处理退出命令
      if (text === "exit" || text === "quit") {
        agent.kill();
        rl.close();
        process.exit(0);
      }

      // 发送提示到Agent
      try {
        const response = await client.prompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });
        console.log(`\n[${response.stopReason}]\n`);
      } catch (err) {
        console.error(`\n[error] ${String(err)}\n`);
      }

      // 继续提示
      prompt();
    });
  };

  // 开始提示循环
  prompt();

  // 处理Agent退出
  agent.on("exit", (code) => {
    console.log(`\nAgent exited with code ${code ?? 0}`);
    rl.close();
    process.exit(code ?? 0);
  });
}
