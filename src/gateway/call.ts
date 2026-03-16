// 导入Node.js的加密模块，用于生成唯一标识符
import { randomUUID } from "node:crypto";
// 导入配置类型定义
import type { OpenClawConfig } from "../config/config.js";
// 导入配置相关的工具函数
import {
  loadConfig, // 加载配置文件
  resolveConfigPath, // 解析配置文件路径
  resolveGatewayPort, // 解析网关端口号
  resolveStateDir, // 解析状态目录路径
} from "../config/config.js";
// 导入密钥引用解析函数
import { resolveSecretInputRef } from "../config/types.secrets.js";
// 导入设备身份管理函数
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
// 导入TLS运行时加载函数
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
// 导入密钥字符串解析函数
import { resolveSecretInputString } from "../secrets/resolve-secret-input-string.js";
// 导入网关客户端模式和名称常量
import {
  GATEWAY_CLIENT_MODES, // 网关客户端模式枚举
  GATEWAY_CLIENT_NAMES, // 网关客户端名称枚举
  type GatewayClientMode, // 网关客户端模式类型
  type GatewayClientName, // 网关客户端名称类型
} from "../utils/message-channel.js";
// 导入版本号
import { VERSION } from "../version.js";
// 导入网关客户端类
import { GatewayClient } from "./client.js";
// 导入网关凭证相关函数和类型
import {
  GatewaySecretRefUnavailableError, // 密钥引用不可用错误
  resolveGatewayCredentialsFromConfig, // 从配置解析网关凭证
  trimToUndefined, // 去除空白字符，空值转为undefined
  type GatewayCredentialMode, // 网关凭证模式类型
  type GatewayCredentialPrecedence, // 网关凭证优先级类型
  type GatewayRemoteCredentialFallback, // 远程网关凭证回退类型
  type GatewayRemoteCredentialPrecedence, // 远程网关凭证优先级类型
} from "./credentials.js";
// 导入操作员作用域相关函数和类型
import {
  CLI_DEFAULT_OPERATOR_SCOPES, // CLI默认操作员作用域
  resolveLeastPrivilegeOperatorScopesForMethod, // 根据方法解析最小权限操作员作用域
  type OperatorScope, // 操作员作用域类型
} from "./method-scopes.js";
// 导入WebSocket URL安全检查函数
import { isSecureWebSocketUrl } from "./net.js";
// 导入协议版本号
import { PROTOCOL_VERSION } from "./protocol/index.js";

/**
 * 调用网关的基础选项类型
 * 这是所有网关调用选项的通用部分
 */
type CallGatewayBaseOptions = {
  url?: string; // 网关URL，可选
  token?: string; // 认证令牌，可选
  password?: string; // 认证密码，可选
  tlsFingerprint?: string; // TLS证书指纹，用于验证服务器身份，可选
  config?: OpenClawConfig; // 配置对象，可选
  method: string; // 要调用的方法名，必填
  params?: unknown; // 方法参数，可选
  expectFinal?: boolean; // 是否期望最终响应，可选
  timeoutMs?: number; // 超时时间（毫秒），可选
  clientName?: GatewayClientName; // 客户端名称，可选
  clientDisplayName?: string; // 客户端显示名称，可选
  clientVersion?: string; // 客户端版本，可选
  platform?: string; // 平台标识，可选
  mode?: GatewayClientMode; // 客户端模式，可选
  instanceId?: string; // 实例ID，可选
  minProtocol?: number; // 最低协议版本，可选
  maxProtocol?: number; // 最高协议版本，可选
  requiredMethods?: string[]; // 要求网关支持的方法列表，可选
  /**
   * 覆盖连接错误详情中显示的配置路径
   * 不影响配置加载；调用者仍然通过 opts.token/password/env/config 控制认证
   */
  configPath?: string; // 配置文件路径，可选
};

/**
 * 带作用域的网关调用选项类型
 * 继承基础选项，并要求提供操作员作用域数组
 */
export type CallGatewayScopedOptions = CallGatewayBaseOptions & {
  scopes: OperatorScope[]; // 操作员作用域数组，必填
};

/**
 * CLI网关调用选项类型
 * 继承基础选项，作用域为可选
 */
export type CallGatewayCliOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[]; // 操作员作用域数组，可选
};

