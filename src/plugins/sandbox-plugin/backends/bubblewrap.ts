import { existsSync } from "node:fs";

import { quoteForShell } from "./shell-quote.ts";
import { delimiter, join } from "node:path";

import type { SandboxBackend, SandboxPolicy } from "../../../sandbox/policy.ts";

/**
 * Linux 的 bubblewrap（bwrap）。
 *
 * 做法是把整个根目录以只读挂进去，再把工作区额外挂成可写。这样除了工作区与显式放开的临时
 * 目录之外，任何地方都写不进去，而读还能照常——命令不至于因为找不到动态库或配置文件而
 * 起不来。
 *
 * 在真实 Linux 上的行为尚未核对过。隔离是否生效由启动时的探针实际验证，所以配错了不会
 * 静默放过。
 */
export class BubblewrapBackend implements SandboxBackend {
	readonly id = "bubblewrap";
	readonly available: boolean;

	constructor() {
		this.available = process.platform === "linux" && isOnPath("bwrap");
	}

	wrap(command: string, policy: SandboxPolicy): string | undefined {
		if (!this.available) return undefined;

		const args = ["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
		if (policy.mode === "workspace") {
			args.push("--bind", policy.root, policy.root);
			// 临时目录单开一层内存盘：编译与测试几乎都要用它，而写进真实的 /tmp
			// 就绕过了「只许改工作区」这条规则
			args.push("--tmpfs", "/tmp");
		}
		args.push("/bin/sh", "-c", quoteForShell(command));
		return args.join(" ");
	}
}

/** 在 PATH 里找一个可执行文件。找不到就不声称自己可用。 */
function isOnPath(name: string): boolean {
	const paths = (process.env["PATH"] ?? "").split(delimiter);
	return paths.some((directory) => directory.length > 0 && existsSync(join(directory, name)));
}

