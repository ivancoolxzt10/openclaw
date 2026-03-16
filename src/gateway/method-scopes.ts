export const ADMIN_SCOPE = "operator.admin" as const;
export const READ_SCOPE = "operator.read" as const;
export const WRITE_SCOPE = "operator.write" as const;
export const APPROVALS_SCOPE = "operator.approvals" as const;
export const PAIRING_SCOPE = "operator.pairing" as const;

export type OperatorScope =
  | typeof ADMIN_SCOPE
  | typeof READ_SCOPE
  | typeof WRITE_SCOPE
  | typeof APPROVALS_SCOPE
  | typeof PAIRING_SCOPE;

export const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[] = [
  ADMIN_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
];

const NODE_ROLE_METHODS = new Set([
  "node.invoke.result",
  "node.event",
  "node.pending.drain",
  "node.canvas.capability.refresh",
  "node.pending.pull",
  "node.pending.ack",
  "skills.bins",
]);

const METHOD_SCOPE_GROUPS: Record<OperatorScope, readonly string[]> = {
  [APPROVALS_SCOPE]: [
    "exec.approval.request",
    "exec.approval.waitDecision",
    "exec.approval.resolve",
  ],
  [PAIRING_SCOPE]: [
    "node.pair.request",
    "node.pair.list",
    "node.pair.approve",
    "node.pair.reject",
    "node.pair.verify",
    "device.pair.list",
    "device.pair.approve",
    "device.pair.reject",
    "device.pair.remove",
    "device.token.rotate",
    "device.token.revoke",
    "node.rename",
  ],
  [READ_SCOPE]: [
    "health",
    "doctor.memory.status",
    "logs.tail",
    "channels.status",
    "status",
    "usage.status",
    "usage.cost",
    "tts.status",
    "tts.providers",
    "models.list",
    "tools.catalog",
    "agents.list",
    "agent.identity.get",
    "skills.status",
    "voicewake.get",
    "sessions.list",
    "sessions.get",
    "sessions.preview",
    "sessions.resolve",
    "sessions.usage",
    "sessions.usage.timeseries",
    "sessions.usage.logs",
    "cron.list",
    "cron.status",
    "cron.runs",
    "gateway.identity.get",
    "system-presence",
    "last-heartbeat",
    "node.list",
    "node.describe",
    "chat.history",
    "config.get",
    "config.schema.lookup",
    "talk.config",
    "agents.files.list",
    "agents.files.get",
  ],
  [WRITE_SCOPE]: [
    "send",
    "poll",
    "agent",
    "agent.wait",
    "wake",
    "talk.mode",
    "tts.enable",
    "tts.disable",
    "tts.convert",
    "tts.setProvider",
    "voicewake.set",
    "node.invoke",
    "chat.send",
    "chat.abort",
    "browser.request",
    "push.test",
    "node.pending.enqueue",
  ],
  [ADMIN_SCOPE]: [
    "channels.logout",
    "agents.create",
    "agents.update",
    "agents.delete",
    "skills.install",
    "skills.update",
    "secrets.reload",
    "secrets.resolve",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
    "sessions.patch",
    "sessions.reset",
    "sessions.delete",
    "sessions.compact",
    "connect",
    "chat.inject",
    "web.login.start",
    "web.login.wait",
    "set-heartbeats",
    "system-event",
    "agents.files.set",
  ],
};

const ADMIN_METHOD_PREFIXES = ["exec.approvals.", "config.", "wizard.", "update."] as const;

const METHOD_SCOPE_BY_NAME = new Map<string, OperatorScope>(
  Object.entries(METHOD_SCOPE_GROUPS).flatMap(([scope, methods]) =>
    methods.map((method) => [method, scope as OperatorScope]),
  ),
);

/**
 * 解析作用域方法，根据方法名确定其操作作用域
 * @param method 需要解析的方法名
 * @returns 返回对应的作用域，如果无法确定则返回undefined
 */
function resolveScopedMethod(method: string): OperatorScope | undefined {
  const explicitScope = METHOD_SCOPE_BY_NAME.get(method); // 尝试从方法名映射中获取明确的作用域
  if (explicitScope) {
    // 如果找到明确的作用域，直接返回
    return; /* `explicitScope` is a variable that stores the result of attempting to retrieve the
    operator scope for a given method from the `METHOD_SCOPE_BY_NAME` map. It is used to
    check if there is a direct mapping between the method and its corresponding operator
    scope. If a direct mapping is found, `explicitScope` will hold the value of the operator
    scope, which is then returned by the `resolveScopedMethod` function. */
    explicitScope;
  }

  // 检查方法是否以任何管理员前缀开头
  if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return ADMIN_SCOPE; // 如果是管理员方法，返回管理员作用域
  }
  return undefined; // 如果无法确定作用域，返回undefined
}

export function isApprovalMethod(method: string): boolean {
  return resolveScopedMethod(method) === APPROVALS_SCOPE;
}

export function isPairingMethod(method: string): boolean {
  return resolveScopedMethod(method) === PAIRING_SCOPE;
}

export function isReadMethod(method: string): boolean {
  return resolveScopedMethod(method) === READ_SCOPE;
}

export function isWriteMethod(method: string): boolean {
  return resolveScopedMethod(method) === WRITE_SCOPE;
}

export function isNodeRoleMethod(method: string): boolean {
  return NODE_ROLE_METHODS.has(method);
}

export function isAdminOnlyMethod(method: string): boolean {
  return resolveScopedMethod(method) === ADMIN_SCOPE;
}

/**
 * 解析方法所需的操作符作用域
 * @param method 方法名称
 * @returns 返回解析后的操作符作用域，如果无法解析则返回undefined
 */
export function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined {
  // 调用resolveScopedMethod方法解析方法的作用域
  return resolveScopedMethod(method);
}

/**
 * 解析方法所需的最小权限操作符范围
 * @param method - 需要检查的方法名称
 * @returns 返回操作符范围数组，如果方法未分类则返回空数组
 */
export function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[] {
  // 解析方法所需的最小操作符范围
  const requiredScope = resolveRequiredOperatorScopeForMethod(method);
  // 如果找到了所需范围，则返回该范围
  if (requiredScope) {
    return [requiredScope];
  }
  // Default-deny for unclassified methods.
  return [];
}

export function authorizeOperatorScopesForMethod(
  method: string,
  scopes: readonly string[],
): { allowed: true } | { allowed: false; missingScope: OperatorScope } {
  if (scopes.includes(ADMIN_SCOPE)) {
    return { allowed: true };
  }
  const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? ADMIN_SCOPE;
  if (requiredScope === READ_SCOPE) {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) {
      return { allowed: true };
    }
    return { allowed: false, missingScope: READ_SCOPE };
  }
  if (scopes.includes(requiredScope)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: requiredScope };
}

export function isGatewayMethodClassified(method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return true;
  }
  return resolveRequiredOperatorScopeForMethod(method) !== undefined;
}
