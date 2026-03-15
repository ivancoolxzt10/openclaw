/**
 * ACP网关Agent实现
 * 
 * 功能概述：
 * 实现ACP协议与OpenClaw网关之间的协议转换
 * 
 * 主要功能：
 * 1. 处理ACP协议请求（认证、初始化、提示等）
 * 2. 管理会话生命周期
 * 3. 转换网关事件为ACP通知
 * 4. 管理工具调用
 * 5. 处理会话配置
 * 
 * 架构：
 * - AcpGatewayAgent类实现Agent接口
 * - 使用AgentSideConnection处理ACP协议
 * - 使用GatewayClient与网关通信
 */

import { randomUUID } from "node:crypto";
// 导入UUID生成函数

import os from "node:os";
// 导入操作系统模块

import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
// 从ACP SDK导入类型定义

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
// 导入协议版本常量

import { listThinkingLevels } from "../auto-reply/thinking.js";
// 导入思考级别列表

import type { GatewayClient } from "../gateway/client.js";
// 导入网关客户端类型

import type { EventFrame } from "../gateway/protocol/index.js";
// 导入事件帧类型

import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.js";
// 导入网关会话类型

import {
  createFixedWindowRateLimiter,
  type FixedWindowRateLimiter,
} from "../infra/fixed-window-rate-limit.js";
// 导入固定窗口速率限制器

import { shortenHomePath } from "../utils.js";
// 导入路径缩短工具

import { getAvailableCommands } from "./commands.js";
// 导入可用命令列表

import {
  extractAttachmentsFromPrompt,
  extractToolCallContent,
  extractToolCallLocations,
  extractTextFromPrompt,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
// 导入事件映射工具

import { readBool, readNumber, readString } from "./meta.js";
// 导入元数据读取工具

import { parseSessionMeta, resetSessionIfNeeded, resolveSessionKey } from "./session-mapper.js";
// 导入会话映射工具

import { defaultAcpSessionStore, type AcpSessionStore } from "./session.js";
// 导入会话存储

import { ACP_AGENT_INFO, type AcpServerOptions } from "./types.js";
// 导入服务器选项类型

// 最大允许的提示大小（2MB），防止通过内存耗尽进行DoS攻击（CWE-400, GHSA-cxpw-2g23-2vgw）
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

// ACP配置ID常量
const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level"; // 思考级别
const ACP_FAST_MODE_CONFIG_ID = "fast_mode"; // 快速模式
const ACP_VERBOSE_LEVEL_CONFIG_ID = "verbose_level"; // 详细级别
const ACP_REASONING_LEVEL_CONFIG_ID = "reasoning_level"; // 推理级别
const ACP_RESPONSE_USAGE_CONFIG_ID = "response_usage"; // 响应使用信息
const ACP_ELEVATED_LEVEL_CONFIG_ID = "elevated_level"; // 提升级别

// 加载会话时的重放限制（100万条消息）
const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;

/**
 * 待处理的提示
 * 存储等待网关响应的提示信息
 */
type PendingPrompt = {
  sessionId: string; // 会话ID
  sessionKey: string; // 会话密钥
  idempotencyKey: string; // 幂等性键
  resolve: (response: PromptResponse) => void; // 解析函数
  reject: (err: Error) => void; // 拒绝函数
  sentTextLength?: number; // 已发送文本长度
  sentText?: string; // 已发送文本
  toolCalls?: Map<string, PendingToolCall>; // 工具调用映射
};

/**
 * 待处理的工具调用
 * 存储工具调用的相关信息
 */
type PendingToolCall = {
  kind: ToolKind; // 工具类型
  locations?: ToolCallLocation[]; // 工具调用位置
  rawInput?: Record<string, unknown>; // 原始输入
  title: string; // 工具标题
};

/**
 * ACP网关Agent选项
 * 扩展自AcpServerOptions，添加会话存储选项
 */
type AcpGatewayAgentOptions = AcpServerOptions & {
  sessionStore?: AcpSessionStore; // 自定义会话存储
};

/**
 * 网关会话展示行
 * 从GatewaySessionRow中选择用于展示的字段
 */
type GatewaySessionPresentationRow = Pick<
  GatewaySessionRow,
  | "displayName"
  | "label"
  | "derivedTitle"
  | "updatedAt"
  | "thinkingLevel"
  | "fastMode"
  | "modelProvider"
  | "model"
  | "verboseLevel"
  | "reasoningLevel"
  | "responseUsage"
  | "elevatedLevel"
  | "totalTokens"
  | "totalTokensFresh"
  | "contextTokens"
>;

/**
 * 会话展示信息
 * 包含配置选项和模式状态
 */
type SessionPresentation = {
  configOptions: SessionConfigOption[]; // 配置选项列表
  modes: SessionModeState; // 模式状态
};

/**
 * 会话元数据
 */
type SessionMetadata = {
  title?: string | null; // 会话标题
  updatedAt?: string | null; // 更新时间
};

/**
 * 会话使用快照
 */
type SessionUsageSnapshot = {
  size: number; // 总大小
  used: number; // 已使用量
};

/**
 * 会话快照
 * 包含展示信息、元数据和使用情况
 */
type SessionSnapshot = SessionPresentation & {
  metadata?: SessionMetadata; // 元数据
  usage?: SessionUsageSnapshot; // 使用情况
};

/**
 * 网关转录消息
 */
type GatewayTranscriptMessage = {
  role?: unknown; // 角色
  content?: unknown; // 内容
};

// 会话创建速率限制默认值
const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120; // 最大请求数
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000; // 时间窗口（毫秒）

/**
 * 格式化思考级别名称
 * @param level - 思考级别
 * @returns 格式化后的名称
 */
function formatThinkingLevelName(level: string): string {
  switch (level) {
    case "xhigh":
      return "Extra High";
    case "adaptive":
      return "Adaptive";
    default:
      // 首字母大写，其余保持不变
      return level.length > 0 ? `${level[0].toUpperCase()}${level.slice(1)}` : "Unknown";
  }
}

/**
 * 构建思考模式描述
 * @param level - 思考级别
 * @returns 描述文本，非adaptive级别返回undefined
 */
function buildThinkingModeDescription(level: string): string | undefined {
  if (level === "adaptive") {
    return "Use the Gateway session default thought level.";
  }
  return undefined;
}

/**
 * 格式化配置值名称
 * @param value - 配置值
 * @returns 格式化后的名称
 */
function formatConfigValueName(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    default:
      // 首字母大写，其余保持不变
      return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : "Unknown";
  }
}