/**
 * 通用网关调用选项类型
 * 继承基础选项，作用域为可选
 */
export type CallGatewayOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[]; // 操作员作用域数组，可选
};

/**
 * 网关连接详情类型
 * 包含连接的完整信息和诊断消息
 */
export type GatewayConnectionDetails = {
  url: string; // 最终使用的网关URL
  urlSource: string; // URL来源（如"cli --url"、"env OPENCLAW_GATEWAY_URL"等）
  bindDetail?: string; // 绑定详情（如"Bind: loopback"），可选
  remoteFallbackNote?: string; // 远程回退提示信息，可选
  message: string; // 完整的连接信息消息
};

/**
 * 判断是否应该为网关调用附加设备身份
 *
 * 设备身份用于标识调用者的身份，在以下情况下会附加：
 * 1. 没有提供token或password（使用设备身份作为认证方式）
 * 2. 连接到非本地地址（远程连接需要设备身份）
 *
 * @param params - 参数对象
 * @param params.url - 网关URL
 * @param params.token - 认证令牌，可选
 * @param params.password - 认证密码，可选
 * @returns 如果应该附加设备身份则返回true，否则返回false
 */
function shouldAttachDeviceIdentityForGatewayCall(params: {
  url: string; // 网关URL
  token?: string; // 认证令牌，可选
  password?: string; // 认证密码，可选
}): boolean {
  // 如果没有提供token或password，需要使用设备身份进行认证
  if (!(params.token || params.password)) {
    return true;
  }
  try {
    // 解析URL获取主机名
    const parsed = new URL(params.url);
    // 如果不是本地地址（127.0.0.1、::1或localhost），需要设备身份
    return !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
  } catch {
    // URL解析失败，保守起见返回true
    return true;
  }
}

export type ExplicitGatewayAuth = {
  token?: string;
  password?: string;
};

/**
 * 解析并处理显式网关认证选项，确保token和password格式正确
 * @param opts - 可选的显式网关认证选项对象，包含token和password属性
 * @returns 返回处理后的显式网关认证对象，只包含有效的token和password
 */
export function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth {
  // 检查并处理token参数，如果存在且为非空字符串则去除前后空格，否则设为undefined
  const token =
    typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
  // 检查并处理password参数，如果存在且为非空字符串则去除前后空格，否则设为undefined
  const password =
    typeof opts?.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined;
  // 返回包含处理后的token和password的对象
  return { token, password };
}

