import type { PermissionPolicy, PermissionRule } from "../permission/policy.ts";
import type { SandboxBackend } from "../sandbox/policy.ts";
import type { AnyToolDefinition } from "../tools/contract.ts";
import type { ToolRegistry } from "../tools/registry.ts";

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

interface PendingTool {
	readonly tool: AnyToolDefinition;
	readonly plugin: string;
}

export class PluginHost {
	readonly #tools: ToolRegistry;
	readonly #policy: PermissionPolicy;
	readonly #commands = new Map<string, PluginCommand>();
	readonly #backends: SandboxBackend[] = [];
	/** 装载期间先放在这里，等 setup 正常返回再一起交出去 */
	#pendingTools: PendingTool[] = [];
	#pendingRules: PermissionRule[] = [];
	#pendingBackends: SandboxBackend[] = [];
	#current = "";

	constructor(tools: ToolRegistry, policy: PermissionPolicy) {
		this.#tools = tools;
		this.#policy = policy;
	}

	/**
	 * 依次装载插件。
	 *
	 * 装载期间插件只把条目记进队列，等它的 setup 正常返回后再一起提交。这样插件中途抛错时
	 * 不会留下半注册的状态——一半生效的插件比完全没加载更难看懂，使用者会以为某项能力可用。
	 *
	 * 单个插件失败不影响其余插件：一个写坏的插件不该让整个程序起不来。
	 */
	async load(plugins: readonly Plugin[]): Promise<readonly PluginFailure[]> {
		const failures: PluginFailure[] = [];

		for (const plugin of plugins) {
			this.#current = plugin.name;
			try {
				await plugin.setup(this.#api());
				this.#commit();
			} catch (error) {
				this.#discard();
				failures.push({
					plugin: plugin.name,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}

		this.#current = "";
		return failures;
	}

	backends(): readonly SandboxBackend[] {
		return [...this.#backends];
	}

	commands(): readonly PluginCommand[] {
		return [...this.#commands.values()];
	}

	async runCommand(name: string, args: string, context: CommandContext): Promise<void> {
		const command = this.#commands.get(name);
		if (command === undefined) throw new Error(`没有 /${name} 这条命令`);
		await command.run(args, context);
	}

	#api(): PluginApi {
		return {
			registerTool: (tool) => {
				this.#pendingTools.push({ tool, plugin: this.#current });
			},
			registerCommand: (command) => {
				if (this.#commands.has(command.name)) {
					throw new Error(`命令 /${command.name} 重复注册`);
				}
				this.#commands.set(command.name, command);
			},
			registerSandboxBackend: (backend) => {
				this.#pendingBackends.push(backend);
			},
			registerPermissionRule: (rule) => {
				this.#pendingRules.push(rule);
			},
		};
	}

	#commit(): void {
		// 工具先提交：它的重名检查会抛错，抛在这里仍算在该插件名下
		const tools = this.#pendingTools;
		this.#pendingTools = [];
		for (const item of tools) this.#tools.register(item.tool, "plugin");

		for (const backend of this.#pendingBackends) this.#backends.push(backend);
		this.#pendingBackends = [];

		for (const rule of this.#pendingRules) this.#policy.addRule(rule);
		this.#pendingRules = [];
	}

	#discard(): void {
		this.#pendingTools = [];
		this.#pendingBackends = [];
		this.#pendingRules = [];
	}
}
