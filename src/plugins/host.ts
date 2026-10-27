import { describeError } from "../shared/describe-error.ts";
import type { PermissionPolicy, PermissionRule } from "../permission/policy.ts";
import type { SandboxBackend } from "../sandbox/policy.ts";
import type { SessionStore } from "../session/store.ts";
import type { AnyToolDefinition } from "../tools/contract.ts";
import type { ToolRegistry, ToolSource } from "../tools/registry.ts";

/**
 * 插件宿主。
 *
 * 插件只能「贡献」，不能「接管」：它把工具、命令、沙箱后端、审批规则投进宿主拥有的注册表，
 * 之后每个条目都要穿过宿主的那条管线。所以交到插件手上的接口里没有设置模型客户端、没有
 * 设置审批方式、也没有改沙箱模式的方法——那些是宿主的安全边界，插件不该有能力放宽自己。
 *
 * 插件之间没有共享的引用，只有宿主：它拿到的 api 是宿主给的，能做的也只是往宿主这里登记。
 *
 * 工具与会话存储、沙箱后端这两类「手段」的替换规则不同：
 * - 工具注册项一律不可同名覆盖。核心工具是「能改代码」这件事本身，被换掉之后使用者很难
 *   察觉，而没有察觉的替换正是最危险的一类改动；插件工具重名同样直接报错，让作者知道
 *   自己没注册成功。
 * - 会话存储与沙箱后端是「同一件事的不同实现」，允许后注册者替换先前的实现。内置实现
 *   先装好，插件随后注册即覆盖——这是「产品自带可用，插件可以换掉」这条设计的落点。
 */

/** 交到插件手上的那部分能力。 */
export interface PluginApi {
	/** 注册一个工具。与已有工具重名会被拒绝，内置工具不能被替换。 */
	registerTool(tool: AnyToolDefinition): void;
	/** 注册一条斜杠命令。 */
	registerCommand(command: PluginCommand): void;
	/** 注册一套平台层面的命令隔离手段。标识相同的会替换先前的实现。 */
	registerSandboxBackend(backend: SandboxBackend): void;
	/** 注册一条审批规则。规则只能加严，不能放行。 */
	registerPermissionRule(rule: PermissionRule): void;
	/** 替换会话的落盘方式。内置实现先装好，后注册的生效。 */
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
	/** 这个插件的装载是否还在进行。结束后再注册就直接生效——已经没有可回滚的对象了 */
	open: boolean;
	/** 这一代是否已经作废。装载失败的插件不该还能往注册表里补东西 */
	stale: boolean;
}

export class PluginHost {
	readonly #tools: ToolRegistry;
	readonly #policy: PermissionPolicy;
	readonly #commands = new Map<string, PluginCommand>();
	readonly #backends: SandboxBackend[] = [];
	#sessionStore: SessionStore | undefined;

	/**
	 * builtins 是产品自带的实现，在构造时就装好。
	 *
	 * 它们与插件注册走同一份容器，因此插件后注册即可替换：这是「默认可用，插件可以换掉」
	 * 这条设计的落点。内置工具不经过这里——工具由装配处直接注册进注册表，且不可被替换。
	 */
	constructor(
		tools: ToolRegistry,
		policy: PermissionPolicy,
		builtins: {
			readonly backends?: readonly SandboxBackend[];
			readonly sessionStore?: SessionStore;
		} = {},
	) {
		this.#tools = tools;
		this.#policy = policy;
		for (const backend of builtins.backends ?? []) this.#addBackend(backend);
		this.#sessionStore = builtins.sessionStore;
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
		return this.#load(plugins, false);
	}

	/**
	 * 装载外部插件。
	 *
	 * 与随包插件分开，因为两者的信任级别不同：外部插件声明的只读工具不能像随包插件那样直接
	 * 放行，必须走审批。启动时装一次就够，改完插件要重启进程才能生效。
	 */
	async loadExternal(plugins: readonly Plugin[]): Promise<readonly PluginFailure[]> {
		return this.#load(plugins, true);
	}

