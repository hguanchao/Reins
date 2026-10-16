import type { PermissionPolicy, PermissionRule } from "../permission/policy.ts";
import type { SandboxBackend } from "../sandbox/policy.ts";
import type { SessionStore } from "../session/store.ts";
import type { AnyToolDefinition } from "../tools/contract.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { InteractiveFrontend } from "../tui/frontend.ts";

/**
 * 插件宿主。
 *
 * 插件只能「贡献」，不能「接管」：它把工具、命令、沙箱后端、审批规则投进宿主拥有的注册表，
 * 之后每个条目都要穿过宿主的那条管线。所以交到插件手上的接口里没有设置模型客户端、没有
 * 设置审批方式、也没有改沙箱模式的方法——那些是宿主的安全边界，插件不该有能力放宽自己。
 */

/** 交到插件手上的那部分能力。 */
export interface PluginApi {
	/** 注册一个工具。与核心工具重名会被拒绝。 */
	registerTool(tool: AnyToolDefinition): void;
	/** 注册一条斜杠命令。 */
	registerCommand(command: PluginCommand): void;
	/** 注册一套平台层面的命令隔离手段。 */
	registerSandboxBackend(backend: SandboxBackend): void;
	/** 注册一条审批规则。规则只能加严，不能放行。 */
	registerPermissionRule(rule: PermissionRule): void;
	/** 提供一个交互形态。只能有一个：两套界面同时抢终端，谁也画不清楚。 */
	registerFrontend(frontend: InteractiveFrontend): void;
	/** 提供会话的落盘方式。只能有一个，否则条目该写到哪里就没有定论。 */
	registerSessionStore(store: SessionStore): void;
}

export interface Plugin {
	/** 插件标识，与目录名一致 */
	readonly name: string;
	/** 装载。同步或异步都可以。 */
	setup(api: PluginApi): void | Promise<void>;
}

export interface PluginCommand {
	readonly name: string;
	readonly description: string;
	/** 命令要做的事。args 是命令名之后的那段文字。 */
	run(args: string, context: CommandContext): Promise<void>;
}

/** 命令能拿到的东西。命令在会话空闲时执行，因此没有中止信号。 */
export interface CommandContext {
	readonly cwd: string;
	/** 输出一行给使用者 */
	readonly print: (line: string) => void;
}

export interface PluginFailure {
	readonly plugin: string;
	readonly message: string;
}

/**
 * 一个插件的待提交项。
 *
 * 每个插件各有一份，而不是共用几个字段：插件可以在装载结束之后继续注册工具（远端连上之后
 * 才知道自己有哪些能力），共用字段会让那些迟到的注册落进另一个插件的队列里，跟着它一起
 * 提交或一起回滚。
 */
interface Pending {
	readonly tools: AnyToolDefinition[];
	readonly rules: PermissionRule[];
	readonly backends: SandboxBackend[];
	readonly commands: PluginCommand[];
	store: SessionStore | undefined;
	frontend: InteractiveFrontend | undefined;
	/** 这个插件的装载是否还在进行。结束后再注册就直接生效——已经没有可回滚的对象了 */
	open: boolean;
}

export class PluginHost {
	readonly #tools: ToolRegistry;
	readonly #policy: PermissionPolicy;
	readonly #commands = new Map<string, PluginCommand>();
	readonly #backends: SandboxBackend[] = [];
	#frontend: InteractiveFrontend | undefined;
	#sessionStore: SessionStore | undefined;

	constructor(tools: ToolRegistry, policy: PermissionPolicy) {
		this.#tools = tools;
		this.#policy = policy;
	}

	/**
	 * 依次装载插件。
	 *
	 * 装载期间插件只把条目记进自己的队列，等它的 setup 正常返回后再一起提交。这样插件中途
	 * 抛错时不会留下半注册的状态——一半生效的插件比完全没加载更难看懂，使用者会以为某项
	 * 能力可用。
	 *
	 * 单个插件失败不影响其余插件：一个写坏的插件不该让整个程序起不来。
	 */
	async load(plugins: readonly Plugin[]): Promise<readonly PluginFailure[]> {
		const failures: PluginFailure[] = [];

		for (const plugin of plugins) {
			const pending = newPending();
			try {
				await plugin.setup(this.#api(pending));
				pending.open = false;
				this.#commit(pending);
			} catch (error) {
				pending.open = false;
				failures.push({
					plugin: plugin.name,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return failures;
	}

	backends(): readonly SandboxBackend[] {
		return [...this.#backends];
	}

	/** 交互形态。没有任何插件提供时返回 undefined，调用方据此明确报错。 */
	frontend(): InteractiveFrontend | undefined {
		return this.#frontend;
	}

	/** 会话存储。没有插件提供时返回 undefined，调用方据此退回内存会话并明确说出来。 */
	sessionStore(): SessionStore | undefined {
		return this.#sessionStore;
	}

	commands(): readonly PluginCommand[] {
		return [...this.#commands.values()];
	}

	async runCommand(name: string, args: string, context: CommandContext): Promise<void> {
		const command = this.#commands.get(name);
		if (command === undefined) throw new Error(`没有 /${name} 这条命令`);
		await command.run(args, context);
	}

	#api(pending: Pending): PluginApi {
		return {
			registerTool: (tool) => {
				if (!pending.open) {
					// 装载已经结束：这是插件在后台拿到能力之后才注册的，直接生效
					this.#tools.register(tool, "plugin");
					return;
				}
				pending.tools.push(tool);
			},
			registerCommand: (command) => {
				if (this.#commands.has(command.name) || pending.commands.some((item) => item.name === command.name)) {
					throw new Error(`命令 /${command.name} 重复注册`);
				}
				pending.commands.push(command);
			},
			registerSandboxBackend: (backend) => {
				pending.backends.push(backend);
			},
			registerPermissionRule: (rule) => {
				pending.rules.push(rule);
			},
			registerFrontend: (frontend) => {
				if (this.#frontend !== undefined || pending.frontend !== undefined) {
					throw new Error("交互界面已经注册过了，只能有一个");
				}
				pending.frontend = frontend;
			},
			registerSessionStore: (store) => {
				if (this.#sessionStore !== undefined || pending.store !== undefined) {
					throw new Error("会话存储已经注册过了，只能有一个");
				}
				pending.store = store;
			},
		};
	}

	#commit(pending: Pending): void {
		// 工具先提交：它的重名检查会抛错，抛在这里仍算在该插件名下
		for (const tool of pending.tools) this.#tools.register(tool, "plugin");
		for (const backend of pending.backends) this.#backends.push(backend);
		for (const rule of pending.rules) this.#policy.addRule(rule);
		for (const command of pending.commands) this.#commands.set(command.name, command);
		if (pending.store !== undefined) this.#sessionStore = pending.store;
		if (pending.frontend !== undefined) this.#frontend = pending.frontend;
	}
}

function newPending(): Pending {
	return { tools: [], rules: [], backends: [], commands: [], store: undefined, frontend: undefined, open: true };
}
