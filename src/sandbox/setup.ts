import type { SandboxMode } from "../config/file.ts";
import { Sandbox, type SandboxBackend, type SandboxView } from "./policy.ts";
import { verifyCommandIsolation } from "./verify.ts";

/**
 * 沙箱当前的实际情况。
 *
 * 界面需要的只是「现在处于什么模式、这台机器能做到哪一步」，而不是拿 Sandbox 的私有状态。
 * 平台名与后端标识都原样给出，显示成什么由界面决定。
 */
export interface SandboxInfo {
	readonly mode: SandboxMode;
	/** 取自 process.platform，界面自己转成可读的平台名 */
	readonly platform: string;
	/** 真正可用的命令隔离手段；模式为 off 或本平台没有时为空 */
	readonly backend?: string;
	/** 命令能否被约束；off 表示不需要约束，没有后端时为 false */
	readonly confinesCommands: boolean;
}

export interface SandboxSetup {
	readonly sandbox: SandboxView;
	/** 需要在使用前告知使用者的事项 */
	readonly warnings: readonly string[];
	/** 模式与平台能力的只读快照，供 /sandbox 页展示 */
	readonly info: SandboxInfo;
}

/**
 * 按配置与可用的平台手段装配沙箱。
 *
 * 三件事在这里定下来：
 * 一、路径判定与命令隔离是两件事。前者与平台无关，任何平台都在生效；后者要靠操作系统的
 *     手段，没有就是没有。
 * 二、没有平台手段时不会退回到不隔离：命令会被拒绝执行，而读写仍然受路径判定的约束。
 *     使用者得到的是「部分保护 + 明确的限制」，不是「以为有保护其实没有」。
 * 三、一旦声称有隔离手段，就先真的试一次。声称了却不管用比不声称更危险。
 */
export function createSandbox(
	mode: SandboxMode,
	root: string,
	backends: readonly SandboxBackend[],
): SandboxSetup {
	const backend = backends.find((item) => item.available);
	const sandbox = new Sandbox({ mode, root }, backend);
	const info: SandboxInfo = {
		mode,
		platform: process.platform,
		confinesCommands: sandbox.confinesCommands,
		...(mode === "off" || backend === undefined ? {} : { backend: backend.id }),
	};
	if (mode === "off") return { sandbox, warnings: [], info };

	if (backend === undefined) {
		return {
			sandbox,
			info,
			warnings: [
				`Sandbox mode is ${mode} but this platform (${process.platform}) has no usable command isolation: ` +
					"path checks still apply, and shell commands are refused. " +
					"To run commands freely, set sandbox to off in config.toml",
			],
		};
	}

	// 只有在「以为有隔离」的时候才需要核对；核对不过就停下，不要带着虚假的保护继续跑
	verifyCommandIsolation(sandbox, root);
	return { sandbox, warnings: [], info };
}
