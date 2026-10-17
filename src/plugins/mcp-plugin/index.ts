import type { McpServerConfig } from "../../config/config-file.ts";
import type { AnyToolDefinition, ToolResult } from "../../tools/contract.ts";
import type { Plugin, PluginApi } from "../host.ts";
import { CONTROL_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS, McpClient, type McpToolInfo } from "./client.ts";
import {
	createHttpTransport,
	createSseTransport,
	createStdioTransport,
	type McpTransport,
} from "./transport.ts";

/**
 * MCP 插件。
 *
 * 接入的是进程外的东西——本地的 server 进程、远端的端点——所以按插件的标准分发：关掉它之后
 * 产品完整可用，只是少了这些外部能力。
 *
 * 连接在后台进行：连不上不能挡启动，使用者还能干别的活，失败原因进 /mcps 的清单。这也是
 * 「工具清单会变」的唯一来源——连上之后才知道远端有哪些工具，那些工具在下一次请求前补进
 * 会话的工具声明里。
 *
 * 这里的工具与核心工具受完全相同的约束：它们注册进同一个注册表，走同一条管线，审批与沙箱
 * 一样不少。插件能做的只是「告诉宿主远端有什么」，管不到判定。
 */

export interface McpPluginOptions {
	/** 工作目录：stdio 型的 server 在这里起子进程 */
	readonly cwd: string;
	/** 本程序自己的版本，握手里报给服务端 */
	readonly version: string;
	readonly servers: readonly McpServerConfig[];
}

type ConnectionStatus = "connecting" | "ready" | "failed" | "disabled";

/** 一个 MCP server 的连接。 */
class McpConnection {
	readonly #config: McpServerConfig;
	readonly #cwd: string;
	readonly #version: string;
	#status: ConnectionStatus;
	#failure = "";
	#tools: readonly string[] = [];
	#client: McpClient | undefined;

	constructor(config: McpServerConfig, cwd: string, version: string) {
		this.#config = config;
		this.#cwd = cwd;
		this.#version = version;
		this.#status = config.disabled ? "disabled" : "connecting";
	}

	get name(): string {
		return this.#config.name;
	}

	async start(api: PluginApi): Promise<void> {
		if (this.#status === "disabled") return;

		try {
			const client = new McpClient({
				transport: this.#createTransport(),
				clientName: "reins",
				version: this.#version,
				controlTimeoutMs: CONTROL_TIMEOUT_MS,
				callTimeoutMs: this.#config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
			});
			this.#client = client;

			await client.connect();
			const tools = await client.listTools();
			for (const tool of tools) {
				api.registerTool(
					createMcpTool(this.#config.name, tool, (name, args, signal) =>
						this.#call(name, args, signal),
					),
				);
			}
			this.#tools = tools.map((tool) => tool.name);
			this.#status = "ready";
		} catch (error) {
			this.#status = "failed";
			// 传输层往往比请求失败更早知道原因（进程起不来、端点连不上），它记下的那句更具体：
			// 请求那边只会看到「连接断了」，看不出到底为什么
			if (this.#failure.length === 0) this.#failure = describeError(error);
		}
	}

	/** 一行清单。连不上的必须把原因说出来，否则使用者只知道「没连上」。 */
	describe(): string {
		const name = this.name.padEnd(16);
		switch (this.#status) {
			case "disabled":
				return `${name} disabled`;
			case "connecting":
				return `${name} connecting`;
			case "ready": {
				const tools = this.#tools.length === 0
					? "no tools"
					: `${this.#tools.length} tools: ${this.#tools.join(", ")}`;
				return `${name} connected  ${tools}`;
			}
			case "failed":
				return `${name} unreachable  ${this.#failure}`;
		}
	}

	async #call(
		name: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ readonly content: string; readonly isError: boolean }> {
		const client = this.#client;
		if (client === undefined || this.#status !== "ready") {
			return {
				content: `MCP server ${this.name} is unavailable: ${this.#failure.length > 0 ? this.#failure : "not connected yet"}`,
				isError: true,
			};
		}
		return client.callTool(name, args, signal);
	}

	#createTransport(): McpTransport {
		// 连接断掉之后工具还在注册表里：留着它，调用时会得到一句「当前不可用」，
		// 比让工具凭空消失更好查——工具消失只会表现为「模型忽然不调它了」
		const onClose = (reason: string): void => {
			this.#failure = reason;
			if (this.#status === "ready") this.#status = "failed";
		};

		const config = this.#config;
		if (config.type === "stdio") {
			return createStdioTransport({
				command: config.command ?? "",
				args: config.args,
				cwd: this.#cwd,
				onClose,
			});
		}

		const options = { url: config.url ?? "", headers: config.headers, onClose };
		if (config.type === "sse") {
			return createSseTransport({ ...options, signal: new AbortController().signal });
		}
		return createHttpTransport({ ...options, signal: new AbortController().signal });
	}
}

export function createMcpPlugin(options: McpPluginOptions): Plugin {
	return {
		name: "mcp-plugin",
		setup(api) {
			const connections = options.servers.map(
				(server) => new McpConnection(server, options.cwd, options.version),
			);

			api.registerCommand({
				name: "mcps",
				description: "Show MCP server connections and their tools",
				async run(_args, context) {
					if (connections.length === 0) {
						context.print("No MCP servers configured. Add [mcp_servers.<name>] to config.toml.");
						return;
					}
					for (const connection of connections) context.print(connection.describe());
				},
			});

			// 后台连接：不 await，连不上的进 /mcps 的清单，不挡启动
			for (const connection of connections) void connection.start(api);
		},
	};
}

/**
 * 把远端工具包装成工具定义。
 *
 * 名字加 server 前缀：两个 server 各有一个 search 是常事，不加前缀就只能看着后注册的那个
 * 被拒。加了前缀模型看到的也是带前缀的名字，它就知道该找哪个 server。
 *
 * 声明一律按最保守的一侧写。远端自己声明的「只读」「不具破坏性」不当安全依据：声明只读
 * 就能跳过审批的话，一个说谎的 server 等于给自己开了后门。
 */
function createMcpTool(
	server: string,
	info: McpToolInfo,
	call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{
		readonly content: string;
		readonly isError: boolean;
	}>,
): AnyToolDefinition {
	const description =
		info.description.length > 0 ? `[MCP ${server}] ${info.description}` : `[MCP ${server}] remote tool ${info.name}`;

	return {
		name: `${server}_${info.name}`,
		description,
		parameters: info.inputSchema,
		annotations: { readOnly: false, destructive: true, openWorld: true },
		async execute(context): Promise<ToolResult> {
			const result = await call(info.name, context.args, context.signal);
			return { content: result.content, isError: result.isError };
		},
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
