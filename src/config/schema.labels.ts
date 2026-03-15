// 本文件是一个聚合模块，它的主要职责是收集并合并所有配置字段的
// “UI 标签（UI Labels）”。
//
// “标签”是在用户界面（例如，一个网页表单或设置页面）中，显示在输入框
// 旁边的、人类可读的文本。
//
// 这个文件从更具体的模块（如 `media-audio-field-metadata.js` 和 `schema.irc.js`）
// 导入它们的标签字典，然后将它们与一个巨大的、包含了大部分核心配置标签的
// `FIELD_LABELS` 字典合并。
//
// 这种结构的好处是：
// - **集中管理**: 大多数通用标签都在一个地方，易于查找和修改。
// - **模块化**: 特定领域（如 IRC）的标签可以被封装在其自己的模块中，保持了代码的组织性。
// - **可扩展性**: 添加新的配置领域时，只需创建相应的标签模块并在此处合并即可。

import { MEDIA_AUDIO_FIELD_LABELS } from "./media-audio-field-metadata.js";
import { IRC_FIELD_LABELS } from "./schema.irc.js";

/**
 * 一个巨大的字典（Record），将点分表示法的配置路径映射到它们在 UI 中应显示的标签。
 * 例如，`"gateway.port"` 键对应的值是 `"Gateway Port"`。
 */
export const FIELD_LABELS: Record<string, string> = {
  // --- 元数据 ---
  meta: "元数据",
  "meta.lastTouchedVersion": "配置最后接触版本",
  "meta.lastTouchedAt": "配置最后接触时间",

  // --- 环境 ---
  env: "环境",
  "env.shellEnv": "Shell 环境导入",
  "env.shellEnv.enabled": "启用 Shell 环境导入",
  "env.shellEnv.timeoutMs": "Shell 环境导入超时 (毫秒)",
  "env.vars": "环境变量覆盖",

  // --- 设置向导 ---
  wizard: "设置向导状态",
  "wizard.lastRunAt": "向导最后运行时间戳",
  // ...

  // --- 诊断 ---
  diagnostics: "诊断",
  "diagnostics.otel": "OpenTelemetry",
  // ...

  // --- 日志 ---
  logging: "日志",
  "logging.level": "日志级别",
  // ...

  // --- 命令行界面 ---
  cli: "命令行界面",
  // ...

  // --- 更新 ---
  update: "更新",
  "update.channel": "更新通道",
  // ...

  // --- 代理 ---
  agents: "代理",
  "agents.defaults": "代理默认值",
  // ...
  "agents.list.*.identity.avatar": "身份头像",
  "agents.list.*.skills": "代理技能过滤器",


  // --- 网关 ---
  gateway: "网关",
  "gateway.port": "网关端口",
  // ...
  "gateway.auth.token": "网关令牌",
  "gateway.auth.password": "网关密码",

  // --- 浏览器 ---
  browser: "浏览器",
  "browser.enabled": "启用浏览器",
  // ...

  // --- 工具 ---
  tools: "工具",
  "tools.allow": "工具白名单",
  // ...

  // --- 合并其他模块的标签 ---
  // 使用展开语法 (...) 将从其他模块导入的标签字典合并到主字典中。
  ...MEDIA_AUDIO_FIELD_LABELS,
  ...IRC_FIELD_LABELS,

  // ... 更多其他配置的标签 ...
};
