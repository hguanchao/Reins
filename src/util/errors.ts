/**
 * 统一错误类型。
 *
 * 设计意图:所有可预期的失败都带一个稳定的错误码,便于上层判定与用户提示;
 * 错误信息面向用户,附带可执行的修复提示。
 */

/** 基础错误:带错误码与可选修复提示。 */
export class ReinsError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ReinsError';
    this.code = code;
    this.hint = hint;
  }
}

/** 配置错误:config.toml / providers.json 的加载与校验失败。 */
export class ConfigError extends ReinsError {
  constructor(message: string, hint?: string) {
    super('config', message, hint);
    this.name = 'ConfigError';
  }
}

/** 工具错误:执行失败的信息会回传给模型,由模型决定下一步。 */
export class ToolError extends ReinsError {
  constructor(message: string, hint?: string) {
    super('tool', message, hint);
    this.name = 'ToolError';
  }
}

/** 权限拒绝:属于策略裁决的结果,不是异常路径。 */
export class PermissionDeniedError extends ReinsError {
  constructor(message: string, hint?: string) {
    super('permission_denied', message, hint);
    this.name = 'PermissionDeniedError';
  }
}

/** 把任意抛出物整理成一行可读文本。 */
export function describeError(error: unknown): string {
  if (error instanceof ReinsError) {
    return error.hint ? `${error.message}(${error.hint})` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