export function ensureExplicitGatewayAuth(params: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  explicitAuth?: ExplicitGatewayAuth;
  resolvedAuth?: ExplicitGatewayAuth;
  errorHint: string;
  configPath?: string;
}): void {
  if (!params.urlOverride) {
    return;
  }
  // URL overrides are untrusted redirects and can move WebSocket traffic off the intended host.
  // Never allow an override to silently reuse implicit credentials or device token fallback.
  const explicitToken = params.explicitAuth?.token;
  const explicitPassword = params.explicitAuth?.password;
  if (params.urlOverrideSource === "cli" && (explicitToken || explicitPassword)) {
    return;
  }
  const hasResolvedAuth =
    params.resolvedAuth?.token ||
    params.resolvedAuth?.password ||
    explicitToken ||
    explicitPassword;
  // Env overrides are supported for deployment ergonomics, but only when explicit auth is available.
  // This avoids implicit device-token fallback against attacker-controlled WSS endpoints.
  if (params.urlOverrideSource === "env" && hasResolvedAuth) {
    return;
  }
  const message = [
    "gateway url override requires explicit credentials",
    params.errorHint,
    params.configPath ? `Config: ${params.configPath}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(message);
}

export function buildGatewayConnectionDetails(
  options: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
  } = {},
): GatewayConnectionDetails {
  const config = options.config ?? loadConfig();
  const configPath =
    options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const tlsEnabled = config.gateway?.tls?.enabled === true;
  const localPort = resolveGatewayPort(config);
  const bindMode = config.gateway?.bind ?? "loopback";
  const scheme = tlsEnabled ? "wss" : "ws";
  // Self-connections should always target loopback; bind mode only controls listener exposure.
  const localUrl = `${scheme}://127.0.0.1:${localPort}`;
  const cliUrlOverride =
    typeof options.url === "string" && options.url.trim().length > 0
      ? options.url.trim()
      : undefined;
  const envUrlOverride = cliUrlOverride
    ? undefined
    : (trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ??
      trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL));
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const remoteUrl =
    typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : undefined;
  const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
  const urlSourceHint =
    options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined);
  const url = urlOverride || remoteUrl || localUrl;
  const urlSource = urlOverride
    ? urlSourceHint === "env"
      ? "env OPENCLAW_GATEWAY_URL"
      : "cli --url"
    : remoteUrl
      ? "config gateway.remote.url"
      : remoteMisconfigured
        ? "missing gateway.remote.url (fallback local)"
        : "local loopback";
  const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : undefined;
  const remoteFallbackNote = remoteMisconfigured
    ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local."
    : undefined;

  const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
  // Security check: block ALL insecure ws:// to non-loopback addresses (CWE-319, CVSS 9.8)
  // This applies to the FINAL resolved URL, regardless of source (config, CLI override, etc).
  // Both credentials and chat/conversation data must not be transmitted over plaintext to remote hosts.
  if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
    throw new Error(
      [
        `SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
        "Both credentials and chat data would be exposed to network interception.",
        `Source: ${urlSource}`,
        `Config: ${configPath}`,
        "Fix: Use wss:// for remote gateway URLs.",
        "Safe remote access defaults:",
        "- keep gateway.bind=loopback and use an SSH tunnel (ssh -N -L 18789:127.0.0.1:18789 user@gateway-host)",
        "- or use Tailscale Serve/Funnel for HTTPS remote access",
        allowPrivateWs
          ? undefined
          : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
        "Doctor: openclaw doctor --fix",
        "Docs: https://docs.openclaw.ai/gateway/remote",
      ].join("\n"),
    );
  }

  const message = [
    `Gateway target: ${url}`,
    `Source: ${urlSource}`,
    `Config: ${configPath}`,
    bindDetail,
    remoteFallbackNote,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    url,
    urlSource,
    bindDetail,
    remoteFallbackNote,
    message,
  };
}

type GatewayRemoteSettings = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type ResolvedGatewayCallContext = {
  config: OpenClawConfig;
  configPath: string;
  isRemoteMode: boolean;
  remote?: GatewayRemoteSettings;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  remoteUrl?: string;
  explicitAuth: ExplicitGatewayAuth;
  modeOverride?: GatewayCredentialMode;
  includeLegacyEnv?: boolean;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
};

function resolveGatewayCallTimeout(timeoutValue: unknown): {
  timeoutMs: number;
  safeTimerTimeoutMs: number;
} {
  const timeoutMs =
    typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : 10_000;
  const safeTimerTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
  return { timeoutMs, safeTimerTimeoutMs };
}

/**
 * 解析网关调用上下文函数
 * @param opts 网关调用基础选项
 * @returns 返回解析后的网关调用上下文
 */
function resolveGatewayCallContext(opts: CallGatewayBaseOptions): ResolvedGatewayCallContext {
  // 获取配置，如果未提供则加载默认配置
  const config = opts.config ?? loadConfig();
  // 解析配置文件路径，如果未提供则通过环境变量和状态目录解析
  const configPath =
    opts.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
  // 检查是否为远程模式
  const isRemoteMode = config.gateway?.mode === "remote";
  // 如果是远程模式，则获取远程设置，否则为undefined
  const remote = isRemoteMode
    ? (config.gateway?.remote as GatewayRemoteSettings | undefined)
    : undefined;
  // 处理CLI提供的URL覆盖
  const cliUrlOverride = trimToUndefined(opts.url);
  // 处理环境变量提供的URL覆盖，仅在CLI未提供时使用
  const envUrlOverride = cliUrlOverride
    ? undefined
    : (trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ??
      trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL));
  // 确定最终的URL覆盖，优先使用CLI提供的
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  // 确定URL覆盖的来源（CLI或环境变量）
  const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined;
  // 获取远程URL配置
  const remoteUrl = trimToUndefined(remote?.url);
  // 解析显式认证信息（token或密码）
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  // 返回解析后的上下文对象
  return {
    config,
    configPath,
    isRemoteMode,
    remote,
    urlOverride,
    urlOverrideSource,
    remoteUrl,
    explicitAuth,
  };
}

function ensureRemoteModeUrlConfigured(context: ResolvedGatewayCallContext): void {
  if (!context.isRemoteMode || context.urlOverride || context.remoteUrl) {
    return;
  }
  throw new Error(
    [
      "gateway remote mode misconfigured: gateway.remote.url missing",
      `Config: ${context.configPath}`,
      "Fix: set gateway.remote.url, or set gateway.mode=local.",
    ].join("\n"),
  );
}

async function resolveGatewaySecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const value = await resolveSecretInputString({
    config: params.config,
    value: params.value,
    env: params.env,
    normalize: trimToUndefined,
    onResolveRefError: (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${params.path} secret reference could not be resolved: ${detail}`, {
        cause: error,
      });
    },
  });
  if (!value) {
    throw new Error(`${params.path} resolved to an empty or non-string value.`);
  }
  return value;
}

