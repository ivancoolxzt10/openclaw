// 这是一个用于记录与配置更改相关的消息的小型实用工具文件。

import type { RuntimeEnv } from "../runtime.js";
import { displayPath } from "../utils.js";
import { createConfigIO } from "./io.js";

type LogConfigUpdatedOptions = {
  path?: string; // 配置文件路径
  suffix?: string; // 要附加到日志消息末尾的后缀
};

/**
 * 格式化一个配置文件路径以便显示。
 * 它使用 `displayPath` 工具函数来清理路径，使其在日志中更具可读性
 * （例如，使用相对路径或用 `~` 代替用户主目录）。
 * @param path 文件路径。如果未提供，则默认为当前活动的配置文件路径。
 * @returns 经过美化的路径字符串。
 */
export function formatConfigPath(path: string = createConfigIO().configPath): string {
  return displayPath(path);
}

/**
 * 记录一条标准化的“配置已更新”消息。
 * @param runtime 运行时环境，其中包含日志记录器。
 * @param opts 包含可选路径和后缀的选项。
 */
export function logConfigUpdated(runtime: RuntimeEnv, opts: LogConfigUpdatedOptions = {}): void {
  const path = formatConfigPath(opts.path ?? createConfigIO().configPath);
  const suffix = opts.suffix ? ` ${opts.suffix}` : "";
  runtime.log(`已更新 ${path}${suffix}`);
}
