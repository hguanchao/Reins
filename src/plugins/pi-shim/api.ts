import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi 扩展运行时 API 的替身。
 *
 * 扩展 `import` 的是 `@earendil-works/pi-coding-agent`，这里补上它用到的那部分：常量、
 * 路径与不依赖宿主的工具函数。真正的 `pi` 对象由 pi-runtime 按扩展逐个构造，不在这里。
 *
 * 只实现能真实对应的东西：`createBashTool` 拿不到 Reins 的 bash 实现，直接抛错好过返回一个
 * 跑不出命令的空壳——扩展替换 bash 之后的行为差异必须当场看见，而不是等到用的时候。
 */

/** pi 的项目配置目录名。扩展用它拼 `.pi/xxx.json` 这类路径。 */
export const CONFIG_DIR_NAME = ".pi";

/** 扩展的配置目录；与 pi 的位置一致，扩展写在里面的文件能原样读到。 */
export function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

/**
 * 同一个文件的写入排队。
 *
 * Reins 没有按文件维度的队列，这里退化为直接执行：并行工具调用同时改一个文件时仍有竞争，
 * 但串行化属于宿主侧的事，扩展这一层拿不到注册表。
 */
export function withFileMutationQueue<T>(_path: string, run: () => Promise<T>): Promise<T> {
	return run();
}

interface ToolCallEvent {
	readonly toolName?: string;
}

/** 判断 tool_call 事件是不是某个工具发出的。 */
export function isToolCallEventType(name: string | readonly string[], event: ToolCallEvent): boolean {
	const names = typeof name === "string" ? [name] : name;
	return event.toolName !== undefined && names.includes(event.toolName);
}

/**
 * 替换内置 bash 的入口。
 *
 * pi 的 `createBashTool` 返回一个完整的工具定义，Reins 拿不到对等的实现；调用即抛错，让
 * 依赖它的扩展在装载时明确失败。
 */
export function createBashTool(_options?: unknown): never {
	throw new Error("createBashTool is not available in Reins");
}
