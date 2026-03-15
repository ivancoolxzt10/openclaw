#!/usr/bin/env node
// Node.js shebang，允许直接执行此文件

/**
 * ACP服务器实现
 * 
 * 功能概述：
 * 实现基于网关的ACP服务器，用于IDE集成
 * 
 * 主要功能：
 * 1. 启动并管理ACP服务器
 * 2. 处理命令行参数
 * 3. 连接到OpenClaw网关
 * 4. 管理会话生命周期
 * 5. 处理事件和错误
 * 
 * 架构：
 * - 使用AgentSideConnection处理ACP协议
 * - 通过GatewayClient连接到网关
 * - 使用AcpGatewayAgent进行协议转换
 */

import { Readable, Writable } from "node:stream";
// 导入Node.js流模块，用于处理标准输入输出

import { fileURLToPath } from "node:url";
// 导入URL转换工具，用于获取当前文件路径

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
// 从ACP SDK导入Agent端连接和NDJSON流处理工具

import { loadConfig } from "../config/config.js";
// 导入配置加载工具

import { buildGatewayConnectionDetails } from "../gateway/call.js";
// 导入网关连接详情构建工具

import { GatewayClient } from "../gateway/client.js";
// 导入网关客户端类

import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
// 导入网关认证解析工具

import { isMainModule } from "../infra/is-main.js";
// 导入主模块检测工具

import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
// 导入网关客户端模式和名称常量

import { readSecretFromFile } from "./secret-file.js";
// 导入从文件读取密钥的工具

import { AcpGatewayAgent } from "./translator.js";
// 导入ACP网关Agent实现

import { normalizeAcpProvenanceMode, type AcpServerOptions } from "./types.js";
// 导入来源模式规范化和服务器选项类型

