import { execFileSync } from "node:child_process";

/**
 * 工作区的只读 git 查询。
 *
 * 只做 status / diff / branch 这三件只读的事：提交、切换分支、推送都会改动使用者的仓库，
 * 不在浏览器界面里偷偷做。任何失败都安静地返回 undefined——不在仓库、没装 git、仓库损坏
 * 都不该让界面报错。
 */

/** 一次 diff 最多返回这么多字符；再长的内容在面板里也读不完。 */
const MAX_DIFF_CHARS = 512 * 1024;

export interface GitFileChange {
	readonly path: string;
	/** 暂存区状态字符：M/A/D/R/C/U/? 或空格 */
	readonly index: string;
	/** 工作区状态字符 */
	readonly worktree: string;
	readonly staged: boolean;
	readonly kind: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted" | "unknown";
	/** 重命名/复制时的原路径 */
	readonly from?: string;
}

export interface GitStatus {
	readonly branch: string | undefined;
	readonly upstream: string | undefined;
	readonly ahead: number;
	readonly behind: number;
	readonly files: readonly GitFileChange[];
}

/** 当前分支；分离头指针时返回 "detached"。 */
export function currentBranch(root: string): string | undefined {
	const branch = run(root, ["symbolic-ref", "--short", "-q", "HEAD"], 500);
	if (branch !== undefined) return branch;

	// 分离头指针时 symbolic-ref 会失败；rev-parse 这时返回 "HEAD"，说明不在任何分支上
	const detached = run(root, ["rev-parse", "--abbrev-ref", "HEAD"], 500);
	return detached === "HEAD" ? "detached" : detached;
}

/**
 * 仓库状态。
 *
 * 用 porcelain v1 的 NUL 分隔格式：路径里可以有空格与换行，按行切会把它们拆坏。重命名条目
 * 在 -z 下占两个字段（目标在前、原路径在后），解析时要把后一个字段一并消费掉。
 */
export function gitStatus(root: string): GitStatus | undefined {
	const output = run(root, ["status", "--porcelain=v1", "-z", "--branch"], 2000, 16 * 1024 * 1024);
	if (output === undefined) return undefined;

	const fields = output.split("\0").filter((field) => field.length > 0);
	let branch: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	const files: GitFileChange[] = [];

	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index] as string;
		if (field.startsWith("## ")) {
			const header = parseBranchHeader(field.slice(3));
			branch = header.branch;
			upstream = header.upstream;
			ahead = header.ahead;
			behind = header.behind;
			continue;
		}
		if (field.length < 3) continue;

		const indexStatus = field[0] as string;
		const worktreeStatus = field[1] as string;
		const path = field.slice(3);
		let from: string | undefined;
		if (indexStatus === "R" || indexStatus === "C") {
			const source = fields[index + 1];
			if (source !== undefined) {
				from = source;
				index += 1;
			}
		}

		files.push({
			path,
			index: indexStatus,
			worktree: worktreeStatus,
			staged: indexStatus !== " " && indexStatus !== "?",
			kind: changeKind(indexStatus, worktreeStatus),
			...(from === undefined ? {} : { from }),
		});
	}

	return { branch, upstream, ahead, behind, files };
}

/** 单文件 diff；staged 为 true 时看暂存区与 HEAD 的差异。 */
export function gitDiff(root: string, path: string, staged: boolean): string | undefined {
	const args = ["diff", "--no-color", "--no-ext-diff", "--unified=3"];
	if (staged) args.push("--cached");
	args.push("--", path);
	const output = run(root, args, 5000, 8 * 1024 * 1024);
	if (output === undefined) return undefined;
	return output.length > MAX_DIFF_CHARS ? `${output.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : output;
}

interface BranchHeader {
	readonly branch: string | undefined;
	readonly upstream: string | undefined;
	readonly ahead: number;
	readonly behind: number;
}

function parseBranchHeader(header: string): BranchHeader {
	// "main...origin/main [ahead 1, behind 2]" / "main" / "HEAD (no branch)"
	const match = /^(.*?)(?:\.\.\.(.*?))?(?: \[(.*?)\])?$/.exec(header);
	if (match === null) return { branch: header, upstream: undefined, ahead: 0, behind: 0 };

	let branch = match[1] ?? "";
	if (branch === "HEAD (no branch)") branch = "detached";
	// 还没有任何提交时标题是 "No commits yet on main"
	if (branch.startsWith("No commits yet on ")) branch = branch.slice("No commits yet on ".length);

	const upstream = match[2];
	const counts = match[3] ?? "";
	const ahead = /ahead (\d+)/.exec(counts)?.[1];
	const behind = /behind (\d+)/.exec(counts)?.[1];
	return {
		branch: branch.length === 0 ? undefined : branch,
		upstream: upstream === undefined || upstream.length === 0 ? undefined : upstream,
		ahead: ahead === undefined ? 0 : Number(ahead),
		behind: behind === undefined ? 0 : Number(behind),
	};
}

function changeKind(index: string, worktree: string): GitFileChange["kind"] {
	if (index === "?" || worktree === "?") return "untracked";
	if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) {
		return "conflicted";
	}
	if (index === "R" || worktree === "R" || index === "C" || worktree === "C") return "renamed";
	if (index === "A" || worktree === "A") return "added";
	if (index === "D" || worktree === "D") return "deleted";
	if (index === "M" || worktree === "M") return "modified";
	return "unknown";
}

function run(
	root: string,
	args: readonly string[],
	timeout: number,
	maxBuffer = 4 * 1024 * 1024,
): string | undefined {
	try {
		const output = execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			timeout,
			maxBuffer,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		}).trim();
		return output.length === 0 ? "" : output;
	} catch {
		return undefined;
	}
}
