// 本文件是一个以数据为中心的模块，不包含复杂的业务逻辑。
// 它的主要作用是为与“媒体音频”处理（即理解语音笔记和音频剪辑）相关的配置字段
// 定义元数据，包括详细的帮助文本和简短的标签。
// 这种将用户界面文本与应用程序逻辑分离的做法，便于维护和国际化（i18n）。

/**
 * 一个包含了所有媒体音频相关配置键的常量数组。
 * 每个字符串都是一个完整的点分路径。
 * `as const` 将其转换为一个只读的字符串字面量元组，以实现更强的类型安全。
 */
export const MEDIA_AUDIO_FIELD_KEYS = [
  "tools.media.audio.enabled",
  "tools.media.audio.maxBytes",
  "tools.media.audio.maxChars",
  "tools.media.audio.prompt",
  "tools.media.audio.timeoutSeconds",
  "tools.media.audio.language",
  "tools.media.audio.attachments",
  "tools.media.audio.models",
  "tools.media.audio.scope",
  "tools.media.audio.echoTranscript",
  "tools.media.audio.echoFormat",
] as const;

/**
 * 从 `MEDIA_AUDIO_FIELD_KEYS` 派生出的类型。
 * 这个类型的值只能是上面数组中定义的字符串之一。
 */
type MediaAudioFieldKey = (typeof MEDIA_AUDIO_FIELD_KEYS)[number];

/**
 * 一个字典，为每个媒体音频配置键提供详细的帮助说明。
 * 这些文本旨在解释配置项的作用、用户为何可能需要修改它，以及修改会带来什么影响。
 * 这些信息可用于生成文档或在用户界面、命令行工具中提供帮助提示。
 */
export const MEDIA_AUDIO_FIELD_HELP: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled":
    "启用音频理解功能，以便可以转录/总结语音笔记或音频剪辑以供代理人使用。当音频接收超出策略范围或对您的工作流程非必需时，请禁用此功能。",
  "tools.media.audio.maxBytes":
    "在处理被策略拒绝或裁剪之前，可接受的最大音频有效负载大小（以字节为单位）。请根据预期的录音长度和上游提供商的限制来设置此值。",
  "tools.media.audio.maxChars":
    "从音频理解输出中保留的最大字符数，以防止转录文本过大。对于长篇听写，可以增加此值；对于保持对话回合紧凑，可以降低此值。",
  "tools.media.audio.prompt":
    "指导音频理解输出风格的指令模板，例如简洁的摘要与近乎逐字稿的转录。保持措辞一致，以便下游自动化可以依赖输出格式。",
  "tools.media.audio.timeoutSeconds":
    "音频理解执行的超时时间（以秒为单位），超时后操作将被取消。对长录音使用更长的超时时间，对交互式聊天响应使用更紧凑的超时时间。",
  "tools.media.audio.language":
    "当提供商支持时，为音频理解/转录提供首选语言提示。设置此项可提高已知主要语言的识别准确性。",
  "tools.media.audio.attachments":
    "音频输入的附件策略，指示哪些上传的文件有资格进行音频处理。在混合内容渠道中保持限制性默认设置，以避免意外的音频工作负载。",
  "tools.media.audio.models":
    "专门用于音频理解的有序模型偏好设置，在共享媒体模型回退之前使用。选择针对您的主要语言/领域优化了转录质量的模型。",
  "tools.media.audio.scope":
    "范围选择器，用于确定何时对入站消息和附件运行音频理解。在信息量大的渠道中保持专注的范围，以降低成本并避免意外转录。",
  "tools.media.audio.echoTranscript":
    "在代理处理之前，将音频转录回显到原始聊天中。启用后，用户可以立即看到他们的语音笔记被听到的内容，帮助他们在代理行动前验证转录的准确性。默认值：false。",
  "tools.media.audio.echoFormat":
    "回显转录消息的格式字符串。使用 `{transcript}` 作为转录文本的占位符。默认值：'📝 \"{transcript}\"'。",
};

/**
 * 一个字典，为每个媒体音频配置键提供简短的、人类可读的标签。
 * 这些标签适合在图形用户界面（GUI）中用作字段标签。
 */
export const MEDIA_AUDIO_FIELD_LABELS: Record<MediaAudioFieldKey, string> = {
  "tools.media.audio.enabled": "启用音频理解",
  "tools.media.audio.maxBytes": "音频理解最大字节数",
  "tools.media.audio.maxChars": "音频理解最大字符数",
  "tools.media.audio.prompt": "音频理解提示",
  "tools.media.audio.timeoutSeconds": "音频理解超时（秒）",
  "tools.media.audio.language": "音频理解语言",
  "tools.media.audio.attachments": "音频理解附件策略",
  "tools.media.audio.models": "音频理解模型",
  "tools.media.audio.scope": "音频理解范围",
  "tools.media.audio.echoTranscript": "回显转录到聊天",
  "tools.media.audio.echoFormat": "转录回显格式",
};
