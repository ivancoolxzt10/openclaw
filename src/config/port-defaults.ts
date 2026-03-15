// 本文件负责为应用程序内的各种服务计算默认端口号。
// 它使用一种“派生”策略，即大多数默认端口都是通过一个“基础”端口（通常是主网关端口）加上一个偏移量来计算的。
// 这种方法有助于在用户更改主端口时，自动避免端口冲突。

/**
 * 端口范围的类型定义。
 */
export type PortRange = { start: number; end: number };

/**
 * 检查一个数字是否是有效的 TCP/IP 端口号 (1-65535)。
 */
function isValidPort(port: number): boolean {
  return Number.isFinite(port) && port > 0 && port <= 65535;
}

/**
 * 一个简单的验证器，如果端口有效，则返回该端口，否则返回一个备用值。
 */
function clampPort(port: number, fallback: number): number {
  return isValidPort(port) ? port : fallback;
}

/**
 * 派生端口号的核心逻辑。
 * 它接收一个基础端口和一个偏移量，计算出新端口，并确保结果是一个有效的端口号。
 * @param base 基础端口号。
 * @param offset 偏移量。
 * @param fallback 如果计算出的端口无效，则使用的备用端口。
 * @returns 最终的端口号。
 */
function derivePort(base: number, offset: number, fallback: number): number {
  return clampPort(base + offset, fallback);
}

// --- 默认端口常量 ---
// 这些是在派生逻辑失败或不适用时使用的硬编码备用值。
export const DEFAULT_BRIDGE_PORT = 18790;
export const DEFAULT_BROWSER_CONTROL_PORT = 18791;
export const DEFAULT_CANVAS_HOST_PORT = 18793;
export const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800; // CDP: Chrome DevTools Protocol
export const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;

/**
 * 从网关端口派生出 Bridge 服务的默认端口。
 */
export function deriveDefaultBridgePort(gatewayPort: number): number {
  return derivePort(gatewayPort, 1, DEFAULT_BRIDGE_PORT);
}

/**
 * 从网关端口派生出浏览器控制服务的默认端口。
 */
export function deriveDefaultBrowserControlPort(gatewayPort: number): number {
  return derivePort(gatewayPort, 2, DEFAULT_BROWSER_CONTROL_PORT);
}

/**
 * 从网关端口派生出 Canvas 主机服务的默认端口。
 */
export function deriveDefaultCanvasHostPort(gatewayPort: number): number {
  return derivePort(gatewayPort, 4, DEFAULT_CANVAS_HOST_PORT);
}

/**
 * 派生出用于 Chrome 开发者工具协议（CDP）的默认端口范围。
 * 这可能用于浏览器自动化功能。
 */
export function deriveDefaultBrowserCdpPortRange(browserControlPort: number): PortRange {
  const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
  const end = clampPort(
    start + (DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START),
    DEFAULT_BROWSER_CDP_PORT_RANGE_END,
  );
  if (end < start) {
    return { start, end: start };
  }
  return { start, end };
}
