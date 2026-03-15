// 本文件提供了一个通用的、高级的客户端，用于向网关（Gateway）发起 API 调用。
// 它的设计目标是封装所有与连接、认证和授权相关的复杂性，使得应用的其他部分
// (例如 CLI 命令、其他后端服务) 可以用一种简单、统一的方式与网关通信。
//
// **核心流程**:
// 1. **解析上下文**: `resolveGatewayCallContext` 从函数选项和环境中收集所有相关信息。
// 2. **解析连接细节**: `buildGatewayConnectionDetails` 确定最终要连接的 URL，
//    其优先级为：命令行覆盖 > 环境变量 > 远程配置 > 本地回环。
//    **包含一个关键安全检查**，以阻止向非本地的 `ws://` (不安全) 地址发送凭据。
// 3. **解析凭据**: `resolveGatewayCredentials` 负责获取 `token` 或 `password`。
//    这是一个复杂的过程，因为它需要处理可能存储为“秘密引用（SecretRef）”的凭据，
//    并可能需要异步地从外部源（如文件、密钥库）解析它们。
// 4. **执行请求**: `executeGatewayRequestWithScopes` 创建一个 `GatewayClient` 实例，
//    建立 WebSocket 连接，处理 TLS 指纹验证，等待 `hello` 握手成功，
//    然后发送实际的 API 请求。它还管理着超时和连接关闭的逻辑。

import { randomUUID } from "node:crypto";
// ... 其他导入 ...
import {
  GatewaySecretRefUnavailableError,
  resolveGatewayCredentialsFromConfig,
  trimToUndefined,
  // ...
} from "./credentials.js";
import {
  CLI_DEFAULT_OPERATOR_SCOPES,
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "./method-scopes.js";
import { isSecureWebSocketUrl } from "./net.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";


// --- 类型定义 ---

/**
 * 调用网关的基础选项。
 */
type CallGatewayBaseOptions = {
  url?: string; // 显式指定的网关 URL
  token?: string; // 显式指定的认证令牌
  password?: string; // 显式指定的认证密码
  tlsFingerprint?: string; // 用于 TLS Pinning 的指纹
  config?: OpenClawConfig; // （可选）一个预加载的配置对象
  method: string; // 要调用的方法名
  params?: unknown; // 方法的参数
  // ... 其他选项 ...
};

// ... 其他选项类型 ...


/**
 * 描述网关连接的详细信息。
 */
export type GatewayConnectionDetails = {
  url: string;       // 最终解析出的 URL
  urlSource: string; // URL 的来源 (例如 "cli --url", "config gateway.remote.url")
  message: string;   // 一条用于日志记录的、包含所有细节的汇总消息
  // ...
};

// ...

/**
 * 【主函数】根据提供的选项，调用网关的一个方法。
 * 这是一个顶层分发函数，它会根据调用者的上下文选择合适的授权范围（scopes）。
 * @param opts - 调用选项。
 * @returns 一个 Promise，解析为 API 调用的结果。
 */
export async function callGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  // 如果明确提供了 scopes，则使用它们
  if (Array.isArray(opts.scopes)) {
    return await callGatewayWithScopes(opts, opts.scopes);
  }
  // 根据客户端类型选择默认的 scopes
  const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
  const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
  if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) {
    return await callGatewayCli(opts);
  }
  // 默认情况下，使用“最小权限”原则来确定 scopes
  return await callGatewayLeastPrivilege({
    ...opts,
    mode: callerMode,
    clientName: callerName,
  });
}

/**
 * `callGateway` 的一个变体，总是使用最小权限原则来确定 scopes。
 */
export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method);
  return await callGatewayWithScopes(opts, scopes);
}

/**
 * 包含了核心调用流程的内部函数。
 */
