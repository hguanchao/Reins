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
	readonly description: string;
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

export interface ToolResult {
	/** 给模型看的内容 */
	readonly content: string;
	readonly isError?: boolean;
	/** 给界面与状态重建用的结构化数据，不发给模型 */
	readonly details?: unknown;
}

export interface ToolContext<P> {
	readonly callId: string;
	readonly args: P;
	readonly signal: AbortSignal;
	/** 推送阶段性输出 */
	readonly onUpdate: (text: string) => void;
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
}

export interface ToolDefinition<P = Record<string, unknown>> extends ToolDeclaration {
	readonly annotations: ToolAnnotations;
	/**
	 * 在模式校验之前整理参数。
	 *
	 * 存在的理由是模型偶尔会把结构化参数写成 JSON 字符串，或者用早先版本的字段名。
	 * 这类容忍只对确实见过的写法开放，不做通用推导。
	 */
	prepareArguments?(args: Record<string, unknown>): Record<string, unknown>;
	execute(context: ToolContext<P>): Promise<ToolResult>;
}

/** 注册表保存工具时用的类型。各工具带自己的参数类型，方法参数按双变处理所以可以放进同一个表。 */
export type AnyToolDefinition = ToolDefinition<Record<string, unknown>>;
