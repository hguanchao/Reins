import type { Plugin, PluginApi } from "../host.ts";
import { BubblewrapBackend } from "./backends/bubblewrap.ts";
import { SeatbeltBackend } from "./backends/seatbelt.ts";

/**
 * 沙箱后端插件。
 *
 * 这里提供的是操作系统层面的手段：macOS 的 seatbelt、Linux 的 bubblewrap。「哪个平台有什么」
 * 属于平台知识，会随系统变化，所以做成插件；而「什么情况下允许写哪个路径」属于安全判定，
 * 留在宿主里。插件只提供手段，不改判定。
 *
 * 没有对应实现是正常状态：这时模式只要不是 off，命令就会被拒绝执行，而不是退回到不隔离。
 */
const name = "sandbox-plugin";

function setup(api: PluginApi): void {
	api.registerSandboxBackend(new SeatbeltBackend());
	api.registerSandboxBackend(new BubblewrapBackend());
}

export default { name, setup } satisfies Plugin;
