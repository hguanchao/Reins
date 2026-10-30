import { BubblewrapBackend } from "#src/sandbox/backends/bubblewrap.ts";
import { SeatbeltBackend } from "#src/sandbox/backends/seatbelt.ts";
import type { SandboxBackend } from "#src/sandbox/policy.ts";
import { JsonlSessionStore } from "#src/session/jsonl-store.ts";
import type { SessionStore } from "#src/session/store.ts";

/**
 * 产品自带的实现。
 *
 * 这几项能力的产品语义都在宿主里（沙箱判定、会话条目与折叠、工具管线），只有「用什么手段
 * 落地」是可换的：命令隔离靠哪个操作系统设施、条目写成哪种文件格式。它们默认全部装好，
 * 产品不依赖任何插件就能完整工作；插件随后注册同标识的实现即可替换。
 *
 * 工具不在这个清单里：核心工具由装配处直接注册进注册表，且不允许被插件替换。
 */

/** 内置的沙箱后端。顺序即候选顺序：前一个自检不过时接着试下一个。 */
export function builtinSandboxBackends(): readonly SandboxBackend[] {
	return [new SeatbeltBackend(), new BubblewrapBackend()];
}

/** 内置的会话存储：以 JSONL 落盘。 */
export function builtinSessionStore(): SessionStore {
	return new JsonlSessionStore();
}
