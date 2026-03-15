// 本文件实现了一种用于“画布（Canvas）”功能的、基于能力（Capability）的安全 URL 方案。
//
// **核心思想**:
// 为了授权访问画布中的资源，它会生成一个“作用域 URL (Scoped URL)”。
// 这个特殊的 URL 会将一个临时的、随机生成的能力令牌（capability token）嵌入到其路径中。
//
// 流程如下:
// 1. **生成**: `mintCanvasCapabilityToken` 创建一个随机令牌。
// 2. **构建**: `buildCanvasScopedHostUrl` 将这个令牌嵌入到一个基础 URL 的路径中，
//    形成类似 `http://.../__openclaw__/cap/<token>` 的 URL。
// 3. **解析与重写**: 当服务器收到一个作用域 URL 的请求时，`normalizeCanvasScopedUrl` 会：
//    a. 从路径中提取出令牌。
//    b. 将 URL “重写”回其原始的、规范的路径。
//    c. 将提取出的令牌附加为查询参数（`?oc_cap=<token>`）。
//
// 这样，服务器的授权中间件就可以通过检查这个查询参数来验证请求的合法性，
// 而后端的静态文件服务器则可以根据重写后的规范路径来正确地提供文件。

import { randomBytes } from "node:crypto";

/**
 * 作用域 URL 中用于标识能力令牌的特殊路径前缀。
 */
export const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
/**
 * 在 URL 重写后，用于携带能力令牌的查询参数名。
 */
export const CANVAS_CAPABILITY_QUERY_PARAM = "oc_cap";
/**
 * 能力令牌的有效时间（Time-To-Live），这里是10分钟。
 */
export const CANVAS_CAPABILITY_TTL_MS = 10 * 60_000;

/**
 * 描述一个经过规范化处理的作用域 URL 的结果。
 */
export type NormalizedCanvasScopedUrl = {
  pathname: string;             // 规范化后的、真实的资源路径
  capability?: string;           // 提取出的能力令牌
  rewrittenUrl?: string;         // （可选）重写后的完整 URL (路径 + 查询参数)
  scopedPath: boolean;          // 原始 URL 是否是一个作用域路径
  malformedScopedPath: boolean; // 原始 URL 是否是一个格式错误的作用域路径
};

/**
 * 规范化能力令牌字符串（去除首尾空格）。
 */
function normalizeCapability(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 生成一个新的、随机的、URL安全的能力令牌。
 * @returns 一个 Base64URL 编码的随机字符串。
 */
export function mintCanvasCapabilityToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * 构建一个画布作用域的主机 URL。
 * 它将能力令牌嵌入到 URL 的路径部分。
 * @param baseUrl - 基础 URL。
 * @param capability - 要嵌入的能力令牌。
 * @returns 构造好的作用域 URL 字符串，如果失败则返回 `undefined`。
 */
export function buildCanvasScopedHostUrl(baseUrl: string, capability: string): string | undefined {
  const normalizedCapability = normalizeCapability(capability);
  if (!normalizedCapability) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    // 将特殊前缀和编码后的令牌附加到路径末尾
    const prefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`;
    url.pathname = `${trimmedPath}${prefix}`;
    // 清理掉原始的查询参数和哈希
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/**
 * 【核心解析函数】规范化一个画布作用域 URL。
 * @param rawUrl - 客户端请求的原始 URL。
 * @returns 一个 `NormalizedCanvasScopedUrl` 对象，包含了所有解析出的信息。
 */
export function normalizeCanvasScopedUrl(rawUrl: string): NormalizedCanvasScopedUrl {
  const url = new URL(rawUrl, "http://localhost"); // 使用一个虚拟基础 URL 来确保解析总能成功
  const prefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/`;
  let scopedPath = false;
  let malformedScopedPath = false;
  let capabilityFromPath: string | undefined;
  let rewrittenUrl: string | undefined;

  // 1. 检查路径是否以我们的特殊前缀开头
  if (url.pathname.startsWith(prefix)) {
    scopedPath = true;
    const remainder = url.pathname.slice(prefix.length);
    const slashIndex = remainder.indexOf("/");
    
    if (slashIndex <= 0) {
      // 格式错误：例如 /__openclaw__/cap/token (没有后面的斜杠)
      malformedScopedPath = true;
    } else {
      // 2. 从路径中提取出令牌和真实的资源路径
      const encodedCapability = remainder.slice(0, slashIndex);
      const canonicalPath = remainder.slice(slashIndex) || "/";
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(encodedCapability);
      } catch {
        malformedScopedPath = true;
      }
      capabilityFromPath = normalizeCapability(decoded);
      
      if (!capabilityFromPath || !canonicalPath.startsWith("/")) {
        malformedScopedPath = true;
      } else {
        // 3. 【URL 重写】
        // a. 将 URL 的 pathname 恢复为真实的资源路径
        url.pathname = canonicalPath;
        // b. 如果查询参数中没有，则将提取出的令牌作为查询参数添加进去
        if (!url.searchParams.has(CANVAS_CAPABILITY_QUERY_PARAM)) {
          url.searchParams.set(CANVAS_CAPABILITY_QUERY_PARAM, capabilityFromPath);
        }
        rewrittenUrl = `${url.pathname}${url.search}`;
      }
    }
  }

  // 4. 最终的能力令牌，优先从路径中获取，其次尝试从查询参数中获取。
  const capability =
    capabilityFromPath ?? normalizeCapability(url.searchParams.get(CANVAS_CAPABILITY_QUERY_PARAM));
    
  // 5. 返回结构化的解析结果。
  return {
    pathname: url.pathname,
    capability,
    rewrittenUrl,
    scopedPath,
    malformedScopedPath,
  };
}