async function resolveGatewayCredentials(context: ResolvedGatewayCallContext): Promise<{
  token?: string;
  password?: string;
}> {
  return resolveGatewayCredentialsWithEnv(context, process.env);
}

async function resolveGatewayCredentialsWithEnv(
  context: ResolvedGatewayCallContext,
  env: NodeJS.ProcessEnv,
): Promise<{
  token?: string;
  password?: string;
}> {
  if (context.explicitAuth.token || context.explicitAuth.password) {
    return {
      token: context.explicitAuth.token,
      password: context.explicitAuth.password,
    };
  }
  return resolveGatewayCredentialsFromConfigWithSecretInputs({ context, env });
}

type SupportedGatewaySecretInputPath =
  | "gateway.auth.token"
  | "gateway.auth.password"
  | "gateway.remote.token"
  | "gateway.remote.password";

const ALL_GATEWAY_SECRET_INPUT_PATHS: SupportedGatewaySecretInputPath[] = [
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
];

function isSupportedGatewaySecretInputPath(path: string): path is SupportedGatewaySecretInputPath {
  return (
    path === "gateway.auth.token" ||
    path === "gateway.auth.password" ||
    path === "gateway.remote.token" ||
    path === "gateway.remote.password"
  );
}

function readGatewaySecretInputValue(
  config: OpenClawConfig,
  path: SupportedGatewaySecretInputPath,
): unknown {
  if (path === "gateway.auth.token") {
    return config.gateway?.auth?.token;
  }
  if (path === "gateway.auth.password") {
    return config.gateway?.auth?.password;
  }
  if (path === "gateway.remote.token") {
    return config.gateway?.remote?.token;
  }
  return config.gateway?.remote?.password;
}

function hasConfiguredGatewaySecretRef(
  config: OpenClawConfig,
  path: SupportedGatewaySecretInputPath,
): boolean {
  return Boolean(
    resolveSecretInputRef({
      value: readGatewaySecretInputValue(config, path),
      defaults: config.secrets?.defaults,
    }).ref,
  );
}

function resolveGatewayCredentialsFromConfigOptions(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}) {
  const { context, env, cfg } = params;
  return {
    cfg,
    env,
    explicitAuth: context.explicitAuth,
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    modeOverride: context.modeOverride,
    includeLegacyEnv: context.includeLegacyEnv,
    localTokenPrecedence: context.localTokenPrecedence,
    localPasswordPrecedence: context.localPasswordPrecedence,
    remoteTokenPrecedence: context.remoteTokenPrecedence,
    remotePasswordPrecedence: context.remotePasswordPrecedence ?? "env-first", // pragma: allowlist secret
    remoteTokenFallback: context.remoteTokenFallback,
    remotePasswordFallback: context.remotePasswordFallback,
  } as const;
}

function isTokenGatewaySecretInputPath(path: SupportedGatewaySecretInputPath): boolean {
  return path === "gateway.auth.token" || path === "gateway.remote.token";
}