/**
 * 构建选择配置选项
 * @param params - 配置参数
 * @returns 会话配置选项
 */
function buildSelectConfigOption(params: {
  id: string; // 配置ID
  name: string; // 配置名称
  description: string; // 配置描述
  currentValue: string; // 当前值
  values: readonly string[]; // 可选值列表
  category?: string; // 配置类别
}): SessionConfigOption {
  return {
    type: "select", // 选择类型
    id: params.id,
    name: params.name,
    category: params.category,
    description: params.description,
    currentValue: params.currentValue,
    options: params.values.map((value) => ({
      value,
      name: formatConfigValueName(value), // 格式化选项名称
    })),
  };
}

/**
 * 构建会话展示信息
 * @param params - 构建参数
 * @returns 会话展示信息
 */
function buildSessionPresentation(params: {
  row?: GatewaySessionPresentationRow; // 网关会话行
  overrides?: Partial<GatewaySessionPresentationRow>; // 覆盖值
}): SessionPresentation {
  // 合并行数据和覆盖值
  const row = {
    ...params.row,
    ...params.overrides,
  };
  // 获取可用的思考级别列表
  const availableLevelIds: string[] = [...listThinkingLevels(row.modelProvider, row.model)];
  // 获取当前模式ID，默认为adaptive
  const currentModeId = row.thinkingLevel?.trim() || "adaptive";
  // 如果当前模式不在可用列表中，添加它
  if (!availableLevelIds.includes(currentModeId)) {
    availableLevelIds.push(currentModeId);
  }

  // 构建模式状态
  const modes: SessionModeState = {
    currentModeId,
    availableModes: availableLevelIds.map((level) => ({
      id: level,
      name: formatThinkingLevelName(level), // 格式化级别名称
      description: buildThinkingModeDescription(level), // 构建级别描述
    })),
  };

  // 构建配置选项列表
  const configOptions: SessionConfigOption[] = [
    // 思考级别配置
    buildSelectConfigOption({
      id: ACP_THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought level",
      category: "thought_level",
      description:
        "Controls how much deliberate reasoning OpenClaw requests from the Gateway model.",
      currentValue: currentModeId,
      values: availableLevelIds,
    }),
    // 快速模式配置
    buildSelectConfigOption({
      id: ACP_FAST_MODE_CONFIG_ID,
      name: "Fast mode",
      description: "Controls whether OpenAI sessions use the Gateway fast-mode profile.",
      currentValue: row.fastMode ? "on" : "off",
      values: ["off", "on"],
    }),
    // 工具详细度配置
    buildSelectConfigOption({
      id: ACP_VERBOSE_LEVEL_CONFIG_ID,
      name: "Tool verbosity",
      description:
        "Controls how much tool progress and output detail OpenClaw keeps enabled for the session.",
      currentValue: row.verboseLevel?.trim() || "off",
      values: ["off", "on", "full"],
    }),
    // 推理流配置
    buildSelectConfigOption({
      id: ACP_REASONING_LEVEL_CONFIG_ID,
      name: "Reasoning stream",
      description: "Controls whether reasoning-capable models emit reasoning text for the session.",
      currentValue: row.reasoningLevel?.trim() || "off",
      values: ["off", "on", "stream"],
    }),
    // 使用信息配置
    buildSelectConfigOption({
      id: ACP_RESPONSE_USAGE_CONFIG_ID,
      name: "Usage detail",
      description:
        "Controls how much usage information OpenClaw attaches to responses for the session.",
      currentValue: row.responseUsage?.trim() || "off",
      values: ["off", "tokens", "full"],
    }),
    // 提升操作配置
    buildSelectConfigOption({
      id: ACP_ELEVATED_LEVEL_CONFIG_ID,
      name: "Elevated actions",
      description: "Controls how aggressively the session allows elevated execution behavior.",
      currentValue: row.elevatedLevel?.trim() || "off",
      values: ["off", "on", "ask", "full"],
    }),
  ];

  return { configOptions, modes };
}

