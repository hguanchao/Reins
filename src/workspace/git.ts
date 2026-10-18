import { execFileSync } from "node:child_process";

/**
 * 工作区所在的 git 分支。
 *
 * 只问一个只读问题，失败时安静地返回 undefined：不在仓库里、没装 git、仓库损坏都不该挡住
 * 启动。超时给得很短——顶部那行信息不值得让界面等。
 */
export function currentBranch(root: string): string | undefined {
	const branch = run(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
	if (branch !== undefined) return branch;

	// 分离头指针时 symbolic-ref 会失败；rev-parse 这时返回 "HEAD"，说明不在任何分支上
	const detached = run(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return detached === "HEAD" ? "detached" : detached;
}

function run(root: string, args: readonly string[]): string | undefined {
	try {
		const output = execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			timeout: 500,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		}).trim();
		return output.length === 0 ? undefined : output;
	} catch {
		return undefined;
	}
}
