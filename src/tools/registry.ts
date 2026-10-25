import { describeError } from "../describe-error.ts";
import type { SandboxView } from "../sandbox/policy.ts";
import type { SessionReadView } from "../session/port.ts";
import type { WorkspaceBoundary } from "../workspace/boundary.ts";
import type {
	AnyToolDefinition,
	GateOutcome,
	GateRequest,
	PermissionScope,
	ToolResult,
} from "./contract.ts";
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

export type ToolSource = "core" | "bundled" | "plugin";

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
	/** 工具自己的结构化结果，只给界面用，不发给模型 */
	readonly details?: unknown;
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
		if (existing.source === "core" && source !== "core") {
			throw new Error(`Core tool ${definition.name} cannot be replaced by a plugin`);
		}
		throw new Error(`Tool ${definition.name} is already registered`);
	}

	/**
	 * 在现有工具之上再挂一个，得到本次运行用的注册表。
	 *
	 * 需要它是因为有些工具要绑定本次运行才存在的东西（比如子代理要绑定本次运行的会话，
	 * 好把用量记进去），而会话是在插件装载之后才建起来的，赶不上「先于插件注册」那一批。
	 * 复制一份注册表既保住了核心工具不被插件遮蔽，也保住了所有工具仍只走同一条管线。
	 *
	 * 名字已经被占用时直接抛错：静默顶掉一个同名工具，它的作者会以为自己注册成功了。
	 */
	withExtraTool(tool: AnyToolDefinition): ToolRegistry {
		if (this.#tools.has(tool.name)) {
			throw new Error(`Cannot attach a second tool named ${tool.name}: that name is already in use`);
		}
		const copy = new ToolRegistry(this.#spiller, this.#gate);
		for (const [name, item] of this.#tools) copy.#tools.set(name, item);
		copy.#tools.set(tool.name, { definition: tool, source: "core" });
		return copy;
	}

	/**
	 * 复制一份注册表并排除指定工具。
	 *
	 * 用于给子代理这类子集去掉不需要的能力：排除后仍走同一条校验、审批与执行管线，
	 * 原注册表不受影响。名字不存在时直接报错，避免拼写错误静默失效。
	 */
	without(...names: readonly string[]): ToolRegistry {
		for (const name of names) {
			if (!this.#tools.has(name)) {
				throw new Error(`Cannot exclude an unknown tool: ${name}`);
			}
		}
		const copy = new ToolRegistry(this.#spiller, this.#gate);
		for (const [name, item] of this.#tools) {
			if (!names.includes(name)) copy.#tools.set(name, item);
		}
		return copy;
	}

	/**
	 * 复制一份注册表，只保留指定工具。
	 *
	 * 用于 Plan 模式这类需要收窄能力的场景：白名单之外的工具既不声明给模型，也无法经
	 * 注册表执行。顺序沿用原注册表，保证提示词里的工具清单稳定。
	 */
	only(...names: readonly string[]): ToolRegistry {
		for (const name of names) {
			if (!this.#tools.has(name)) {
				throw new Error(`Cannot keep an unknown tool: ${name}`);
			}
		}
		const wanted = new Set(names);
		const copy = new ToolRegistry(this.#spiller, this.#gate);
		for (const [name, item] of this.#tools) {
			if (wanted.has(name)) copy.#tools.set(name, item);
		}
		return copy;
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
		const registration = this.#tools.get(request.name);
		if (registration === undefined) {
			const known = [...this.#tools.keys()].join(", ");
			return error(`Unknown tool: ${request.name}. Available tools: ${known}`);
		}
		const tool = registration.definition;

		// prepareArguments 与 permissionScope 都可能来自插件，它们的异常不能让整轮工具执行
		// 中断：助手消息已经带着调用落进会话，缺一条对应结果会让后续每轮请求都被端点拒绝
		let prepared: Record<string, unknown>;
		try {
			prepared = tool.prepareArguments === undefined ? request.args : tool.prepareArguments(request.args);
		} catch (cause) {
			return error(`Tool argument preparation failed: ${describeError(cause)}`);
		}
		const validated = validateToolArguments(tool.parameters, prepared);
		if (!validated.ok) {
			// 把「收到了什么」一并回显，模型才能判断是自己写错了参数名还是写错了类型
			return error(`Invalid arguments:\n${validated.message}\nReceived arguments: ${JSON.stringify(prepared)}`);
		}

		// 审批判定：校验之后、执行之前。放在校验之后的理由是模型把参数写错时应当直接告诉它，
		// 而不是先弹一次确认再报参数错
		let scope: PermissionScope | undefined;
		try {
			scope =
				tool.permissionScope === undefined
					? { key: tool.name, label: tool.name, short: tool.name }
					: tool.permissionScope(validated.value, context.workspace);
		} catch (cause) {
			return error(`Failed to determine the permission scope, so the call was denied: ${describeError(cause)}`);
		}

		let gateOutcome: GateOutcome;
		try {
			gateOutcome = await this.#gate.check({
				tool: tool.name,
				annotations: tool.annotations,
				args: validated.value,
				source: registration.source,
				scope,
				signal: context.signal,
			});
		} catch (cause) {
			// 判定本身失败时按拒绝处理：检查环节出问题不该等于放行
			return error(`Approval check failed, so the call was denied: ${describeError(cause)}`);
		}
		if (!gateOutcome.allowed) {
			return error(`Not executed: ${gateOutcome.reason}`);
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
				content: `Tool execution failed: ${describeError(error)}`,
				isError: true,
				durationMs: elapsed(startedAt),
			};
		}

		return {
			content: this.#spiller.spill(request.name, result.content),
			isError: result.isError ?? false,
			durationMs: elapsed(startedAt),
			...(result.details === undefined ? {} : { details: result.details }),
		};
	}
}

function error(content: string): ToolCallOutcome {
	return { content, isError: true, durationMs: 0 };
}

function elapsed(startedAt: number): number {
	return Math.max(0, Math.round(performance.now() - startedAt));
}

