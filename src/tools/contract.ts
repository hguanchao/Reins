import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionReadView } from "../session/port.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import type { JsonSchema } from "./schema.ts";

/**
 * 工具契约。
 *
 * 核心工具与插件工具用同一份契约，也都只经注册表那一条管线执行。这样权限与沙箱的判定
 * 只有一处，插件没有机会绕过。
 */

/** 工具对模型的声明。模型只看得到这些，执行细节不在这里。 */
export interface ToolDeclaration {
	readonly name: string;
	/** 完整说明，随工具 schema 一起发送，参数细节写在这里 */
	readonly description: string;
	/** 系统提示词工具清单里的短句；省略时用 description */
	readonly summary?: string;
	readonly parameters: JsonSchema;
}

/** 供权限与沙箱判定用的提示。不保证准确，只能当作参考。 */
export interface ToolAnnotations {
	/** 不改动任何状态 */
	readonly readOnly: boolean;
	/** 可能造成不可逆的改动 */
	readonly destructive: boolean;
	/** 会触碰工作区之外的东西（网络、其他进程） */
	readonly openWorld: boolean;
}

/**
 * 一次调用可以按什么范围记住「本会话总是允许」。
 *
 * key 用于匹配，label 给使用者看。工具返回 undefined 表示这次调用不能记住，必须逐次确认；
 * 没有实现这个方法的工具按工具名记住。
 */
export interface PermissionScope {
	readonly key: string;
	/** 给确认面板看的完整说明 */
	readonly label: string;
	/** 动作行里的短标签；省略时用 label */
	readonly short?: string;
}

export interface ToolResult {
	/** 给模型看的内容 */
	readonly content: string;
	readonly isError?: boolean;
	/** 给界面与状态重建用的结构化数据，不发给模型 */
	readonly details?: unknown;
}

interface ToolContext<P> {
	readonly callId: string;
	readonly args: P;
	readonly signal: AbortSignal;
	/** 推送阶段性输出 */
	readonly onUpdate: (text: string) => void;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
}

/**
 * 工具定义。
 *
 * 参数类型由各工具自己声明（如 `ToolDefinition<ReadArgs>`），注册表统一按 `AnyToolDefinition`
 * 保存。这里不把参数约束成带索引签名的类型，否则每个参数接口都得写一条索引签名才能放进来。
 */
export interface ToolDefinition<P = Record<string, unknown>> extends ToolDeclaration {
	readonly annotations: ToolAnnotations;
	/**
	 * 在模式校验之前整理参数。
	 *
	 * 存在的理由是模型偶尔会把结构化参数写成 JSON 字符串，或者用早先版本的字段名。
	 * 这类容忍只对确实见过的写法开放，不做通用推导。
	 */
	prepareArguments?(args: Record<string, unknown>): Record<string, unknown>;
	/**
	 * 本会话内可以记住的放行范围；返回 undefined 表示这次调用不能记住。
	 *
	 * 与 execute 分开：它在审批之前计算，因此不能依赖副作用，也不应该执行工具本身。
	 */
	permissionScope?(args: P, workspace: WorkspaceBoundary): PermissionScope | undefined;
	execute(context: ToolContext<P>): Promise<ToolResult>;
}

/** 注册表保存工具时用的类型。 */
export type AnyToolDefinition = ToolDefinition<Record<string, unknown>>;

/**
 * 审批判定需要的信息。
 *
 * 注册表与权限层共用这一份契约：两处各写一遍时，字段很容易在改动后悄悄对不上，而审批请求
 * 正是安全检查的输入，口径必须唯一。
 */
export interface GateRequest {
	readonly tool: string;
	readonly annotations: ToolAnnotations;
	readonly args: Record<string, unknown>;
	/** 工具来源：审批层据此决定只读标注是否可信（core 可信，bundled 与 plugin 不可信） */
	readonly source: "core" | "bundled" | "plugin";
	/** 本会话可记住的放行范围；undefined 表示这次调用只能逐次批准 */
	readonly scope: PermissionScope | undefined;
	readonly signal: AbortSignal;
}

export interface GateOutcome {
	readonly allowed: boolean;
	/** 拒绝的理由，会写进工具结果让模型知道为什么没做成；放行时为空。 */
	readonly reason: string;
}
