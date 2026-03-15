/**
 * ACP可用命令定义
 * 
 * 功能概述：
 * 定义了所有在ACP客户端中可用的命令及其描述
 * 这些命令用于控制会话、配置和交互行为
 * 
 * 命令分类：
 * 1. 帮助和信息类：help, commands, status, whoami/id
 * 2. 会话管理类：reset/new, stop, restart, compact
 * 3. 配置控制类：config, debug, model, queue
 * 4. 输出控制类：verbose, reasoning, think, usage
 * 5. 权限控制类：elevated, activation, send
 * 6. 集成类：dock-telegram, dock-discord, dock-slack
 * 7. 工具类：context, subagents, bash
 */

import type { AvailableCommand } from "@agentclientprotocol/sdk";
// 从ACP SDK导入AvailableCommand类型定义

/**
 * 获取所有可用的命令列表
 * 
 * @returns AvailableCommand[] 可用命令数组
 * 
 * 返回的命令包括：
 * - help: 显示帮助信息和常用命令
 * - commands: 列出所有可用命令
 * - status: 显示当前状态
 * - context: 解释上下文用法（支持list/detail/json三种模式）
 * - whoami/id: 显示发送者ID
 * - subagents: 列出或管理子代理
 * - config: 读取或写入配置（仅所有者）
 * - debug: 设置运行时覆盖项（仅所有者）
 * - usage: 切换使用信息页脚（off/tokens/full）
 * - stop: 停止当前运行
 * - restart: 重启网关（如果启用）
 * - dock-telegram: 将回复路由到Telegram
 * - dock-discord: 将回复路由到Discord
 * - dock-slack: 将回复路由到Slack
 * - activation: 设置群组激活模式（mention/always）
 * - send: 设置发送模式（on/off/inherit）
 * - reset/new: 重置会话
 * - think: 设置思考级别（off/minimal/low/medium/high/xhigh）
 * - verbose: 设置详细模式（on/full/off）
 * - reasoning: 切换推理输出（on/off/stream）
 * - elevated: 切换提升模式（on/off）
 * - model: 选择模型（list/status/<name>）
 * - queue: 调整队列模式和选项
 * - bash: 运行主机命令（如果启用）
 * - compact: 压缩会话历史
 */
export function getAvailableCommands(): AvailableCommand[] {
  // 返回所有可用命令的配置数组
  return [
    // 帮助和信息命令
    { name: "help", description: "Show help and common commands." },
    { name: "commands", description: "List available commands." },
    { name: "status", description: "Show current status." },
    
    // 上下文命令，支持输入提示
    {
      name: "context",
      description: "Explain context usage (list|detail|json).",
      input: { hint: "list | detail | json" },
    },
    
    // 身份识别命令（id是whoami的别名）
    { name: "whoami", description: "Show sender id (alias: /id)." },
    { name: "id", description: "Alias for /whoami." },
    
    // 子代理管理
    { name: "subagents", description: "List or manage sub-agents." },
    
    // 配置管理命令（仅所有者）
    { name: "config", description: "Read or write config (owner-only)." },
    { name: "debug", description: "Set runtime-only overrides (owner-only)." },
    
    // 使用信息显示
    { name: "usage", description: "Toggle usage footer (off|tokens|full)." },
    
    // 运行控制命令
    { name: "stop", description: "Stop the current run." },
    { name: "restart", description: "Restart the gateway (if enabled)." },
    
    // 第三方平台集成
    { name: "dock-telegram", description: "Route replies to Telegram." },
    { name: "dock-discord", description: "Route replies to Discord." },
    { name: "dock-slack", description: "Route replies to Slack." },
    
    // 权限和发送控制
    { name: "activation", description: "Set group activation (mention|always)." },
    { name: "send", description: "Set send mode (on|off|inherit)." },
    
    // 会话管理命令（new和reset互为别名）
    { name: "reset", description: "Reset the session (/new)." },
    { name: "new", description: "Reset the session (/reset)." },
    
    // 思考级别控制
    {
      name: "think",
      description: "Set thinking level (off|minimal|low|medium|high|xhigh).",
    },
    
    // 输出控制命令
    { name: "verbose", description: "Set verbose mode (on|full|off)." },
    { name: "reasoning", description: "Toggle reasoning output (on|off|stream)." },
    { name: "elevated", description: "Toggle elevated mode (on|off)." },
    
    // 模型选择和队列管理
    { name: "model", description: "Select a model (list|status|<name>)." },
    { name: "queue", description: "Adjust queue mode and options." },
    
    // 系统工具
    { name: "bash", description: "Run a host command (if enabled)." },
    { name: "compact", description: "Compact the session history." },
  ];
}
