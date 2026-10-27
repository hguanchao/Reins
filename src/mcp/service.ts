import { describeError } from "../shared/describe-error.ts";
import type { McpServerConfig } from "../config/file.ts";
import type { AnyToolDefinition, ToolResult } from "../tools/contract.ts";
import { CONTROL_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS, McpClient, type McpToolInfo } from "./client.ts";
import {
	createHttpTransport,
	createSseTransport,
	createStdioTransport,
	type McpTransport,
} from "./transport.ts";

/**
 * MCP 客户端。
 *
 * 接入的是进程外的东西——本地的 server 进程、远端的端点。连接在后台进行：连不上不能挡启动，
 * 使用者还能干别的活，失败原因进 /mcps 的清单。这也是「工具清单会变」的唯一来源——连上之后
 * 才知道远端有哪些工具，那些工具在下一次请求前补进会话的工具声明里。
 *
 * 这里的工具与核心工具受完全相同的约束：它们注册进同一个注册表，走同一条管线，审批与沙箱
 * 一样不少。本模块能做的只是「告诉宿主远端有什么」，管不到判定。
 *
 * 它本身是宿主能力，不依赖插件宿主：装配处把「收到工具就登记」这件事作为回调传进来，
 * 这样即使插件层整个不可用，MCP 也照常工作。
 */

/** 一个 server 当前的状态，交给界面排版用。 */
interface McpStatus {
	readonly name: string;
	/** connecting / connected / unreachable / disabled */
	readonly status: string;
	/** 补充说明：工具数量、失败原因；没有可说的就是空串 */
	readonly detail: string;
}

export type McpStatusSource = () => readonly McpStatus[];

/** 远端连上之后把工具交出去的方式。由装配处决定它落到哪张注册表、按哪个来源记账。 */
export type McpToolSink = (tool: AnyToolDefinition) => void;

interface McpServiceOptions {
	/** 工作目录：stdio 型的 server 在这里起子进程 */
	readonly cwd: string;
	/** 本程序自己的版本，握手里报给服务端 */
	readonly version: string;
	readonly servers: readonly McpServerConfig[];
	/** 每连上一个 server，把它的工具逐个交出去 */
	readonly registerTool: McpToolSink;
	/**
	 * 把连接清单交出去。
	 *
	 * `/mcps` 是整屏页，要按终端宽度排版；服务本身只产出数据，排版交给界面。
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

	async start(registerTool: McpToolSink): Promise<void> {
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
				registerTool(
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

/**
 * 连上配置里列出的 server，并把它们的工具交出去。
 *
 * 返回的清单读取函数是实时的：调用时才去问每个连接当前的状态，因此界面刷新时能看见
 * 「connecting → connected」的变化。
 */
export function startMcpServers(options: McpServiceOptions): McpStatusSource {
	const connections = options.servers.map(
		(server) => new McpConnection(server, options.cwd, options.version),
	);

	const source: McpStatusSource = () => connections.map((connection) => connection.status());
	// 清单交给装配处，再由它转给界面：/mcps 要在整屏页里按宽度排版
	options.onStatus?.(source);

	// 后台连接：不 await，连不上的进 /mcps 的清单，不挡启动
	for (const connection of connections) void connection.start(options.registerTool);
	return source;
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

