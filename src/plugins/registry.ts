import type { McpServerConfig } from "../config/config-file.ts";
import type { SessionStore } from "../session/store.ts";
import type { Plugin } from "./host.ts";
import { createMcpPlugin } from "./mcp-plugin/index.ts";
import sandboxPlugin from "./sandbox-plugin/index.ts";
import sessionPlugin, { createSessionStore } from "./session-plugin/index.ts";
import toolsPlugin from "./tools-plugin/index.ts";

/**
 * 组合根。
 *
 * 全项目只有这个文件导入具体的插件：宿主模块只认识插件契约，装配处从这里取清单再驱动生命
 * 周期。这样「宿主不依赖具体插件」这条规则才有落点——依赖方向始终是 plugins 指向宿主，
 * 反过来一次都没有。
 */

export interface BundledPluginContext {
	/** 工作目录：要起外部进程的插件在这里动手 */
	readonly cwd: string;
	/** 本程序自己的版本，握手时用得上 */
	readonly version: string;
	/**
	 * 要连接的 MCP server。
	 *
	 * 只读命令（比如列会话清单）传空数组：为了显示一份清单去起一堆外部进程，既慢又会在使用者
	 * 看不见的地方留下副作用。
	 */
	readonly mcpServers: readonly McpServerConfig[];
}

export function bundledPlugins(context: BundledPluginContext): readonly Plugin[] {
	return [
		toolsPlugin,
		sessionPlugin,
		sandboxPlugin,
		createMcpPlugin({ cwd: context.cwd, version: context.version, servers: context.mcpServers }),
	];
}

/**
 * 只取会话存储。
 *
 * 全屏界面还没读配置、也不需要工具与沙箱，为一个空会话去装载整套插件会连带起 MCP 进程。
 * 会话落盘本身不依赖那些能力，因此单独给一个入口。
 */
export function createBundledSessionStore(): SessionStore {
	return createSessionStore();
}

export { sandboxPlugin, sessionPlugin, toolsPlugin };
