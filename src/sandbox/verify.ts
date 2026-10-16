import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SandboxView } from "./policy.ts";

/**
 * 核对命令隔离是否真的生效。
 *
 * 隔离后端配错了是很糟的一种情形：看起来开着，实际没拦住，而使用者会因为「我开了沙箱」而更
 * 放心地让模型去做事。所以真正依赖它之前先试一次——往工作区之外写一个文件，写得进去就说明
 * 没隔离住。此时宁可起不来，也不要带着看起来有效的保护继续跑。
 *
 * 探针只写一个自己的临时文件，无论结果如何都会删掉。
 */
export function verifyCommandIsolation(sandbox: SandboxView, root: string): void {
	const probePath = join(dirname(root), `.reins-isolation-probe-${process.pid}`);
	// 包装本身失败就让它抛出去：模式与后端不匹配也是需要在使用前就知道的状态
	const wrapped = sandbox.wrapCommand(`echo probe > ${quoteForShell(probePath)}`);

	let commandSucceeded = true;
	try {
		execSync(wrapped, { stdio: "ignore", timeout: 10_000 });
	} catch {
		// 被拒绝正是期望的结果
		commandSucceeded = false;
	}

	const leaked = existsSync(probePath);
	try {
		rmSync(probePath, { force: true });
	} catch {
		// 清理失败不影响判定，探针文件本身无害
	}

	if (commandSucceeded || leaked) {
		throw new Error(
			`命令隔离没有生效：写入 ${probePath} 本应被拒绝，实际没有被拦住。` +
				"带着看起来开着、实际不管用的隔离继续跑更危险，因此在这里停下。" +
				"请核对 config.toml 里的 sandbox 设置与当前平台的隔离后端。",
		);
	}
}

/**
 * 按当前平台的 shell 规则给路径加引号。
 *
 * 隔离后端只在 macOS 与 Linux 上存在，但这个自检本身要在任何平台上都跑得对：它是可以被
 * 单独验证的逻辑，引号配错会让「拦住了」和「路径写歪了」看起来一模一样。
 */
function quoteForShell(text: string): string {
	if (process.platform === "win32") return `"${text.replaceAll('"', '""')}"`;
	return `'${text.replaceAll("'", "'\\''")}'`;
}