function localAuthModeAllowsGatewaySecretInputPath(params: {
  authMode: string | undefined;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  const { authMode, path } = params;
  if (authMode === "none" || authMode === "trusted-proxy") {
    return false;
  }
  if (authMode === "token") {
    return isTokenGatewaySecretInputPath(path);
  }
  if (authMode === "password") {
    return !isTokenGatewaySecretInputPath(path);
  }
  return true;
}

function gatewaySecretInputPathCanWin(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
}): boolean {
  if (!hasConfiguredGatewaySecretRef(params.config, params.path)) {
    return false;
  }
  const mode: GatewayCredentialMode =
    params.context.modeOverride ?? (params.config.gateway?.mode === "remote" ? "remote" : "local");
  if (
    mode === "local" &&
    !localAuthModeAllowsGatewaySecretInputPath({
      authMode: params.config.gateway?.auth?.mode,
      path: params.path,
    })
  ) {
    return false;
  }
  const sentinel = `__OPENCLAW_GATEWAY_SECRET_REF_PROBE_${params.path.replaceAll(".", "_")}__`;
  const probeConfig = structuredClone(params.config);
  for (const candidatePath of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (!hasConfiguredGatewaySecretRef(probeConfig, candidatePath)) {
      continue;
    }
    assignResolvedGatewaySecretInput({
      config: probeConfig,
      path: candidatePath,
      value: undefined,
    });
  }
  assignResolvedGatewaySecretInput({
    config: probeConfig,
    path: params.path,
    value: sentinel,
  });
  try {
    const resolved = resolveGatewayCredentialsFromConfig(
      resolveGatewayCredentialsFromConfigOptions({
        context: params.context,
        env: params.env,
        cfg: probeConfig,
      }),
    );
    const tokenCanWin = resolved.token === sentinel && !resolved.password;
    const passwordCanWin = resolved.password === sentinel && !resolved.token;
    return tokenCanWin || passwordCanWin;
  } catch {
    return false;
  }
}

async function resolveConfiguredGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const { config, path, env } = params;
  if (path === "gateway.auth.token") {
    return resolveGatewaySecretInputString({
      config,
      value: config.gateway?.auth?.token,
      path,
      env,
    });
  }
  if (path === "gateway.auth.password") {
    return resolveGatewaySecretInputString({
      config,
      value: config.gateway?.auth?.password,
      path,
      env,
    });
  }
  if (path === "gateway.remote.token") {
    return resolveGatewaySecretInputString({
      config,
      value: config.gateway?.remote?.token,
      path,
      env,
    });
  }
  return resolveGatewaySecretInputString({
    config,
    value: config.gateway?.remote?.password,
    path,
    env,
  });
}

function assignResolvedGatewaySecretInput(params: {
  config: OpenClawConfig;
  path: SupportedGatewaySecretInputPath;
  value: string | undefined;
}): void {
  const { config, path, value } = params;
  if (path === "gateway.auth.token") {
    if (config.gateway?.auth) {
      config.gateway.auth.token = value;
    }
    return;
  }
  if (path === "gateway.auth.password") {
    if (config.gateway?.auth) {
      config.gateway.auth.password = value;
    }
    return;
  }
  if (path === "gateway.remote.token") {
    if (config.gateway?.remote) {
      config.gateway.remote.token = value;
    }
    return;
  }
  if (config.gateway?.remote) {
    config.gateway.remote.password = value;
  }
}

async function resolvePreferredGatewaySecretInputs(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
}): Promise<OpenClawConfig> {
  let nextConfig = params.config;
  for (const path of ALL_GATEWAY_SECRET_INPUT_PATHS) {
    if (
      !gatewaySecretInputPathCanWin({
        context: params.context,
        env: params.env,
        config: nextConfig,
        path,
      })
    ) {
      continue;
    }
    if (nextConfig === params.config) {
      nextConfig = structuredClone(params.config);
    }
    try {
      const resolvedValue = await resolveConfiguredGatewaySecretInput({
        config: nextConfig,
        path,
        env: params.env,
      });
      assignResolvedGatewaySecretInput({
        config: nextConfig,
        path,
        value: resolvedValue,
      });
    } catch {
      // Keep scanning candidate paths so unresolved higher-priority refs do not
      // prevent valid fallback refs from being considered.
      continue;
    }
  }
  return nextConfig;
}

