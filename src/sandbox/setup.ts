import type { SandboxMode } from "#src/config/file.ts";
import { describeError } from "#src/shared/describe-error.ts";
import { Sandbox, type SandboxBackend, type SandboxView } from "#src/sandbox/policy.ts";
import { verifyCommandIsolation } from "#src/sandbox/verify.ts";

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

interface SandboxSetup {
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
	if (mode === "off") {
		const sandbox = new Sandbox({ mode, root }, undefined);
		return {
			sandbox,
			warnings: [],
			info: { mode, platform: process.platform, confinesCommands: sandbox.confinesCommands },
		};
	}

	// 逐个尝试可用后端：前一个自检不过不等于这台机器没有隔离能力。只试第一个会让
	// 「声称可用但起不来」的后端挡住后面真正能用的那个。
	const candidates = backends.filter((item) => item.available);
	const failures: string[] = [];
	for (const backend of candidates) {
		const sandbox = new Sandbox({ mode, root }, backend);
		try {
			verifyCommandIsolation(sandbox, root);
		} catch (error) {
			failures.push(`${backend.id}: ${describeError(error)}`);
			continue;
		}
		return {
			sandbox,
			warnings: [],
			info: {
				mode,
				platform: process.platform,
				confinesCommands: sandbox.confinesCommands,
				backend: backend.id,
			},
		};
	}

	if (candidates.length === 0) {
		const sandbox = new Sandbox({ mode, root }, undefined);
		return {
			sandbox,
			info: { mode, platform: process.platform, confinesCommands: sandbox.confinesCommands },
			warnings: [
				`Sandbox mode is ${mode} but this platform (${process.platform}) has no usable command isolation: ` +
					"path checks still apply, and shell commands are refused. " +
					"To run commands freely, set sandbox to off in config.toml",
			],
		};
	}

	// 所有候选都没通过自检：把每一个的失败原因都说出来，否则使用者只知道「起不来」，
	// 不知道该修哪个后端
	throw new Error(
		`Command isolation is not working with any available backend. ` +
			`Continuing with isolation that looks on but does nothing is more dangerous, so stopping here. ` +
			`Backends tried:\n${failures.map((line) => `  ${line}`).join("\n")}`,
	);
}