function extractReplayText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return "";
      }
      const typedBlock = block as { type?: unknown; text?: unknown };
      return typedBlock.type === "text" && typeof typedBlock.text === "string"
        ? typedBlock.text
        : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function buildSessionMetadata(params: {
  row?: GatewaySessionPresentationRow;
  sessionKey: string;
}): SessionMetadata {
  const title =
    params.row?.derivedTitle?.trim() ||
    params.row?.displayName?.trim() ||
    params.row?.label?.trim() ||
    params.sessionKey;
  const updatedAt =
    typeof params.row?.updatedAt === "number" && Number.isFinite(params.row.updatedAt)
      ? new Date(params.row.updatedAt).toISOString()
      : null;
  return { title, updatedAt };
}

function buildSessionUsageSnapshot(
  row?: GatewaySessionPresentationRow,
): SessionUsageSnapshot | undefined {
  const totalTokens = row?.totalTokens;
  const contextTokens = row?.contextTokens;
  if (
    row?.totalTokensFresh !== true ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens) ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return undefined;
  }
  const size = Math.max(0, Math.floor(contextTokens));
  const used = Math.max(0, Math.min(Math.floor(totalTokens), size));
  return { size, used };
}

function buildSystemInputProvenance(originSessionId: string) {
  return {
    kind: "external_user" as const,
    originSessionId,
    sourceChannel: "acp",
    sourceTool: "openclaw_acp",
  };
}