async function resolveGatewayCredentialsFromConfigWithSecretInputs(params: {
  context: ResolvedGatewayCallContext;
  env: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  let resolvedConfig = await resolvePreferredGatewaySecretInputs({
    context: params.context,
    env: params.env,
    config: params.context.config,
  });
  const resolvedPaths = new Set<SupportedGatewaySecretInputPath>();
  for (;;) {
    try {
      return resolveGatewayCredentialsFromConfig(
        resolveGatewayCredentialsFromConfigOptions({
          context: params.context,
          env: params.env,
          cfg: resolvedConfig,
        }),
      );
    } catch (error) {
      if (!(error instanceof GatewaySecretRefUnavailableError)) {
        throw error;
      }
      const path = error.path;
      if (!isSupportedGatewaySecretInputPath(path) || resolvedPaths.has(path)) {
        throw error;
      }
      if (resolvedConfig === params.context.config) {
        resolvedConfig = structuredClone(params.context.config);
      }
      const resolvedValue = await resolveConfiguredGatewaySecretInput({
        config: resolvedConfig,
        path,
        env: params.env,
      });
      assignResolvedGatewaySecretInput({
        config: resolvedConfig,
        path,
        value: resolvedValue,
      });
      resolvedPaths.add(path);
    }
  }
}

export async function resolveGatewayCredentialsWithSecretInputs(params: {
  config: OpenClawConfig;
  explicitAuth?: ExplicitGatewayAuth;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  env?: NodeJS.ProcessEnv;
  modeOverride?: GatewayCredentialMode;
  includeLegacyEnv?: boolean;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
}): Promise<{ token?: string; password?: string }> {
  const modeOverride = params.modeOverride;
  const isRemoteMode = modeOverride
    ? modeOverride === "remote"
    : params.config.gateway?.mode === "remote";
  const remoteFromConfig =
    params.config.gateway?.mode === "remote"
      ? (params.config.gateway?.remote as GatewayRemoteSettings | undefined)
      : undefined;
  const remoteFromOverride =
    modeOverride === "remote"
      ? (params.config.gateway?.remote as GatewayRemoteSettings | undefined)
      : undefined;
  const context: ResolvedGatewayCallContext = {
    config: params.config,
    configPath: resolveConfigPath(process.env, resolveStateDir(process.env)),
    isRemoteMode,
    remote: remoteFromOverride ?? remoteFromConfig,
    urlOverride: trimToUndefined(params.urlOverride),
    urlOverrideSource: params.urlOverrideSource,
    remoteUrl: isRemoteMode
      ? trimToUndefined((params.config.gateway?.remote as GatewayRemoteSettings | undefined)?.url)
      : undefined,
    explicitAuth: resolveExplicitGatewayAuth(params.explicitAuth),
    modeOverride,
    includeLegacyEnv: params.includeLegacyEnv,
    localTokenPrecedence: params.localTokenPrecedence,
    localPasswordPrecedence: params.localPasswordPrecedence,
    remoteTokenPrecedence: params.remoteTokenPrecedence,
    remotePasswordPrecedence: params.remotePasswordPrecedence,
    remoteTokenFallback: params.remoteTokenFallback,
    remotePasswordFallback: params.remotePasswordFallback,
  };
  return resolveGatewayCredentialsWithEnv(context, params.env ?? process.env);
}

async function resolveGatewayTlsFingerprint(params: {
  opts: CallGatewayBaseOptions;
  context: ResolvedGatewayCallContext;
  url: string;
}): Promise<string | undefined> {
  const { opts, context, url } = params;
  const useLocalTls =
    context.config.gateway?.tls?.enabled === true &&
    !context.urlOverrideSource &&
    !context.remoteUrl &&
    url.startsWith("wss://");
  const tlsRuntime = useLocalTls
    ? await loadGatewayTlsRuntime(context.config.gateway?.tls)
    : undefined;
  const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
  const remoteTlsFingerprint =
    // Env overrides may still inherit configured remote TLS pinning for private cert deployments.
    // CLI overrides remain explicit-only and intentionally skip config remote TLS to avoid
    // accidentally pinning against caller-supplied target URLs.
    context.isRemoteMode && context.urlOverrideSource !== "cli"
      ? trimToUndefined(context.remote?.tlsFingerprint)
      : undefined;
  return (
    overrideTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined)
  );
}

