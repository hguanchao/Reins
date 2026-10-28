import { execFileSync } from "node:child_process";

/**
 * 代码审查的输入。
 *
 * 审查子代理只看得到任务描述与只读工具，因此这里负责把「审哪一段」变成一份自足的 diff：
 * 默认是工作区相对 HEAD 的改动，也可以指定暂存区、某个基线或某个提交。
 */

/** 审查子代理的默认步数上限；比通用子代理小，审查是收敛的活。 */
export const DEFAULT_REVIEW_STEPS = 12;

/** diff 超过这个字符数就截断；剩下的部分让子代理用 read/grep 自己看。 */
const MAX_DIFF_CHARS = 120_000;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export type ReviewTarget =
	| { readonly kind: "working" }
	| { readonly kind: "staged" }
	| { readonly kind: "base"; readonly ref: string }
	| { readonly kind: "commit"; readonly ref: string };

export interface ReviewContext {
	/** 给使用者看的范围说明，例如 "Working tree" */
	readonly label: string;
	readonly diff: string;
	/** git status --short 的输出；未跟踪文件不进入 diff，但必须让子代理知道 */
	readonly status: string;
	readonly truncated: boolean;
	/** 有 diff 或有未跟踪/已修改文件 */
	readonly hasChanges: boolean;
}

/** 解析 /review 后面的参数；空参数表示工作区相对 HEAD 的改动。 */
export function parseReviewTarget(args: string): ReviewTarget {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "working" };

	const [first, second, ...rest] = tokens;
	if (first === "--staged") {
		if (second !== undefined) throw new Error("--staged does not take extra arguments");
		return { kind: "staged" };
	}
	if (first === "--base" || first === "--commit") {
		if (second === undefined) throw new Error(`${first} requires a git ref`);
		if (rest.length > 0) throw new Error(`${first} takes exactly one git ref`);
		return { kind: first === "--base" ? "base" : "commit", ref: second };
	}
	if (first === undefined) return { kind: "working" };
	if (first.startsWith("-")) throw new Error(`Unknown review option: ${first}`);
	if (second !== undefined) throw new Error("Pass one git ref, or use --staged");
	return { kind: "base", ref: first };
}

/** 读取审查范围。git 失败时抛错，由界面显示原因。 */
export function collectReviewContext(workRoot: string, target: ReviewTarget): ReviewContext {
	const status = git(workRoot, ["status", "--short"]).trim();
	const raw = targetDiff(workRoot, target).trim();
	const truncated = raw.length > MAX_DIFF_CHARS;
	const diff = truncated ? `${raw.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : raw;
	return {
		label: targetLabel(target),
		diff,
		status,
		truncated,
		hasChanges: diff.length > 0 || status.length > 0,
	};
}

/** 审查任务：把范围、状态与 diff 拼成一段自足的说明。 */
export function buildReviewTask(context: ReviewContext): string {
	const parts = [
		"Review the following change. This is a read-only review: do not edit files or run commands that change the workspace.",
		"Focus on correctness, security, regressions, missing tests, and violations of the project's conventions.",
		"Use read, ls, find and grep to inspect the changed files when the diff alone is not enough.",
		"Report findings as a concise Markdown list ordered by severity, with file:line references. If there are no issues, say so explicitly. Do not restate the diff.",
		"",
		`## ${context.label}`,
		"",
		"Working tree status:",
		"```",
		context.status.length > 0 ? context.status : "(clean)",
		"```",
	];
	if (context.diff.length > 0) {
		parts.push("", "Diff:", "```diff", context.diff, "```");
	} else {
		parts.push("", "There is no tracked diff; inspect the untracked files listed above.");
	}
	if (context.truncated) {
		parts.push("", "The diff was truncated; inspect the changed files directly with read and grep.");
	}
	return parts.join("\n");
}

function targetLabel(target: ReviewTarget): string {
	switch (target.kind) {
		case "working":
			return "Working tree";
		case "staged":
			return "Staged changes";
		case "base":
			return `Changes since ${target.ref}`;
		case "commit":
			return `Commit ${target.ref}`;
	}
}

function targetDiff(workRoot: string, target: ReviewTarget): string {
	switch (target.kind) {
		case "working":
			return workingDiff(workRoot);
		case "staged":
			return git(workRoot, ["diff", "--staged"]);
		case "base":
			// 三点比较的是分叉之后的改动；ref 不是分支时退回两点，仍然给出可审的内容
			try {
				return git(workRoot, ["diff", `${target.ref}...HEAD`]);
			} catch {
				return git(workRoot, ["diff", target.ref]);
			}
		case "commit":
			return git(workRoot, ["show", "--format=", "--patch", target.ref]);
	}
}

/** 工作区相对 HEAD 的改动；还没有第一个提交时退回「未暂存 + 已暂存」。 */
function workingDiff(workRoot: string): string {
	try {
		return git(workRoot, ["diff", "HEAD"]);
	} catch {
		const unstaged = git(workRoot, ["diff"]);
		const staged = git(workRoot, ["diff", "--staged"]);
		return [unstaged, staged].filter((part) => part.length > 0).join("\n");
	}
}

function git(workRoot: string, args: readonly string[]): string {
	try {
		return execFileSync("git", args, {
			cwd: workRoot,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
}