export async function serveAcpGateway(opts: AcpServerOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const connection = buildGatewayConnectionDetails({
    config: cfg,
    url: opts.gatewayUrl,
  });
  const gatewayUrlOverrideSource =
    connection.urlSource === "cli --url"
      ? "cli"
      : connection.urlSource === "env OPENCLAW_GATEWAY_URL"
        ? "env"
        : undefined;
  const creds = await resolveGatewayConnectionAuth({
    config: cfg,
    explicitAuth: {
      token: opts.gatewayToken,
      password: opts.gatewayPassword,
    },
    env: process.env,
    urlOverride: gatewayUrlOverrideSource ? connection.url : undefined,
    urlOverrideSource: gatewayUrlOverrideSource,
  });

  // Agent实例，初始为null
  let agent: AcpGatewayAgent | null = null;
  // 服务器关闭时的回调函数
  let onClosed!: () => void;
  // 服务器关闭Promise，用于等待服务器完全关闭
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  // 停止标志，防止重复停止
  let stopped = false;
  // 网关就绪的Promise解析函数
  let onGatewayReadyResolve!: () => void;
  // 网关就绪的Promise拒绝函数
  let onGatewayReadyReject!: (err: Error) => void;
  // 网关就绪Promise是否已解决
  let gatewayReadySettled = false;
  // 网关就绪Promise，用于等待网关连接完成
  const gatewayReady = new Promise<void>((resolve, reject) => {
    onGatewayReadyResolve = resolve;
    onGatewayReadyReject = reject;
  });
  // 解析网关就绪Promise
  const resolveGatewayReady = () => {
    // 如果已经解决，直接返回
    if (gatewayReadySettled) {
      return;
    }
    // 标记为已解决
    gatewayReadySettled = true;
    // 调用解析函数
    onGatewayReadyResolve();
  };
  // 拒绝网关就绪Promise
  const rejectGatewayReady = (err: unknown) => {
    // 如果已经解决，直接返回
    if (gatewayReadySettled) {
      return;
    }
    // 标记为已解决
    gatewayReadySettled = true;
    // 调用拒绝函数，确保传入Error对象
    onGatewayReadyReject(err instanceof Error ? err : new Error(String(err)));
  };

  // 创建网关客户端实例
  const gateway = new GatewayClient({
    url: connection.url, // 网关URL
    token: creds.token, // 认证令牌
    password: creds.password, // 认证密码
    clientName: GATEWAY_CLIENT_NAMES.CLI, // 客户端名称
    clientDisplayName: "ACP", // 客户端显示名称
    clientVersion: "acp", // 客户端版本
    mode: GATEWAY_CLIENT_MODES.CLI, // 客户端模式
    // 事件处理器
    onEvent: (evt) => {
      // 将网关事件转发给Agent
      void agent?.handleGatewayEvent(evt);
    },
    // 连接成功回调
    onHelloOk: () => {
      // 解析网关就绪Promise
      resolveGatewayReady();
      // 通知Agent网关已重连
      agent?.handleGatewayReconnect();
    },
    // 连接错误回调
    onConnectError: (err) => {
      // 拒绝网关就绪Promise
      rejectGatewayReady(err);
    },
    // 连接关闭回调
    onClose: (code, reason) => {
      // 如果未停止，网关在就绪前关闭
      if (!stopped) {
        rejectGatewayReady(new Error(`gateway closed before ready (${code}): ${reason}`));
      }
      // 通知Agent网关已断开
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
      // 仅在有意关闭时解析（gateway.stop()会设置closed
      // 标志，跳过重连，然后触发onClose）。
      // 临时断开会自动尝试重连。
      if (stopped) {
        onClosed();
      }
    },
  });

  // 优雅关闭函数
  const shutdown = () => {
    // 如果已经停止，直接返回
    if (stopped) {
      return;
    }
    // 设置停止标志
    stopped = true;
    // 解析网关就绪Promise，防止等待
    resolveGatewayReady();
    // 停止网关客户端
    gateway.stop();
    // 如果没有活动的WebSocket（例如在重连尝试之间），
    // gateway.stop()不会触发onClose，所以直接解析。
    onClosed();
  };

  // 注册信号处理器，实现优雅关闭
  process.once("SIGINT", shutdown); // Ctrl+C
  process.once("SIGTERM", shutdown); // 终止信号

  // 先启动网关并等待hello完成，然后接受ACP请求。
  gateway.start();
  // 等待网关就绪，如果出错则关闭
  await gatewayReady.catch((err) => {
    shutdown();
    throw err;
  });
  // 如果已经停止，返回关闭Promise
  if (stopped) {
    return closed;
  }

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  new AgentSideConnection((conn: AgentSideConnection) => {
    agent = new AcpGatewayAgent(conn, gateway, opts);
    agent.start();
    return agent;
  }, stream);

  return closed;
}

/**
 * 解析命令行参数
 * 将命令行参数转换为AcpServerOptions对象
 * 
 * @param args - 命令行参数数组
 * @returns 解析后的服务器选项
 * 
 * 支持的参数：
 * --url, --gateway-url: 网关URL
 * --token, --gateway-token: 网关令牌
 * --token-file, --gateway-token-file: 从文件读取令牌
 * --password, --gateway-password: 网关密码
 * --password-file, --gateway-password-file: 从文件读取密码
 * --session: 默认会话密钥
 * --session-label: 默认会话标签
 * --require-existing: 要求已存在的会话
 * --reset-session: 重置会话
 * --no-prefix-cwd: 不添加工作目录前缀
 * --provenance: 来源追踪模式
 * --verbose, -v: 详细日志
 * --help, -h: 显示帮助
 */
