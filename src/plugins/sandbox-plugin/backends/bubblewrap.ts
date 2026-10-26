import { existsSync } from "node:fs";

import { quoteForShell } from "../../../sandbox/shell-quote.ts";
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

		// 每个参数都要做 shell 引用：整条 argv 最终是交给外层 shell 解析的一段文本，
		// 工作区路径里只要有空格或元字符，不引用就会参数错位，甚至在外层 shell 里
		// 先被执行（那时沙箱还没建立）。
		const args = [
			"bwrap",
			"--die-with-parent",
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
		];
		if (policy.mode === "workspace") {
			// tmpfs 必须先挂：工作区可能就在 /tmp 下，后挂的 tmpfs 会把工作区挂载遮蔽掉，
			// 沙箱里看到的是空目录，写入静默丢失。
			args.push("--tmpfs", "/tmp");
			args.push("--bind", policy.root, policy.root);
		}
		args.push("/bin/sh", "-c", command);
		return args.map(quoteForShell).join(" ");
	}
}

/** 在 PATH 里找一个可执行文件。找不到就不声称自己可用。 */
function isOnPath(name: string): boolean {
	const paths = (process.env["PATH"] ?? "").split(delimiter);
	return paths.some((directory) => directory.length > 0 && existsSync(join(directory, name)));
}

