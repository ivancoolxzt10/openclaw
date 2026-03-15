// 本文件是环境变量处理的另一半，与 `env-preserve.ts` 协同工作。
// `env-substitution.ts` 负责在 *读取* 配置时，将所有 `${VAR}` 占位符
// 替换为其在当前环境中的实际值。
//
// 功能摘要:
// - 支持在字符串值中使用 `${VAR_NAME}` 语法。
// - 仅匹配大写环境变量名：`[A-Z_][A-Z0-9_]*`。
// - 使用 `$${}` 来转义，以输出字面量 `${}`。
// - 如果引用的环境变量缺失，会抛出 `MissingEnvVarError` 并提供上下文。
//
// 示例 (JSON5):
// {
//   models: {
//     providers: {
//       "vercel-gateway": {
//         apiKey: "${VERCEL_GATEWAY_API_KEY}"
//       }
//     }
//   }
// }

import { isPlainObject } from "../utils.js";

// 用于验证有效的大写环境变量名称的正则表达式
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * 自定义错误类，当引用的环境变量缺失时抛出。
 */
export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string, // 缺失的变量名
    public readonly configPath: string, // 该变量在配置中的路径
  ) {
    super(`缺失环境变量 "${varName}"，它在配置路径被引用: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

// 解析出的环境变量“令牌”（token）的类型
type EnvToken =
  | { kind: "escaped"; name: string; end: number } // 转义的令牌，如 $${VAR}
  | { kind: "substitution"; name: string; end: number }; // 需要替换的令牌，如 ${VAR}

/**
 * 在给定索引处解析字符串，看是否存在一个环境变量令牌。
 */
function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") {
    return null;
  }

  // 转义情况: $${VAR} -> 解析为 "escaped" 令牌
  if (value[index + 1] === "$" && value[index + 2] === "{") {
    const start = index + 3;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "escaped", name, end };
      }
    }
  }

  // 替换情况: ${VAR} -> 解析为 "substitution" 令牌
  if (value[index + 1] === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "substitution", name, end };
      }
    }
  }

  return null;
}

export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

export type SubstituteOptions = {
  /** 如果设置了此回调，缺失的变量将调用它而不是抛出错误，并且原始占位符将被保留。 */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
};

/**
 * 对单个字符串执行变量替换。
 */
function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
  opts?: SubstituteOptions,
): string {
  if (!value.includes("$")) {
    return value;
  }

  const chunks: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "$") {
      chunks.push(value[i]);
      continue;
    }

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      chunks.push(`\${${token.name}}`); // 写入字面量 ${VAR}
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      const envValue = env[token.name];
      if (envValue === undefined || envValue === "") {
        // 如果变量缺失
        if (opts?.onMissing) {
          // 调用警告回调并保留原始占位符
          opts.onMissing({ varName: token.name, configPath });
          chunks.push(`\${${token.name}}`);
          i = token.end;
          continue;
        }
        // 否则，抛出错误
        throw new MissingEnvVarError(token.name, configPath);
      }
      chunks.push(envValue); // 替换为环境变量值
      i = token.end;
      continue;
    }

    // 如果不是可识别的模式，则保持原样
    chunks.push(value[i]);
  }

  return chunks.join("");
}

/**
 * 检查字符串是否包含可替换的（即未转义的）`${VAR}`引用。
 */
export function containsEnvVarReference(value: string): boolean {
  if (!value.includes("$")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "$") continue;
    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      return true;
    }
  }
  return false;
}

/**
 * 对任意类型的值进行递归替换。
 */
function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, path, opts);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteAny(val, env, childPath, opts);
    }
    return result;
  }

  // 其他原始类型（数字、布尔、null）直接返回
  return value;
}

/**
 * 解析配置值中的 `${VAR_NAME}` 环境变量引用。
 *
 * @param obj - 已解析的配置对象（在 JSON5 解析和 `$include` 解析之后）。
 * @param env - 用于替换的环境变量（默认为 process.env）。
 * @param opts - 选项：`onMissing` 回调用于收集警告而不是抛出错误。
 * @returns 替换了环境变量的配置对象。
 * @throws {MissingEnvVarError} 如果引用的环境变量未设置或为空（除非设置了 `onMissing`）。
 */
export function resolveConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts?: SubstituteOptions,
): unknown {
  return substituteAny(obj, env, "", opts);
}