function formatGatewayCloseError(
  code: number,
  reason: string,
  connectionDetails: GatewayConnectionDetails,
): string {
  const reasonText = reason?.trim() || "no close reason";
  const hint =
    code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
  const suffix = hint ? ` ${hint}` : "";
  return `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
}

function formatGatewayTimeoutError(
  timeoutMs: number,
  connectionDetails: GatewayConnectionDetails,
): string {
  return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}

function ensureGatewaySupportsRequiredMethods(params: {
  requiredMethods: string[] | undefined;
  methods: string[] | undefined;
  attemptedMethod: string;
}): void {
  const requiredMethods = Array.isArray(params.requiredMethods)
    ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  if (requiredMethods.length === 0) {
    return;
  }
  const supportedMethods = new Set(
    (Array.isArray(params.methods) ? params.methods : [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const method of requiredMethods) {
    if (supportedMethods.has(method)) {
      continue;
    }
    throw new Error(
      [
        `active gateway does not support required method "${method}" for "${params.attemptedMethod}".`,
        "Update the gateway or run without SecretRefs.",
      ].join(" "),
    );
  }
}

/**
 * 使用指定的作用域执行网关请求
 * @param params - 包含请求所需的所有参数
 * @returns 返回一个Promise，解析为类型T的结果
 */
async function executeGatewayRequestWithScopes<T>(params: {
  opts: CallGatewayBaseOptions; // 网关调用的基本选项
  scopes: OperatorScope[]; // 操作员作用域数组
  url: string; // 网关URL
  token?: string; // 可选的认证令牌
  password?: string; // 可选的密码
  tlsFingerprint?: string; // 可选的TLS指纹
  timeoutMs: number; // 超时时间（毫秒）
  safeTimerTimeoutMs: number; // 安全计时器超时时间（毫秒）
  connectionDetails: GatewayConnectionDetails; // 网关连接详情
}): Promise<T> {
  // 从参数中解构所需变量
  const { opts, scopes, url, token, password, tlsFingerprint, timeoutMs, safeTimerTimeoutMs } =
    params;
  // 返回一个新的Promise，用于处理异步操作
  return await new Promise<T>((resolve, reject) => {
    let settled = false; // 标记Promise是否已解决
    let ignoreClose = false; // 标记是否忽略关闭事件
    // 停止函数，用于处理结果或错误
    const stop = (err?: Error, value?: T) => {
      if (settled) {
        // 如果已经解决，则直接返回
        return;
      }
      settled = true; // 标记为已解决
      clearTimeout(timer); // 清除定时器
      if (err) {
        // 如果有错误，则拒绝Promise
        reject(err);
      } else {
        // 否则解析Promise
        resolve(value as T);
      }
    };

    // 创建新的网关客户端实例
    const client = new GatewayClient({
      url, // 网关URL
      token, // 认证令牌
      password, // 密码
      tlsFingerprint, // TLS指纹
      instanceId: opts.instanceId ?? randomUUID(), // 实例ID，如果未提供则生成随机UUID
      clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI, // 客户端名称
      clientDisplayName: opts.clientDisplayName, // 客户端显示名称
      clientVersion: opts.clientVersion ?? VERSION, // 客户端版本
      platform: opts.platform, // 平台信息
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI, // 客户端模式
      role: "operator", // 角色
      scopes, // 作用域
      // 根据条件决定是否附加设备身份
      deviceIdentity: shouldAttachDeviceIdentityForGatewayCall({ url, token, password })
        ? loadOrCreateDeviceIdentity()
        : undefined,
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION, // 最小协议版本
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION, // 最大协议版本
      // 连接成功时的回调函数
      onHelloOk: async (hello) => {
        try {
          // 确保网关支持所需的方法
          ensureGatewaySupportsRequiredMethods({
            requiredMethods: opts.requiredMethods,
            methods: hello.features?.methods,
            attemptedMethod: opts.method,
          });
          // 发送请求并获取结果
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
          });
          ignoreClose = true; // 标记忽略关闭事件
          stop(undefined, result); // 停止并返回结果
          client.stop(); // 停止客户端
        } catch (err) {
          ignoreClose = true; // 标记忽略关闭事件
          client.stop(); // 停止客户端
          stop(err as Error); // 停止并返回错误
        }
      },
      // 连接关闭时的回调函数
      onClose: (code, reason) => {
        if (settled || ignoreClose) {
          // 如果已解决或忽略关闭，则直接返回
          return;
        }
        ignoreClose = true; // 标记忽略关闭事件
        client.stop(); // 停止客户端
        // 创建并返回错误信息
        stop(new Error(formatGatewayCloseError(code, reason, params.connectionDetails)));
      },
    });

    // 设置超时定时器
    const timer = setTimeout(() => {
      ignoreClose = true; // 标记忽略关闭事件
      client.stop();
      // 创建并返回超时错误
      stop(new Error(formatGatewayTimeoutError(timeoutMs, params.connectionDetails)));
    }, safeTimerTimeoutMs);

    client.start();
  });
}

async function callGatewayWithScopes<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[],
): Promise<T> {
  const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(opts.timeoutMs);
  const context = resolveGatewayCallContext(opts);
  const resolvedCredentials = await resolveGatewayCredentials(context);
  ensureExplicitGatewayAuth({
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    explicitAuth: context.explicitAuth,
    resolvedAuth: resolvedCredentials,
    errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
    configPath: context.configPath,
  });
  ensureRemoteModeUrlConfigured(context);
  const connectionDetails = buildGatewayConnectionDetails({
    config: context.config,
    url: context.urlOverride,
    urlSource: context.urlOverrideSource,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const url = connectionDetails.url;
  const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
  const { token, password } = resolvedCredentials;
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

export async function callGatewayScoped<T = Record<string, unknown>>(
  opts: CallGatewayScopedOptions,
): Promise<T> {
  return await callGatewayWithScopes(opts, opts.scopes);
}

/**
 * 调用网关CLI接口的异步函数
 *
 * 此函数用于向OpenClaw网关发起CLI类型的API调用。如果提供的选项中未指定作用域(scopes)，
 * 则会使用默认的CLI操作员作用域(CLI_DEFAULT_OPERATOR_SCOPES)，该作用域包括管理员、
 * 读取、写入、审批和配对权限。
 *
 * @template T - 返回数据的类型，默认为Record<string, unknown>
 * @param {CallGatewayCliOptions} opts - CLI网关调用的选项配置
 * @returns {Promise<T>} 返回一个Promise，解析为指定类型的响应数据
 */
export async function callGatewayCli<T = Record<string, unknown>>(
  opts: CallGatewayCliOptions,
): Promise<T> {
  const scopes = Array.isArray(opts.scopes) ? opts.scopes : CLI_DEFAULT_OPERATOR_SCOPES;
  return await callGatewayWithScopes(opts, scopes);
}

/**
 * 使用最小权限原则调用网关
 * @param opts 调用网关的基础选项
 * @returns 返回Promise，解析为类型T的数据
 */
export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions, // 网关调用的基础配置选项
): Promise<T> {
  // 返回Promise，解析为泛型T类型，默认为Record<string, unknown>
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method); // 根据请求方法解析最小权限范围
  return await callGatewayWithScopes(opts, scopes); // 使用解析后的权限范围调用网关
}

/**
 * 调用网关的通用函数，支持泛型返回类型
 * @param opts 调用网关的选项参数
 * @returns 返回Promise，解析为类型T的数据
 */
export async function callGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  // 检查是否提供了scopes数组，如果有则使用带scopes的方式调用网关
  if (Array.isArray(opts.scopes)) {
    return await callGatewayWithScopes(opts, opts.scopes);
  }
  // 设置调用模式，默认为后端模式
  const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
  // 设置调用者名称，默认为GATEWAY_CLIENT
  const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
  // 如果是CLI模式或调用者是CLI，则使用CLI方式调用网关
  if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) {
    return await callGatewayCli(opts);
  }
  // 否则使用最小权限方式调用网关，并传递模式和客户端名称
  return await callGatewayLeastPrivilege({
    ...opts,
    mode: callerMode,
    clientName: callerName,
  });
}

/**
 * 生成一个幂等性密钥
 * 幂等性密钥通常用于确保请求的唯一性，防止重复执行
 * @returns 返回一个UUID格式的随机字符串作为幂等性密钥
 */
export function randomIdempotencyKey() {
  // 使用UUID生成器创建一个随机密钥
  return randomUUID();
}
