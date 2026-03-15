// 本文件是一个纯粹的元数据模块，专门用于定义与 IRC (Internet Relay Chat) 渠道相关的配置字段的
// “UI 提示”。它不包含任何业务逻辑。
//
// 这种将 UI 文本（标签、帮助信息）与代码分离的做法，使得：
// - **本地化/国际化** 变得更容易。
// - **维护** 更简单，因为所有与 IRC 相关的 UI 文本都集中在此处。
// - **代码** 更干净，因为核心逻辑中不掺杂显示层的文本。

/**
 * 一个字典，为 IRC 配置的每个字段提供简短的、人类可读的标签。
 * 这些标签非常适合在图形用户界面（GUI）中作为输入字段的 `label`。
 */
export const IRC_FIELD_LABELS: Record<string, string> = {
  "channels.irc": "IRC",
  "channels.irc.dmPolicy": "IRC 私聊策略", // IRC DM Policy
  "channels.irc.nickserv.enabled": "启用 IRC NickServ", // IRC NickServ Enabled
  "channels.irc.nickserv.service": "IRC NickServ 服务", // IRC NickServ Service
  "channels.irc.nickserv.password": "IRC NickServ 密码", // IRC NickServ Password
  "channels.irc.nickserv.passwordFile": "IRC NickServ 密码文件", // IRC NickServ Password File
  "channels.irc.nickserv.register": "注册 IRC NickServ", // IRC NickServ Register
  "channels.irc.nickserv.registerEmail": "IRC NickServ 注册邮箱", // IRC NickServ Register Email
};

/**
 * 一个字典，为 IRC 配置的每个字段提供详细的帮助文本。
 * 这些描述旨在解释每个设置的用途、默认值以及如何使用它，
 * 可以在 UI 的工具提示（tooltip）或帮助文档中显示。
 */
export const IRC_FIELD_HELP: Record<string, string> = {
  "channels.irc.configWrites":
    "允许 IRC 响应频道事件/命令时写入配置 (默认: true)。",
  "channels.irc.dmPolicy":
    '私聊消息访问控制 ("pairing" 配对模式是推荐的)。"open" 开放模式需要设置 channels.irc.allowFrom=["*"]。',
  "channels.irc.nickserv.enabled":
    "在连接后启用 NickServ 身份验证/注册 (当配置了密码时，此项默认启用)。",
  "channels.irc.nickserv.service": "NickServ 服务的昵称 (默认: NickServ)。",
  "channels.irc.nickserv.password": "用于 IDENTIFY/REGISTER 的 NickServ 密码 (敏感信息)。",
  "channels.irc.nickserv.passwordFile": "包含 NickServ 密码的可选文件路径。",
  "channels.irc.nickserv.register":
    "如果为 true，则每次连接时都发送 NickServ REGISTER 命令。用于初次注册，之后应禁用。",
  "channels.irc.nickserv.registerEmail":
    "与 NickServ REGISTER 一起使用的邮箱 (当 register=true 时必需)。",
};
