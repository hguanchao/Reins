import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionReadView } from "../session/port.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import type { AnyToolDefinition, ToolAnnotations, ToolResult } from "./contract.ts";
import { validateToolArguments } from "./schema.ts";
import type { ResultSpiller } from "./spill.ts";

/**
 * 工具注册表与调用管线。
 *
 * 所有工具——核心的与插件的——只能经这里执行。把「整理参数、校验、执行、处理溢出」收在一条
 * 路径上，是为了让权限判定之后有唯一的位置可以插入；如果每个工具自己校验自己执行，安全规则
 * 就得在每处各写一遍。
 *
 * 工具的可用集合就是注册进来的集合，没有单独的启用清单：注册了就能被调用，判定留给权限层。
 */

export type ToolSource = "core" | "plugin";

export interface ToolCallRequest {
	readonly callId: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
}

export interface ToolCallOutcome {
	/** 交给模型的内容，超出阈值时已经处理过 */
	readonly content: string;
	readonly isError: boolean;
	readonly durationMs: number;
}

/**
 * 审批判定。
 *
 * 由宿主提供实现，注册表只知道它能在执行之前给出一个允不允许的结论。抽成接口而不是直接
 * 依赖权限模块，是为了让「工具层需要一次外部判定」这件事与「判定怎么做」各自独立。
 */
export interface ToolGate {
	check(request: GateRequest): Promise<GateOutcome>;
}

export interface GateRequest {
	readonly tool: string;
	readonly annotations: ToolAnnotations;
	readonly args: Record<string, unknown>;
	readonly signal: AbortSignal;
}

export interface GateOutcome {
	readonly allowed: boolean;
	/** 拒绝的理由，会写进工具结果让模型知道为什么没做成 */
	readonly reason: string;
}

/** 一次调用需要的运行环境，由装配处提供。 */
export interface ToolRunContext {
	readonly workspace: WorkspaceBoundary;
	readonly sandbox: SandboxView;
	readonly session: SessionReadView;
	readonly signal: AbortSignal;
	readonly onUpdate: (text: string) => void;
}

interface Registration {
	readonly definition: AnyToolDefinition;
	readonly source: ToolSource;
}

export class ToolRegistry {
	readonly #tools = new Map<string, Registration>();
	readonly #spiller: ResultSpiller;
	readonly #gate: ToolGate;

	constructor(spiller: ResultSpiller, gate: ToolGate) {
		this.#spiller = spiller;
		this.#gate = gate;
	}

	/**
	 * 注册工具。
	 *
	 * 插件不得替换核心工具：read/write/edit/bash 是「能改代码」这件事本身，被换掉之后使用者
	 * 很难察觉，而没有察觉的替换正是最危险的一类改动。
	 */
	register(definition: AnyToolDefinition, source: ToolSource): void {
		const existing = this.#tools.get(definition.name);
		if (existing === undefined) {
			this.#tools.set(definition.name, { definition, source });
			return;
		}
		if (existing.source === "core" && source === "plugin") {
			throw new Error(`核心工具 ${definition.name} 不能被插件替换`);
		}
		throw new Error(`工具 ${definition.name} 重复注册`);
	}

	get(name: string): AnyToolDefinition | undefined {
		return this.#tools.get(name)?.definition;
	}

	/** 声明给模型的工具清单。 */
	list(): readonly AnyToolDefinition[] {
		return [...this.#tools.values()].map((item) => item.definition);
	}

	/** 名字与来源，用于诊断输出。 */
	describe(): readonly { readonly name: string; readonly source: ToolSource }[] {
		return [...this.#tools.entries()].map(([name, item]) => ({ name, source: item.source }));
	}

	async call(request: ToolCallRequest, context: ToolRunContext): Promise<ToolCallOutcome> {
		const tool = this.get(request.name);
		if (tool === undefined) {
			const known = [...this.#tools.keys()].join("、");
			return error(`没有名为 ${request.name} 的工具。可用：${known}`);
		}

		const prepared =
			tool.prepareArguments === undefined ? request.args : tool.prepareArguments(request.args);
		const validated = validateToolArguments(tool.parameters, prepared);
		if (!validated.ok) {
			// 把「收到了什么」一并回显，模型才能判断是自己写错了参数名还是写错了类型
			return error(`参数有误：\n${validated.message}\n收到的参数：${JSON.stringify(prepared)}`);
		}

		// 审批判定：校验之后、执行之前。放在校验之后的理由是模型把参数写错时应当直接告诉它，
		// 而不是先弹一次确认再报参数错
		let gateOutcome: GateOutcome;
		try {
			gateOutcome = await this.#gate.check({
				tool: tool.name,
				annotations: tool.annotations,
				args: validated.value,
				signal: context.signal,
			});
		} catch (cause) {
			// 判定本身失败时按拒绝处理：检查环节出问题不该等于放行
			return error(`审批判定失败，已拒绝：${describeError(cause)}`);
		}
		if (!gateOutcome.allowed) {
			return error(`未执行：${gateOutcome.reason}`);
		}

		const startedAt = performance.now();
		let result: ToolResult;
		try {
			result = await tool.execute({
				callId: request.callId,
				args: validated.value,
				signal: context.signal,
				onUpdate: context.onUpdate,
				workspace: context.workspace,
				sandbox: context.sandbox,
				session: context.session,
			});
		} catch (error) {
			// 工具抛错不让整轮对话中断：转成错误结果交回去，模型自己决定怎么改
			return {
				content: `工具执行失败：${describeError(error)}`,
				isError: true,
				durationMs: elapsed(startedAt),
			};
		}

		return {
			content: this.#spiller.spill(request.name, result.content),
			isError: result.isError ?? false,
			durationMs: elapsed(startedAt),
		};
	}
}

function error(content: string): ToolCallOutcome {
	return { content, isError: true, durationMs: 0 };
}

function elapsed(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt));
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