function buildSystemProvenanceReceipt(params: {
  cwd: string;
  sessionId: string;
  sessionKey: string;
}) {
  return [
    "[Source Receipt]",
    "bridge=openclaw-acp",
    `originHost=${os.hostname()}`,
    `originCwd=${shortenHomePath(params.cwd)}`,
    `acpSessionId=${params.sessionId}`,
    `originSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}

export class AcpGatewayAgent implements Agent {
  private connection: AgentSideConnection;
  private gateway: GatewayClient;
  private opts: AcpGatewayAgentOptions;
  private log: (msg: string) => void;
  private sessionStore: AcpSessionStore;
  private sessionCreateRateLimiter: FixedWindowRateLimiter;
  private pendingPrompts = new Map<string, PendingPrompt>();

  constructor(
    connection: AgentSideConnection,
    gateway: GatewayClient,
    opts: AcpGatewayAgentOptions = {},
  ) {
    this.connection = connection;
    this.gateway = gateway;
    this.opts = opts;
    this.log = opts.verbose ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
    this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: Math.max(
        1,
        opts.sessionCreateRateLimit?.maxRequests ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
      ),
      windowMs: Math.max(
        1_000,
        opts.sessionCreateRateLimit?.windowMs ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
      ),
    });
  }

  start(): void {
    this.log("ready");
  }

  handleGatewayReconnect(): void {
    this.log("gateway reconnected");
  }

  handleGatewayDisconnect(reason: string): void {
    this.log(`gateway disconnected: ${reason}`);
    for (const pending of this.pendingPrompts.values()) {
      pending.reject(new Error(`Gateway disconnected: ${reason}`));
      this.sessionStore.clearActiveRun(pending.sessionId);
    }
    this.pendingPrompts.clear();
  }

  async handleGatewayEvent(evt: EventFrame): Promise<void> {
    if (evt.event === "chat") {
      await this.handleChatEvent(evt);
      return;
    }
    if (evt.event === "agent") {
      await this.handleAgentEvent(evt);
    }
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params._meta);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: `acp:${sessionId}`,
    });

    const session = this.sessionStore.createSession({
      sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey);
    await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: false,
    });
    await this.sendAvailableCommands(session.sessionId);
    const { configOptions, modes } = sessionSnapshot;
    return {
      sessionId: session.sessionId,
      configOptions,
      modes,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    if (!this.sessionStore.hasSession(params.sessionId)) {
      this.enforceSessionCreateRateLimit("loadSession");
    }

    const meta = parseSessionMeta(params._meta);
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: params.sessionId,
    });

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
    const [sessionSnapshot, transcript] = await Promise.all([
      this.getSessionSnapshot(session.sessionKey),
      this.getSessionTranscript(session.sessionKey).catch((err) => {
        this.log(`session transcript fallback for ${session.sessionKey}: ${String(err)}`);
        return [];
      }),
    ]);
    await this.replaySessionTranscript(session.sessionId, transcript);
    await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
      includeControls: false,
    });
    await this.sendAvailableCommands(session.sessionId);
    const { configOptions, modes } = sessionSnapshot;
    return { configOptions, modes };
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const limit = readNumber(params._meta, ["limit"]) ?? 100;
    const result = await this.gateway.request<SessionsListResult>("sessions.list", { limit });
    const cwd = params.cwd ?? process.cwd();
    return {
      sessions: result.sessions.map((session) => ({
        sessionId: session.key,
        cwd,
        title: session.displayName ?? session.label ?? session.key,
        updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : undefined,
        _meta: {
          sessionKey: session.key,
          kind: session.kind,
          channel: session.channel,
        },
      })),
      nextCursor: null,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    if (!params.modeId) {
      return {};
    }
    try {
      await this.gateway.request("sessions.patch", {
        key: session.sessionKey,
        thinkingLevel: params.modeId,
      });
      this.log(`setSessionMode: ${session.sessionId} -> ${params.modeId}`);
      const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, {
        thinkingLevel: params.modeId,
      });
      await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
        includeControls: true,
      });
    } catch (err) {
      this.log(`setSessionMode error: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }
    const sessionPatch = this.resolveSessionConfigPatch(params.configId, params.value);

    try {
      await this.gateway.request("sessions.patch", {
        key: session.sessionKey,
        ...sessionPatch.patch,
      });
      this.log(
        `setSessionConfigOption: ${session.sessionId} -> ${params.configId}=${params.value}`,
      );
      const sessionSnapshot = await this.getSessionSnapshot(
        session.sessionKey,
        sessionPatch.overrides,
      );
      await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, {
        includeControls: true,
      });
      return {
        configOptions: sessionSnapshot.configOptions,
      };
    } catch (err) {
      this.log(`setSessionConfigOption error: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    if (session.abortController) {
      this.sessionStore.cancelActiveRun(params.sessionId);
    }

    const meta = parseSessionMeta(params._meta);
    // Pass MAX_PROMPT_BYTES so extractTextFromPrompt rejects oversized content
    // block-by-block, before the full string is ever assembled in memory (CWE-400)
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const attachments = extractAttachmentsFromPrompt(params.prompt);
    const prefixCwd = meta.prefixCwd ?? this.opts.prefixCwd ?? true;
    const displayCwd = shortenHomePath(session.cwd);
    const message = prefixCwd ? `[Working directory: ${displayCwd}]\n\n${userText}` : userText;
    const provenanceMode = this.opts.provenanceMode ?? "off";
    const systemInputProvenance =
      provenanceMode === "off" ? undefined : buildSystemInputProvenance(params.sessionId);
    const systemProvenanceReceipt =
      provenanceMode === "meta+receipt"
        ? buildSystemProvenanceReceipt({
            cwd: session.cwd,
            sessionId: params.sessionId,
            sessionKey: session.sessionKey,
          })
        : undefined;

    // Defense-in-depth: also check the final assembled message (includes cwd prefix)
    if (Buffer.byteLength(message, "utf-8") > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }

    const abortController = new AbortController();
    const runId = randomUUID();
    this.sessionStore.setActiveRun(params.sessionId, runId, abortController);

    return new Promise<PromptResponse>((resolve, reject) => {
      this.pendingPrompts.set(params.sessionId, {
        sessionId: params.sessionId,
        sessionKey: session.sessionKey,
        idempotencyKey: runId,
        resolve,
        reject,
      });

      this.gateway
        .request(
          "chat.send",
          {
            sessionKey: session.sessionKey,
            message,
            attachments: attachments.length > 0 ? attachments : undefined,
            idempotencyKey: runId,
            thinking: readString(params._meta, ["thinking", "thinkingLevel"]),
            deliver: readBool(params._meta, ["deliver"]),
            timeoutMs: readNumber(params._meta, ["timeoutMs"]),
            systemInputProvenance,
            systemProvenanceReceipt,
          },
          { expectFinal: true },
        )
        .catch((err) => {
          this.pendingPrompts.delete(params.sessionId);
          this.sessionStore.clearActiveRun(params.sessionId);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessionStore.getSession(params.sessionId);
    if (!session) {
      return;
    }
    // Capture runId before cancelActiveRun clears session.activeRunId.
    const activeRunId = session.activeRunId;

    this.sessionStore.cancelActiveRun(params.sessionId);
    const pending = this.pendingPrompts.get(params.sessionId);
    const scopedRunId = activeRunId ?? pending?.idempotencyKey;
    if (!scopedRunId) {
      return;
    }

    try {
      await this.gateway.request("chat.abort", {
        sessionKey: session.sessionKey,
        runId: scopedRunId,
      });
    } catch (err) {
      this.log(`cancel error: ${String(err)}`);
    }

    if (pending) {
      this.pendingPrompts.delete(params.sessionId);
      pending.resolve({ stopReason: "cancelled" });
    }
  }

  private async resolveSessionKeyFromMeta(params: {
    meta: ReturnType<typeof parseSessionMeta>;
    fallbackKey: string;
  }): Promise<string> {
    const sessionKey = await resolveSessionKey({
      meta: params.meta,
      fallbackKey: params.fallbackKey,
      gateway: this.gateway,
      opts: this.opts,
    });
    await resetSessionIfNeeded({
      meta: params.meta,
      sessionKey,
      gateway: this.gateway,
      opts: this.opts,
    });
    return sessionKey;
  }

  private async handleAgentEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }
    const stream = payload.stream as string | undefined;
    const runId = payload.runId as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;
    const sessionKey = payload.sessionKey as string | undefined;
    if (!stream || !data || !sessionKey) {
      return;
    }

    if (stream !== "tool") {
      return;
    }
    const phase = data.phase as string | undefined;
    const name = data.name as string | undefined;
    const toolCallId = data.toolCallId as string | undefined;
    if (!toolCallId) {
      return;
    }

    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    if (phase === "start") {
      if (!pending.toolCalls) {
        pending.toolCalls = new Map();
      }
      if (pending.toolCalls.has(toolCallId)) {
        return;
      }
      const args = data.args as Record<string, unknown> | undefined;
      const title = formatToolTitle(name, args);
      const kind = inferToolKind(name);
      const locations = extractToolCallLocations(args);
      pending.toolCalls.set(toolCallId, {
        title,
        kind,
        rawInput: args,
        locations,
      });
      await this.connection.sessionUpdate({
        sessionId: pending.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          status: "in_progress",
          rawInput: args,
          kind,
          locations,
        },
      });
      return;
    }

    if (phase === "update") {
      const toolState = pending.toolCalls?.get(toolCallId);
      const partialResult = data.partialResult;
      await this.connection.sessionUpdate({
        sessionId: pending.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          rawOutput: partialResult,
          content: extractToolCallContent(partialResult),
          locations: extractToolCallLocations(toolState?.locations, partialResult),
        },
      });
      return;
    }

    if (phase === "result") {
      const isError = Boolean(data.isError);
      const toolState = pending.toolCalls?.get(toolCallId);
      pending.toolCalls?.delete(toolCallId);
      await this.connection.sessionUpdate({
        sessionId: pending.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          rawOutput: data.result,
          content: extractToolCallContent(data.result),
          locations: extractToolCallLocations(toolState?.locations, data.result),
        },
      });
    }
  }

  private async handleChatEvent(evt: EventFrame): Promise<void> {
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) {
      return;
    }

    const sessionKey = payload.sessionKey as string | undefined;
    const state = payload.state as string | undefined;
    const runId = payload.runId as string | undefined;
    const messageData = payload.message as Record<string, unknown> | undefined;
    if (!sessionKey || !state) {
      return;
    }

    const pending = this.findPendingBySessionKey(sessionKey, runId);
    if (!pending) {
      return;
    }

    const shouldHandleMessageSnapshot = messageData && (state === "delta" || state === "final");
    if (shouldHandleMessageSnapshot) {
      // Gateway chat events can carry the latest full assistant snapshot on both
      // incremental updates and the terminal final event. Process the snapshot
      // first so ACP clients never drop the last visible assistant text.
      await this.handleDeltaEvent(pending.sessionId, messageData);
      if (state === "delta") {
        return;
      }
    }

    if (state === "final") {
      const rawStopReason = payload.stopReason as string | undefined;
      const stopReason: StopReason = rawStopReason === "max_tokens" ? "max_tokens" : "end_turn";
      await this.finishPrompt(pending.sessionId, pending, stopReason);
      return;
    }
    if (state === "aborted") {
      await this.finishPrompt(pending.sessionId, pending, "cancelled");
      return;
    }
    if (state === "error") {
      // ACP has no explicit "server_error" stop reason.  Use "end_turn" so clients
      // do not treat transient backend errors (timeouts, rate-limits) as deliberate
      // refusals.  TODO: when ChatEventSchema gains a structured errorKind field
      // (e.g. "refusal" | "timeout" | "rate_limit"), use it to distinguish here.
      void this.finishPrompt(pending.sessionId, pending, "end_turn");
    }
  }

  private async handleDeltaEvent(
    sessionId: string,
    messageData: Record<string, unknown>,
  ): Promise<void> {
    const content = messageData.content as Array<{ type: string; text?: string }> | undefined;
    const fullText = content?.find((c) => c.type === "text")?.text ?? "";
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) {
      return;
    }

    const sentSoFar = pending.sentTextLength ?? 0;
    if (fullText.length <= sentSoFar) {
      return;
    }

    const newText = fullText.slice(sentSoFar);
    pending.sentTextLength = fullText.length;
    pending.sentText = fullText;

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: newText },
      },
    });
  }

  private async finishPrompt(
    sessionId: string,
    pending: PendingPrompt,
    stopReason: StopReason,
  ): Promise<void> {
    this.pendingPrompts.delete(sessionId);
    this.sessionStore.clearActiveRun(sessionId);
    const sessionSnapshot = await this.getSessionSnapshot(pending.sessionKey);
    try {
      await this.sendSessionSnapshotUpdate(sessionId, sessionSnapshot, {
        includeControls: false,
      });
    } catch (err) {
      this.log(`session snapshot update failed for ${sessionId}: ${String(err)}`);
    }
    pending.resolve({ stopReason });
  }

  private findPendingBySessionKey(sessionKey: string, runId?: string): PendingPrompt | undefined {
    for (const pending of this.pendingPrompts.values()) {
      if (pending.sessionKey !== sessionKey) {
        continue;
      }
      if (runId && pending.idempotencyKey !== runId) {
        continue;
      }
      return pending;
    }
    return undefined;
  }

  private async sendAvailableCommands(sessionId: string): Promise<void> {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableCommands(),
      },
    });
  }

  private async getSessionSnapshot(
    sessionKey: string,
    overrides?: Partial<GatewaySessionPresentationRow>,
  ): Promise<SessionSnapshot> {
    try {
      const row = await this.getGatewaySessionRow(sessionKey);
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    } catch (err) {
      this.log(`session presentation fallback for ${sessionKey}: ${String(err)}`);
      return {
        ...buildSessionPresentation({ overrides }),
        metadata: buildSessionMetadata({ sessionKey }),
      };
    }
  }

  private async getGatewaySessionRow(
    sessionKey: string,
  ): Promise<GatewaySessionPresentationRow | undefined> {
    const result = await this.gateway.request<SessionsListResult>("sessions.list", {
      limit: 200,
      search: sessionKey,
      includeDerivedTitles: true,
    });
    const session = result.sessions.find((entry) => entry.key === sessionKey);
    if (!session) {
      return undefined;
    }
    return {
      displayName: session.displayName,
      label: session.label,
      derivedTitle: session.derivedTitle,
      updatedAt: session.updatedAt,
      thinkingLevel: session.thinkingLevel,
      modelProvider: session.modelProvider,
      model: session.model,
      fastMode: session.fastMode,
      verboseLevel: session.verboseLevel,
      reasoningLevel: session.reasoningLevel,
      responseUsage: session.responseUsage,
      elevatedLevel: session.elevatedLevel,
      totalTokens: session.totalTokens,
      totalTokensFresh: session.totalTokensFresh,
      contextTokens: session.contextTokens,
    };
  }

  private resolveSessionConfigPatch(
    configId: string,
    value: string | boolean,
  ): {
    overrides: Partial<GatewaySessionPresentationRow>;
    patch: Record<string, string | boolean>;
  } {
    if (typeof value !== "string") {
      throw new Error(
        `ACP bridge does not support non-string session config option values for "${configId}".`,
      );
    }
    switch (configId) {
      case ACP_THOUGHT_LEVEL_CONFIG_ID:
        return {
          patch: { thinkingLevel: value },
          overrides: { thinkingLevel: value },
        };
      case ACP_FAST_MODE_CONFIG_ID:
        return {
          patch: { fastMode: value === "on" },
          overrides: { fastMode: value === "on" },
        };
      case ACP_VERBOSE_LEVEL_CONFIG_ID:
        return {
          patch: { verboseLevel: value },
          overrides: { verboseLevel: value },
        };
      case ACP_REASONING_LEVEL_CONFIG_ID:
        return {
          patch: { reasoningLevel: value },
          overrides: { reasoningLevel: value },
        };
      case ACP_RESPONSE_USAGE_CONFIG_ID:
        return {
          patch: { responseUsage: value },
          overrides: { responseUsage: value as GatewaySessionPresentationRow["responseUsage"] },
        };
      case ACP_ELEVATED_LEVEL_CONFIG_ID:
        return {
          patch: { elevatedLevel: value },
          overrides: { elevatedLevel: value },
        };
      default:
        throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
    }
  }

  private async getSessionTranscript(sessionKey: string): Promise<GatewayTranscriptMessage[]> {
    const result = await this.gateway.request<{ messages?: unknown[] }>("sessions.get", {
      key: sessionKey,
      limit: ACP_LOAD_SESSION_REPLAY_LIMIT,
    });
    if (!Array.isArray(result.messages)) {
      return [];
    }
    return result.messages as GatewayTranscriptMessage[];
  }

  private async replaySessionTranscript(
    sessionId: string,
    transcript: ReadonlyArray<GatewayTranscriptMessage>,
  ): Promise<void> {
    for (const message of transcript) {
      const role = typeof message.role === "string" ? message.role : "";
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      const text = extractReplayText(message.content);
      if (!text) {
        continue;
      }
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    }
  }

  private async sendSessionSnapshotUpdate(
    sessionId: string,
    sessionSnapshot: SessionSnapshot,
    options: { includeControls: boolean },
  ): Promise<void> {
    if (options.includeControls) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: sessionSnapshot.modes.currentModeId,
        },
      });
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: sessionSnapshot.configOptions,
        },
      });
    }
    if (sessionSnapshot.metadata) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          ...sessionSnapshot.metadata,
        },
      });
    }
    if (sessionSnapshot.usage) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: sessionSnapshot.usage.used,
          size: sessionSnapshot.usage.size,
          _meta: {
            source: "gateway-session-store",
            approximate: true,
          },
        },
      });
    }
  }

  private assertSupportedSessionSetup(mcpServers: ReadonlyArray<unknown>): void {
    if (mcpServers.length === 0) {
      return;
    }
    throw new Error(
      "ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead.",
    );
  }

  private enforceSessionCreateRateLimit(method: "newSession" | "loadSession"): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
    );
  }
}
