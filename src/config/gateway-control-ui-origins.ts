// 本文件负责配置网关（Gateway）控制界面的“允许来源（allowed origins）”。
// 这是一个关键的安全功能（与 CORS - 跨源资源共享相关），用于确保只有受信任的网页
// 能够向网关的控制 API 发出请求。
// 当网关暴露于本地网络但用户尚未手动配置此安全设置时，本模块会自动应用一组安全的默认值。

import type { OpenClawConfig } from "./config.js";
import { DEFAULT_GATEWAY_PORT } from "./paths.js";

/**
 * 网关的非环回（non-loopback）绑定模式。
 * 这些模式意味着网关可以在本地网络上被访问，而不仅仅是本机。
 * - `lan`: 绑定到局域网地址。
 * - `tailnet`: 绑定到 Tailscale 网络地址。
 * - `custom`: 绑定到用户指定的自定义主机。
 */
export type GatewayNonLoopbackBindMode = "lan" | "tailnet" | "custom";

/**
 * 类型保护函数，检查绑定模式是否为非环回模式。
 */
export function isGatewayNonLoopbackBindMode(bind: unknown): bind is GatewayNonLoopbackBindMode {
  return bind === "lan" || bind === "tailnet" || bind === "custom";
}

/**
 * 检查用户是否已经配置了控制界面的 `allowedOrigins`。
 * 如果用户已配置，或者启用了一个危险的备用选项，则我们不应覆盖它。
 */
export function hasConfiguredControlUiAllowedOrigins(params: {
  allowedOrigins: unknown;
  dangerouslyAllowHostHeaderOriginFallback: unknown;
}): boolean {
  if (params.dangerouslyAllowHostHeaderOriginFallback === true) {
    return true;
  }
  return (
    Array.isArray(params.allowedOrigins) &&
    params.allowedOrigins.some((origin) => typeof origin === "string" && origin.trim().length > 0)
  );
}

/**
 * 解析网关端口号，如果未提供则使用默认值。
 */
export function resolveGatewayPortWithDefault(
  port: unknown,
  fallback = DEFAULT_GATEWAY_PORT,
): number {
  return typeof port === "number" && port > 0 ? port : fallback;
}

/**
 * 根据网关的端口和绑定模式，构建一个默认的 `allowedOrigins` 列表。
 * 默认总是包含 `localhost` 和 `127.0.0.1`。
 */
export function buildDefaultControlUiAllowedOrigins(params: {
  port: number;
  bind: unknown;
  customBindHost?: string;
}): string[] {
  const origins = new Set<string>([
    `http://localhost:${params.port}`,
    `http://127.0.0.1:${params.port}`,
  ]);
  const customBindHost = params.customBindHost?.trim();
  if (params.bind === "custom" && customBindHost) {
    origins.add(`http://${customBindHost}:${params.port}`);
  }
  return [...origins];
}

/**
 * 确保在网关以非环回模式绑定时，`allowedOrigins` 已被正确设置。
 * 这是本模块的核心函数。
 *
 * @param config OpenClaw 配置对象。
 * @param opts 选项，例如默认端口或是否要求控制界面启用。
 * @returns 返回一个对象，其中包含：
 *   - `config`: 可能已被注入了默认来源的新配置对象。
 *   - `seededOrigins`: 被注入的来源列表，如果没有注入则为 `null`。
 *   - `bind`: 检测到的绑定模式。
 */
export function ensureControlUiAllowedOriginsForNonLoopbackBind(
  config: OpenClawConfig,
  opts?: { defaultPort?: number; requireControlUiEnabled?: boolean },
): {
  config: OpenClawConfig;
  seededOrigins: string[] | null;
  bind: GatewayNonLoopbackBindMode | null;
} {
  const bind = config.gateway?.bind;
  // 条件 1: 仅当绑定模式为非环回模式时才继续。
  if (!isGatewayNonLoopbackBindMode(bind)) {
    return { config, seededOrigins: null, bind: null };
  }
  // 如果要求控制 UI 启用但它被禁用了，则不处理。
  if (opts?.requireControlUiEnabled && config.gateway?.controlUi?.enabled === false) {
    return { config, seededOrigins: null, bind };
  }
  // 条件 2: 仅当用户尚未自己配置 `allowedOrigins` 时才继续。
  if (
    hasConfiguredControlUiAllowedOrigins({
      allowedOrigins: config.gateway?.controlUi?.allowedOrigins,
      dangerouslyAllowHostHeaderOriginFallback:
        config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    })
  ) {
    return { config, seededOrigins: null, bind };
  }

  // 如果满足所有条件，则生成并注入默认值。
  const port = resolveGatewayPortWithDefault(config.gateway?.port, opts?.defaultPort);
  const seededOrigins = buildDefaultControlUiAllowedOrigins({
    port,
    bind,
    customBindHost: config.gateway?.customBindHost,
  });
  return {
    config: {
      ...config,
      gateway: {
        ...config.gateway,
        controlUi: {
          ...config.gateway?.controlUi,
          allowedOrigins: seededOrigins,
        },
      },
    },
    seededOrigins,
    bind,
  };
}