function parseArgs(args: string[]): AcpServerOptions {
  // 初始化选项对象
  const opts: AcpServerOptions = {};
  // 令牌文件路径
  let tokenFile: string | undefined;
  // 密码文件路径
  let passwordFile: string | undefined;
  // 遍历所有参数
  for (let i = 0; i < args.length; i += 1) {
    // 获取当前参数
    const arg = args[i];
    // 处理网关URL参数
    if (arg === "--url" || arg === "--gateway-url") {
      opts.gatewayUrl = args[i + 1];
      i += 1;
      continue;
    }
    // 处理网关令牌参数
    if (arg === "--token" || arg === "--gateway-token") {
      opts.gatewayToken = args[i + 1];
      i += 1;
      continue;
    }
    // 处理令牌文件参数
    if (arg === "--token-file" || arg === "--gateway-token-file") {
      tokenFile = args[i + 1];
      i += 1;
      continue;
    }
    // 处理网关密码参数
    if (arg === "--password" || arg === "--gateway-password") {
      opts.gatewayPassword = args[i + 1];
      i += 1;
      continue;
    }
    // 处理密码文件参数
    if (arg === "--password-file" || arg === "--gateway-password-file") {
      passwordFile = args[i + 1];
      i += 1;
      continue;
    }
    // 处理会话密钥参数
    if (arg === "--session") {
      opts.defaultSessionKey = args[i + 1];
      i += 1;
      continue;
    }
    // 处理会话标签参数
    if (arg === "--session-label") {
      opts.defaultSessionLabel = args[i + 1];
      i += 1;
      continue;
    }
    // 处理要求已存在会话参数
    if (arg === "--require-existing") {
      opts.requireExistingSession = true;
      continue;
    }
    // 处理重置会话参数
    if (arg === "--reset-session") {
      opts.resetSession = true;
      continue;
    }
    // 处理不添加工作目录前缀参数
    if (arg === "--no-prefix-cwd") {
      opts.prefixCwd = false;
      continue;
    }
    // 处理来源追踪模式参数
    if (arg === "--provenance") {
      // 规范化来源模式
      const provenanceMode = normalizeAcpProvenanceMode(args[i + 1]);
      // 验证来源模式是否有效
      if (!provenanceMode) {
        throw new Error("Invalid --provenance value. Use off, meta, or meta+receipt.");
      }
      opts.provenanceMode = provenanceMode;
      i += 1;
      continue;
    }
    // 处理详细日志参数
    if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
      continue;
    }
    // 处理帮助参数
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  // 验证不能同时使用令牌和令牌文件
  if (opts.gatewayToken?.trim() && tokenFile?.trim()) {
    throw new Error("Use either --token or --token-file.");
  }
  // 验证不能同时使用密码和密码文件
  if (opts.gatewayPassword?.trim() && passwordFile?.trim()) {
    throw new Error("Use either --password or --password-file.");
  }
  // 如果指定了令牌文件，从文件读取令牌
  if (tokenFile?.trim()) {
    opts.gatewayToken = readSecretFromFile(tokenFile, "Gateway token");
  }
  // 如果指定了密码文件，从文件读取密码
  if (passwordFile?.trim()) {
    opts.gatewayPassword = readSecretFromFile(passwordFile, "Gateway password");
  }
  // 返回解析后的选项
  return opts;
}

/**
 * 打印帮助信息
 * 显示命令行用法和所有可用选项
 */
function printHelp(): void {
  console.log(`Usage: openclaw acp [options]

Gateway-backed ACP server for IDE integration.

Options:
  --url <url>             Gateway WebSocket URL
  --token <token>         Gateway auth token
  --token-file <path>     Read gateway auth token from file
  --password <password>   Gateway auth password
  --password-file <path>  Read gateway auth password from file
  --session <key>         Default session key (e.g. "agent:main:main")
  --session-label <label> Default session label to resolve
  --require-existing      Fail if the session key/label does not exist
  --reset-session         Reset the session key before first use
  --no-prefix-cwd         Do not prefix prompts with the working directory
  --provenance <mode>     ACP provenance mode: off, meta, or meta+receipt
  --verbose, -v           Verbose logging to stderr
  --help, -h              Show this help message
`);
}

// 主程序入口：检查是否为主模块
if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  // 获取命令行参数（跳过前两个：node和脚本路径）
  const argv = process.argv.slice(2);
  // 警告：令牌可能通过进程列表暴露
  if (argv.includes("--token") || argv.includes("--gateway-token")) {
    console.error(
      "Warning: --token can be exposed via process listings. Prefer --token-file or OPENCLAW_GATEWAY_TOKEN.",
    );
  }
  // 警告：密码可能通过进程列表暴露
  if (argv.includes("--password") || argv.includes("--gateway-password")) {
    console.error(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  }
  // 解析命令行参数
  const opts = parseArgs(argv);
  // 启动ACP网关服务器，处理错误
  serveAcpGateway(opts).catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