async function callGatewayWithScopes<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[],
): Promise<T> {
  // 1. 解析超时设置
  const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
  
  // 2. 解析所有上下文信息
  const context = resolveGatewayCallContext(opts);
  
  // 3. 解析并验证凭据
  const resolvedCredentials = await resolveGatewayCredentials(context);
  // 【安全检查】如果用户通过 `--url` 覆盖了 URL，则必须明确提供凭据，
  // 以防止隐式地将凭据发送到可能不受信任的地址。
  ensureExplicitGatewayAuth({ /* ... */ });
  // 确保在远程模式下，URL 已被配置
  ensureRemoteModeUrlConfigured(context);
  
  // 4. 构建最终的连接细节（包括 URL）
  const connectionDetails = buildGatewayConnectionDetails({ /* ... */ });
  const url = connectionDetails.url;

  // 5. 解析 TLS 指纹
  const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
  const { token, password } = resolvedCredentials;

  // 6. 执行实际的请求
  return await executeGatewayRequestWithScopes<T>({
    opts,
    scopes,
    url,
    token,
    password,
    tlsFingerprint,
    timeoutMs,
    safeTimerTimeoutMs,
    connectionDetails,
  });
}

/**
 * 执行 WebSocket 请求的函数。
 */
async function executeGatewayRequestWithScopes<T>(params: { /* ... */ }): Promise<T> {
  const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs, connectionDetails } = params;
  
  return await new Promise<T>((resolve, reject) => {
    // 设置超时计时器
    const timer = setTimeout(() => { /* ... reject on timeout ... */ }, safeTimerTimeoutMs);

    // 创建一个新的 GatewayClient 实例
    const client = new GatewayClient({
      url,
      token,
      password,
      tlsFingerprint,
      // ... 其他客户端信息 ...
      scopes, // 传入授权范围
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      
      // 【关键回调】当 WebSocket 连接并成功完成 `hello` 握手后被调用
      onHelloOk: async (hello) => {
        try {
          // 检查远程网关是否支持此调用所需的所有方法
          ensureGatewaySupportsRequiredMethods({ /* ... */ });
          // 发送实际的 RPC 请求
          const result = await client.request<T>(opts.method, opts.params, { /* ... */ });
          // 成功后，停止计时器并解析 Promise
          stop(undefined, result);
          client.stop();
        } catch (err) {
          // ... 错误处理 ...
        }
      },
      // 当连接意外关闭时被调用
      onClose: (code, reason) => {
        // ... 构造错误并 reject Promise ...
      },
    });

    // 启动客户端连接
    client.start();
  });
}


/**
 * 【核心凭据解析】一个非常复杂的函数，用于解析出最终的凭据。
 * 它能够处理凭据被定义为“秘密引用（SecretRef）”的情况。
 * 如果一个凭据是秘密引用，它会异步地从其来源（如文件、密钥库）获取真实值。
 * 它甚至可以处理一个秘密的解析需要另一个秘密的情况。
 */
async function resolveGatewayCredentialsFromConfigWithSecretInputs(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  // 1. 首先尝试通过一个“预判”逻辑（`gatewaySecretInputPathCanWin`），找出在当前配置下
  //    “最有可能”被使用的那个秘密引用。
  let resolvedConfig = await resolvePreferredGatewaySecretInputs({ /* ... */ });

  // 2. 然后在一个循环中，尝试使用 `resolveGatewayCredentialsFromConfig` 来解析凭据。
  for (;;) {
    try {
      return resolveGatewayCredentialsFromConfig(/* ... */);
    } catch (error) {
      // 3. 如果解析失败是因为一个秘密引用不可用 (`GatewaySecretRefUnavailableError`)，
      //    它会捕获这个错误，尝试去异步地加载这个缺失的秘密，然后*重试*整个解析过程。
      if (!(error instanceof GatewaySecretRefUnavailableError)) {
        throw error;
      }
      const resolvedValue = await resolveConfiguredGatewaySecretInput({ /* ... */ });
      // 将解析出的真实值写回临时的配置对象中
      assignResolvedGatewaySecretInput({ config: resolvedConfig, path, value: resolvedValue });
      // ... 然后循环会继续，再次尝试解析 ...
    }
  }
}
