import type { SandboxMode } from "../config/config-file.ts";
import { Sandbox, type SandboxBackend, type SandboxView } from "../sandbox/policy.ts";
import { verifyCommandIsolation } from "../sandbox/verify.ts";

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
export interface SandboxSetup {
	readonly sandbox: SandboxView;
	/** 需要在使用前告知使用者的事项 */
	readonly warnings: readonly string[];
}

export function createSandbox(
	mode: SandboxMode,
	root: string,
	backends: readonly SandboxBackend[],
): SandboxSetup {
	const backend = backends.find((item) => item.available);
	const sandbox = new Sandbox({ mode, root }, backend);
	if (mode === "off") return { sandbox, warnings: [] };

	if (backend === undefined) {
		return {
			sandbox,
			warnings: [
				`沙箱模式为 ${mode}，但当前平台（${process.platform}）没有可用的命令隔离手段：` +
					"读写被限制在规则之内，而 shell 命令会被拒绝执行。" +
					"需要自由执行命令时请把 config.toml 里的 sandbox 设为 off。",
			],
		};
	}

	// 只有在「以为有隔离」的时候才需要核对；核对不过就停下，不要带着虚假的保护继续跑
	verifyCommandIsolation(sandbox, root);
	return { sandbox, warnings: [] };
}
