import { describeError } from "../../shared/describe-error.ts";
import type { McpServerConfig } from "../../config/file.ts";
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

/** 一个 server 当前的状态，交给界面排版用。 */
export interface McpStatus {
	readonly name: string;
	/** connecting / connected / unreachable / disabled */
	readonly status: string;
	/** 补充说明：工具数量、失败原因；没有可说的就是空串 */
	readonly detail: string;
}

export type McpStatusSource = () => readonly McpStatus[];

export interface McpPluginOptions {
	/** 工作目录：stdio 型的 server 在这里起子进程 */
	readonly cwd: string;
	/** 本程序自己的版本，握手里报给服务端 */
	readonly version: string;
	readonly servers: readonly McpServerConfig[];
	/**
	 * 把连接清单交出去。
	 *
	 * `/mcps` 是整屏页，要按终端宽度排版；插件命令只能吐纯文本行，宽度它看不到。因此清单
	 * 从这里交给装配处，再由装配处转给界面。
	 */
	readonly onStatus?: (source: McpStatusSource) => void;
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
	/** 远程连接的生命周期信号:连接失败时中止它,在途的 fetch 与 SSE 才会真正断开。 */
	#connectionAbort: AbortController | undefined;

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
				callTimeoutMs:
					this.#config.timeoutSeconds === undefined
						? DEFAULT_CALL_TIMEOUT_MS
						: this.#config.timeoutSeconds * 1000,
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
			// 失败了就中止连接信号:不中止的话在途的 fetch 与 SSE 会一直挂到对端关闭
			this.#connectionAbort?.abort();
			this.#connectionAbort = undefined;
		}
	}

	/** 一行清单。连不上的必须把原因说出来，否则使用者只知道「没连上」。 */
	status(): McpStatus {
		switch (this.#status) {
			case "disabled":
				return { name: this.name, status: "disabled", detail: "" };
			case "connecting":
				return { name: this.name, status: "connecting", detail: "" };
			case "ready": {
				const detail = this.#tools.length === 0
					? "no tools"
					: `${this.#tools.length} tools: ${this.#tools.join(", ")}`;
				return { name: this.name, status: "connected", detail };
			}
			case "failed":
				return { name: this.name, status: "unreachable", detail: this.#failure };
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
		this.#connectionAbort = new AbortController();
		if (config.type === "sse") {
			return createSseTransport({ ...options, signal: this.#connectionAbort.signal });
		}
		return createHttpTransport({ ...options, signal: this.#connectionAbort.signal });
	}
}

export function createMcpPlugin(options: McpPluginOptions): Plugin {
	return {
		name: "mcp-plugin",
		setup(api) {
			const connections = options.servers.map(
				(server) => new McpConnection(server, options.cwd, options.version),
			);

			// 清单交给装配处，再由它转给界面：/mcps 要在整屏页里按宽度排版
			options.onStatus?.(() => connections.map((connection) => connection.status()));

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