	/**
	 * 宿主自己的命令。
	 *
	 * 与插件命令放在同一份清单里：调用方照同一份清单显示与转发，不必区分谁提供的。
	 */
	addCommand(command: PluginCommand): void {
		if (this.#commands.has(command.name)) throw new Error(`Command /${command.name} is already registered`);
		this.#commands.set(command.name, command);
	}

	backends(): readonly SandboxBackend[] {
		return [...this.#backends];
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
		if (command === undefined) throw new Error(`No such command: /${name}`);
		await command.run(args, context);
	}

	async #load(plugins: readonly Plugin[], external: boolean): Promise<readonly PluginFailure[]> {
		const failures: PluginFailure[] = [];
		// 随包插件与外部插件的信任级别不同：前者的只读声明可以直接放行，后者不能
		const source: ToolSource = external ? "plugin" : "bundled";

		for (const plugin of plugins) {
			const pending = newPending();
			try {
				await plugin.setup(this.#api(pending, source));
				pending.open = false;
				this.#commit(pending, source);
			} catch (error) {
				// 装载失败的那一代同样作废：它不该还能往注册表里补东西
				pending.open = false;
				pending.stale = true;
				failures.push({
					plugin: plugin.name,
					message: describeError(error),
				});
			}
		}

		return failures;
	}

	#api(pending: Pending, source: ToolSource): PluginApi {
		const assertLive = (): void => {
			if (pending.stale) {
				throw new Error("This plugin context is stale: its setup failed, so later registrations are refused");
			}
		};

		return {
			registerTool: (tool) => {
				assertLive();
				if (!pending.open) {
					// 装载已经结束：这是插件在后台拿到能力之后才注册的，直接生效
					this.#tools.register(tool, source);
					return;
				}
				pending.tools.push(tool);
			},
			registerCommand: (command) => {
				assertLive();
				if (this.#commands.has(command.name) || pending.commands.some((item) => item.name === command.name)) {
					throw new Error(`Command /${command.name} is already registered`);
				}
				if (!pending.open) {
					// 与 registerTool 同一规则：装载结束后再注册也要生效，不能静默丢掉
					this.#commands.set(command.name, command);
					return;
				}
				pending.commands.push(command);
			},
			registerSandboxBackend: (backend) => {
				assertLive();
				if (!pending.open) {
					this.#addBackend(backend);
					return;
				}
				pending.backends.push(backend);
			},
			registerPermissionRule: (rule) => {
				assertLive();
				if (!pending.open) {
					this.#policy.addRule(rule);
					return;
				}
				pending.rules.push(rule);
			},
			registerSessionStore: (store) => {
				assertLive();
				// 内置实现已经装好，这里就是「替换」：后注册的生效，条目从此写到这里
				if (!pending.open) {
					this.#sessionStore = store;
					return;
				}
				pending.store = store;
			},
		};
	}

	#commit(pending: Pending, source: ToolSource): void {
		// 先整体预检再逐个提交：中途抛错会让插件处于半装载状态（前面几个工具已经进注册表，
		// 后面的没有），而使用者只看到一句「装载失败」。预检把所有会失败的条件先跑一遍。
		const existing = new Set(this.#tools.list().map((tool) => tool.name));
		for (const tool of pending.tools) {
			if (existing.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered`);
			existing.add(tool.name);
		}

		// 工具先提交：它的重名检查会抛错，抛在这里仍算在该插件名下
		for (const tool of pending.tools) this.#tools.register(tool, source);
		for (const backend of pending.backends) this.#addBackend(backend);
		for (const rule of pending.rules) this.#policy.addRule(rule);
		for (const command of pending.commands) this.#commands.set(command.name, command);
		if (pending.store !== undefined) this.#sessionStore = pending.store;
	}

	/**
	 * 装上一套沙箱后端。
	 *
	 * 标识相同即替换：内置的 seatbelt/bubblewrap 先装好，插件提供同标识的实现时就是「换掉
	 * 这套手段」，而不是让两份实现同时存在、由装配处去猜该用哪个。位置保持不变，这样
	 * 候选顺序仍然稳定。
	 */
	#addBackend(backend: SandboxBackend): void {
		const index = this.#backends.findIndex((item) => item.id === backend.id);
		if (index === -1) {
			this.#backends.push(backend);
			return;
		}
		this.#backends[index] = backend;
	}
}

function newPending(): Pending {
	return {
		tools: [],
		rules: [],
		backends: [],
		commands: [],
		store: undefined,
		open: true,
		stale: false,
	};
}
