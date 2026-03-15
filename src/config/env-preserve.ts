// 本文件旨在解决一个棘手的配置问题：在配置回写时保留 `${VAR}` 形式的环境变量引用。
//
// **问题背景:**
// 1. 用户在配置文件中写入 `${DB_PASSWORD}`。
// 2. 应用程序读取配置，将 `${DB_PASSWORD}` 解析为其实际值（例如 "supersecret123"）。
// 3. 之后，当应用程序需要重新保存配置时，如果直接将内存中的配置写回，
//    文件中的 `${DB_PASSWORD}` 就会被替换为明文密码 "supersecret123"。
//    这会导致原始的环境变量引用丢失，不利于安全和可移植性。
//
// **解决方案:**
// 本文件实现了一个“恢复”过程。在回写配置之前，它会比较“即将写入的、已解析的”配置
// 和“从磁盘读取的、未经替换的”原始配置。只有当一个值看起来像是从一个环境变量
// 解析而来，并且用户没有主动修改它时，才会将原始的 `${VAR}` 引用恢复到文件中。

import { isPlainObject } from "../infra/plain-object.js";

/**
 * 匹配 `${VAR}` 格式环境变量的正则表达式。
 */
const ENV_VAR_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/;

/**
 * 检查字符串是否包含任何 `${VAR}` 环境变量引用。
 */
function hasEnvVarRef(value: string): boolean {
  return ENV_VAR_PATTERN.test(value);
}

/**
 * 使用给定的环境变量尝试解析单个字符串中的 `${VAR}` 引用。
 * 如果引用的任何变量缺失，则返回 null（而不是抛出错误）。
 *
 * 这镜像了 `env-substitution.ts` 中 `substituteString` 的替换语义：
 * - `${VAR}` → 环境变量值 (如果缺失则返回 null)
 * - `$${VAR}` → 字面量 `${VAR}` (转义序列)
 */
function tryResolveString(template: string, env: NodeJS.ProcessEnv): string | null {
  const ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/; // 环境变量名称的有效格式
  const chunks: string[] = [];

  for (let i = 0; i < template.length; i++) {
    if (template[i] === "$") {
      // 处理转义情况: $${VAR} -> 变成字面量 ${VAR}
      if (template[i + 1] === "$" && template[i + 2] === "{") {
        const start = i + 3;
        const end = template.indexOf("}", start);
        if (end !== -1) {
          const name = template.slice(start, end);
          if (ENV_VAR_NAME.test(name)) {
            chunks.push(`\${${name}}`);
            i = end;
            continue;
          }
        }
      }

      // 处理替换情况: ${VAR} -> 替换为环境变量值
      if (template[i + 1] === "{") {
        const start = i + 2;
        const end = template.indexOf("}", start);
        if (end !== -1) {
          const name = template.slice(start, end);
          if (ENV_VAR_NAME.test(name)) {
            const val = env[name];
            // 如果环境变量不存在或为空，则解析失败
            if (val === undefined || val === "") {
              return null;
            }
            chunks.push(val);
            i = end;
            continue;
          }
        }
      }
    }
    chunks.push(template[i]);
  }

  return chunks.join("");
}

/**
 * 深度遍历即将写入的配置，并从“预替换”的解析配置中恢复 `${VAR}` 引用，
 * 条件是解析后的值匹配。
 *
 * @param incoming - 即将写入的、已解析的配置。
 * @param parsed - 从磁盘文件解析的、未经变量替换的原始配置。
 * @param env - 用于验证的环境变量。
 * @returns 一个新的配置对象，其中适当恢复了环境变量引用。
 */
export function restoreEnvVarRefs(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  // 如果原始配置中没有内容，直接返回新配置
  if (parsed === null || parsed === undefined) {
    return incoming;
  }

  // 叶子节点是字符串：检查原始值是否为 `${VAR}` 模板，并且其解析结果与新值相同
  if (typeof incoming === "string" && typeof parsed === "string") {
    if (hasEnvVarRef(parsed)) {
      const resolved = tryResolveString(parsed, env);
      if (resolved === incoming) {
        // 新值与环境变量解析结果匹配 — 恢复引用。
        return parsed;
      }
    }
    // 否则，保留新值（可能是用户有意修改的）
    return incoming;
  }

  // 数组：逐个元素递归处理
  if (Array.isArray(incoming) && Array.isArray(parsed)) {
    return incoming.map((item, i) =>
      i < parsed.length ? restoreEnvVarRefs(item, parsed[i], env) : item,
    );
  }

  // 对象：逐个键递归处理
  if (isPlainObject(incoming) && isPlainObject(parsed)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (key in parsed) {
        // 键在原始配置中存在，递归恢复
        result[key] = restoreEnvVarRefs(value, parsed[key], env);
      } else {
        // 这是调用者新增的键 — 按原样保留
        result[key] = value;
      }
    }
    return result;
  }

  // 类型不匹配或原始类型 — 保留新值
  return incoming;
}
