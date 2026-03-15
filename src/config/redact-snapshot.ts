// 本文件是一个关键的安全组件，其目的是在将配置快照发送到客户端（如 Web UI）之前，
// **编辑**（隐藏）其中的敏感信息，然后在从客户端接收回修改后的配置时，再将这些信息**恢复**。
// 这可以防止 API 密钥和令牌等秘密信息泄露到客户端。
//
// "往返"问题与解决方案:
// 1. 服务器加载含有 `apiKey: "sk-12345"` 的配置。
// 2. Web UI 请求当前配置。
// 3. (不安全) 如果服务器直接发送配置，`apiKey` 会暴露在浏览器中。
// 4. (安全) 使用本文件的 `redactConfigSnapshot`，它会将配置变为 `apiKey: "__OPENCLAW_REDACTED__"` 再发送。
// 5. 用户在 UI 中修改了其他设置并保存，发回的配置中 `apiKey` 仍是占位符。
// 6. (不安全) 如果服务器直接保存这个返回的配置，真实的 `apiKey` 就会丢失。
// 7. (安全) 使用本文件的 `restoreRedactedValues`，它在保存前比较收到的配置和原始配置，
//    当看到占位符时，会从原始配置中找回真实值 "sk-12345"，从而正确地保存文件。

import JSON5 from "json5";
import { createSubsystemLogger } from "../logging/subsystem.js";
// ... 其他导入 ...
import { isSensitiveConfigPath, type ConfigUiHints } from "./schema.hints.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

// ...

/**
 * 用于替换敏感配置字段的哨兵（sentinel）值。
 * 在配置回写时，处理程序会检测这个哨兵值，并从磁盘上的原始配置中恢复其真实值，
 * 这样可以确保通过 Web UI 的一次往返操作不会损坏凭据。
 */
export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * 【核心】根据 UI 提示构建一个用于快速查找敏感路径的 Set。
 * 这是一个性能优化，将路径检查转换为高效的 Set 查找。
 */
function buildRedactionLookup(hints: ConfigUiHints): Set<string> { /* ... */ }


/**
 * 深度遍历一个对象，并将敏感路径下的字符串值替换为编辑哨兵。
 */
function redactObject(obj: unknown, hints?: ConfigUiHints): unknown {
  if (hints) {
    const lookup = buildRedactionLookup(hints);
    // 优先使用基于 schema hints 的精确查找方法
    return lookup.has("")
      ? redactObjectWithLookup(obj, lookup, "", [], hints)
      : redactObjectGuessing(obj, "", [], hints);
  } else {
    // 如果没有 hints，则回退到基于路径名称猜测的方法
    return redactObjectGuessing(obj, "", []);
  }
}

/**
 * `redactObject` 的工作函数，使用预先构建的 `lookup` Set 来查找敏感路径。
 */
function redactObjectWithLookup( /* ... */ ): unknown { /* ... */ }

/**
 * `redactObject` 的工作函数，当没有 UI 提示时，通过正则匹配路径名来“猜测”哪些是敏感字段。
 */
function redactObjectGuessing( /* ... */ ): unknown { /* ... */ }


/**
 * 【核心】编辑（隐藏）配置快照中的所有敏感字段。
 *
 * `config`（解析后的对象）和 `raw`（原始 JSON5 文本）都会被清理，
 * 以确保没有凭据可以通过任何一种方式泄漏。
 *
 * @param snapshot - 原始的配置文件快照。
 * @param uiHints - （可选）来自 schema 的 UI 提示，用于精确识别敏感字段。
 * @returns 一个新的、所有敏感字段都被替换为哨兵值的配置快照。
 */
export function redactConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  uiHints?: ConfigUiHints,
): ConfigFileSnapshot {
  if (!snapshot.valid) {
    // 如果快照本身就无效（例如，JSON 解析失败），
    //  safest thing to do is to return an empty config to prevent any data leakage.
    // 最安全的做法是返回一个空的配置，以防止任何数据泄露。
    return { ...snapshot, config: {}, raw: null, parsed: null, resolved: {} };
  }

  // 1. 对解析后的 `config` 对象进行编辑
  const redactedConfig = redactObject(snapshot.config, uiHints) as ConfigFileSnapshot["config"];
  const redactedParsed = snapshot.parsed ? redactObject(snapshot.parsed, uiHints) : snapshot.parsed;

  // 2. 对原始的 `raw` 文本进行编辑
  let redactedRaw = snapshot.raw ? redactRawText(snapshot.raw, snapshot.config, uiHints) : null;
  // ... 存在一些复杂的回退逻辑，以确保即使文本替换失败，也能生成一个安全的 JSON 字符串 ...
  
  // 3. 对 `resolved` 对象（应用了环境变量替换后）也进行编辑
  const redactedResolved = redactConfigObject(snapshot.resolved, uiHints);

  return {
    ...snapshot,
    config: redactedConfig,
    raw: redactedRaw,
    parsed: redactedParsed,
    resolved: redactedResolved,
  };
}

export type RedactionResult = { /* ... */ };

/**
 * 【核心】恢复被编辑的值。
 * 
 * 深度遍历 `incoming` 对象，并将任何 `REDACTED_SENTINEL` 值
 * 替换为 `original` 对象中相应路径下的真实值。
 *
 * 这是在 `config.set` 等写入操作之前调用的，以确保凭据在 Web UI 往返后能被正确保存。
 * @param incoming - 从客户端收到的、包含哨兵值的配置。
 * @param original - 服务器上持有的、包含真实值的原始配置。
 * @param hints - （可选）UI 提示，用于精确匹配。
 * @returns 一个包含了恢复后真实值的、可供保存的新配置对象。
 */
export function restoreRedactedValues(
  incoming: unknown,
  original: unknown,
  hints?: ConfigUiHints,
): RedactionResult {
  try {
    // 与编辑逻辑类似，优先使用带 `hints` 的精确恢复方法
    if (hints) {
      // ...
    } else {
      return { ok: true, result: restoreRedactedValuesGuessing(incoming, original, "") };
    }
  } catch (err) {
    // ... 错误处理 ...
  }
}

/**
 * `restoreRedactedValues` 的工作函数，使用 `lookup` Set。
 */
function restoreRedactedValuesWithLookup( /* ... */ ): unknown { /* ... */ }

/**
 * `restoreRedactedValues` 的工作函数，使用“猜测”模式。
 */
function restoreRedactedValuesGuessing( /* ... */ ): unknown { /* ... */ }
