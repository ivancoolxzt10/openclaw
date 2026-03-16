// 导入Node.js的加密模块，用于生成唯一标识符
import crypto from "node:crypto";
// 导入调用网关的函数，用于与后端服务通信
import { callGateway } from "../../gateway/call.js";
// 导入内部消息通道常量，用于指定消息传递的渠道
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
// 导入Agent通道常量，用于指定Agent运行在哪个通道
import { AGENT_LANE_NESTED } from "../lanes.js";
// 导入辅助函数，用于提取助手文本和过滤工具消息
import { extractAssistantText, stripToolMessages } from "./sessions-helpers.js";

/**
 * 读取最新的助手回复
 *
 * 这个函数用于从会话历史中获取最新的助手（AI）回复。
 * 它会过滤掉工具消息，只保留实际的对话内容。
 *
 * @param params - 参数对象
 * @param params.sessionKey - 会话的唯一标识符，用于定位特定会话
 * @param params.limit - 可选，限制读取的历史消息数量，默认为50条
 * @returns 返回最新的助手回复文本，如果没有找到则返回undefined
 *
 * 使用示例：
 * ```typescript
 * const reply = await readLatestAssistantReply({
 *   sessionKey: "session-123",
 *   limit: 100
 * });
 * console.log(reply); // 输出助手的最新回复
 * ```
 */
export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
}): Promise<string | undefined> {
  // 调用网关获取会话历史记录
  const history = await callGateway<{ messages: Array<unknown> }>({
    method: "chat.history",
    // 传入会话ID和消息数量限制（如果未指定limit，则默认使用50）
    params: { sessionKey: params.sessionKey, limit: params.limit ?? 50 },
  });
  // 过滤掉工具消息，只保留实际对话消息
  // stripToolMessages函数会移除系统工具调用相关的消息
  const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  // 从后往前遍历消息列表，因为最新的消息在最后
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const candidate = filtered[i];
    // 跳过无效的消息（空值或非对象）
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    // 跳过非助手角色的消息（比如用户消息、系统消息等）
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    // 从助手消息中提取文本内容
    const text = extractAssistantText(candidate);
    // 如果文本为空或只有空白字符，跳过
    if (!text?.trim()) {
      continue;
    }
    // 找到有效的助手回复，返回文本
    return text;
  }
  // 遍历完所有消息都没有找到有效的助手回复，返回undefined
  return undefined;
}

/**
 * 执行Agent步骤
 *
 * 这个函数用于执行一个Agent（智能代理）的处理步骤。
 * 它会创建一个Agent任务，等待任务完成，然后返回助手的回复。
 *
 * @param params - 参数对象
 * @param params.sessionKey - 会话的唯一标识符
 * @param params.message - 发送给Agent的消息内容
 * @param params.extraSystemPrompt - 额外的系统提示词，用于指导Agent的行为
 * @param params.timeoutMs - 超时时间（毫秒），指定最多等待多久
 * @param params.channel - 可选，消息通道，默认使用内部消息通道
 * @param params.lane - 可选，Agent运行通道，默认使用嵌套通道
 * @param params.sourceSessionKey - 可选，源会话ID，用于追踪消息来源
 * @param params.sourceChannel - 可选，源消息通道
 * @param params.sourceTool - 可选，源工具名称，默认为"sessions_send"
 * @returns 返回助手的回复文本，如果超时或失败则返回undefined
 *
 * 使用示例：
 * ```typescript
 * const result = await runAgentStep({
 *   sessionKey: "session-123",
 *   message: "帮我分析这段代码",
 *   extraSystemPrompt: "你是一个专业的代码分析助手",
 *   timeoutMs: 30000, // 等待30秒
 * });
 * console.log(result); // 输出Agent的分析结果
 * ```
 */
export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
}): Promise<string | undefined> {
  // 生成一个唯一的幂等性密钥，用于防止重复执行相同的任务
  const stepIdem = crypto.randomUUID();
  // 调用网关启动Agent任务
  const response = await callGateway<{ runId?: string }>({
    method: "agent",
    params: {
      // 发送给Agent的消息
      message: params.message,
      // 会话标识符
      sessionKey: params.sessionKey,
      // 幂等性密钥，确保相同请求只执行一次
      idempotencyKey: stepIdem,
      // deliver: false表示不立即发送消息，而是等待执行
      deliver: false,
      // 消息通道，如果未指定则使用内部消息通道
      channel: params.channel ?? INTERNAL_MESSAGE_CHANNEL,
      // Agent运行通道，如果未指定则使用嵌套通道
      lane: params.lane ?? AGENT_LANE_NESTED,
      // 额外的系统提示词
      extraSystemPrompt: params.extraSystemPrompt,
      // 输入来源信息，用于追踪消息的来源
      inputProvenance: {
        // 表示这是跨会话的调用
        kind: "inter_session",
        // 源会话ID
        sourceSessionKey: params.sourceSessionKey,
        // 源消息通道
        sourceChannel: params.sourceChannel,
        // 源工具名称，默认为"sessions_send"
        sourceTool: params.sourceTool ?? "sessions_send",
      },
    },
    // 网关调用超时时间为10秒
    timeoutMs: 10_000,
  });

  // 从响应中提取运行ID，如果没有则使用空字符串
  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  // 确定最终使用的运行ID，优先使用响应中的runId，如果没有则使用之前生成的stepIdem
  const resolvedRunId = stepRunId || stepIdem;
  // 计算等待时间，取用户指定的超时时间和60秒中的较小值
  const stepWaitMs = Math.min(params.timeoutMs, 60_000);
  // 调用网关等待Agent任务完成
  const wait = await callGateway<{ status?: string }>({
    method: "agent.wait",
    params: {
      // 使用确定的运行ID
      runId: resolvedRunId,
      // 等待超时时间
      timeoutMs: stepWaitMs,
    },
    // 网关调用超时时间比等待时间多2秒，确保能收到响应
    timeoutMs: stepWaitMs + 2000,
  });
  // 检查等待结果，如果状态不是"ok"则返回undefined
  if (wait?.status !== "ok") {
    return undefined;
  }
  // 任务成功完成，读取并返回最新的助手回复
  return await readLatestAssistantReply({ sessionKey: params.sessionKey });
}
