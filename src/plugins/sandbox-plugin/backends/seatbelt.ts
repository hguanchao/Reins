import { quoteForShell } from "./shell-quote.ts";

import type { SandboxBackend, SandboxPolicy } from "../../../sandbox/policy.ts";

/**
 * macOS 的 seatbelt（sandbox-exec）。
 *
 * 用「先全允许、再禁写」的写法而不是「默认禁止、逐项开白」：后者的白名单很难列全，列漏一项
 * 就会让本来就该跑通的命令失败，而这种失败看起来像是模型做错了事。前一种写法只收紧一件事
 * ——写入，语义清楚，也不会把命令弄得跑不起来。
 *
 * 在真实 macOS 上的行为尚未核对过。隔离是否生效由启动时的探针实际验证，所以配错了不会
 * 静默放过。
 */
export class SeatbeltBackend implements SandboxBackend {
	readonly id = "seatbelt";
	readonly available = process.platform === "darwin";

	wrap(command: string, policy: SandboxPolicy): string | undefined {
		if (!this.available) return undefined;

		const rules = ["(version 1)", "(allow default)", "(deny file-write*)"];
		if (policy.mode === "workspace") {
			rules.push(`(allow file-write* (subpath ${quoteForProfile(policy.root)}))`);
			// 临时目录允许写：编译与测试几乎都要用它，禁止会让工作区模式寸步难行
			rules.push('(allow file-write* (subpath "/tmp"))');
			rules.push('(allow file-write* (subpath "/private/tmp"))');
		}

		return [
			"sandbox-exec",
			"-p",
			quoteForShell(rules.join("\n")),
			"/bin/sh",
			"-c",
			quoteForShell(command),
		].join(" ");
	}
}

/** sandbox 的 profile 里字符串用双引号，内部的双引号与反斜杠要转义。 */
function quoteForProfile(text: string): string {
	return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
