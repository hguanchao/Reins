/**
 * 命令的折叠摘要。
 *
 * 模型习惯在命令开头写 `cd <工作根> &&`，而命令本来就在工作根下执行：这一段是空操作，
 * 每条都带着它会把真正要看的部分挤出屏幕。剥掉之后只留第一段命令，管道与重定向是它的
 * 处理方式而不是它本身，完整命令留给展开显示。
 */

/** 复合结构不能按分隔符切开：切开就只剩半句话，反而看不懂。 */
const COMPOUND_START = /^(?:for|while|until|if|case)\b/;

/** `cd <路径>` 之后跟着另一个命令时，路径与命令之间必有这两个分隔符之一。 */
const CD_PREFIX = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;)\s*/;

/** 段尾的重定向：`2>&1`、`> /dev/null`、`< in.txt`。 */
const REDIRECTION_TAIL = /(?:\s+(?:\d?>>?|<<?|&>)\s*\S+)+$/;

/**
 * 折叠态显示的核心命令。
 *
 * 多余的工作根 `cd` 剥掉；进了子目录的 `cd` 留成 `[目录]` 前缀，因为它确实改变了命令在哪
 * 里执行。剥完只剩提示用的 echo 时跳过它，取下一条有实际内容的命令。
 */
export function commandCore(command: string, workspaceRoot?: string): string {
	const rest = peelWorkspaceCd(command.trim(), workspaceRoot);
	if (rest.length === 0) return command.trim();
	if (COMPOUND_START.test(rest)) return rest;

	const segments = splitSegments(rest);
	const scope = segments.length > 1 ? scopeOf(segments[0] ?? "", workspaceRoot) : undefined;
	// 首段是 cd 却给不出作用域标签（指向别处）时，整条命令原样保留：只留 cd 会丢掉真正要跑的命令
	if (segments.length > 1 && isCdSegment(segments[0] ?? "") && scope === undefined) return rest;
	const candidates = scope === undefined ? segments : segments.slice(1);

	let index = 0;
	while (index < candidates.length - 1 && isBanner(candidates[index] ?? "")) index += 1;
	const core = stripRedirection(candidates[index] ?? "");
	if (core.length === 0) return rest;
	return scope === undefined ? core : `[${scope}] ${core}`;
}

/** 反复剥掉指向工作根本身的 `cd`；`cd` 后面没有别的命令时保留原样。 */
function peelWorkspaceCd(command: string, workspaceRoot: string | undefined): string {
	let rest = command;
	for (;;) {
		const match = CD_PREFIX.exec(rest);
		if (match === null) return rest;
		const target = match[1] ?? match[2] ?? match[3] ?? "";
		if (!samePath(target, workspaceRoot)) return rest;
		rest = rest.slice(match[0].length).trim();
	}
}

/**
 * 两个路径是否指向同一处。
 *
 * 只认字面比较：工作根本身就是解析过的绝对路径，这里不需要再碰文件系统。Git Bash 把盘符
 * 写成 `/e/...`，与工作根的 `E:\...` 是同一个位置，比较前先归一。
 */
function samePath(target: string, workspaceRoot: string | undefined): boolean {
	if (target === "." || target === "./") return true;
	if (workspaceRoot === undefined || workspaceRoot.length === 0) return false;
	return comparablePath(target) === comparablePath(workspaceRoot);
}

function comparablePath(value: string): string {
	const text = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	const drive = /^\/([a-zA-Z])\/(.+)$/.exec(text);
	const normalized = drive === null ? text : `${drive[1] ?? ""}:/${drive[2] ?? ""}`;
	return /^[a-zA-Z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** `cd` 的目标路径；不是 `cd` 时为 undefined。 */
function cdTarget(segment: string): string | undefined {
	const match = /^cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(segment.trim());
	if (match === null) return undefined;
	return match[1] ?? match[2] ?? match[3];
}

function isCdSegment(segment: string): boolean {
	return /^cd(?:\s|$)/.test(segment.trim());
}

/**
 * `cd` 的作用域标签。
 *
 * 落在工作根之下时缩成相对形式，`[server]` 比整条绝对路径好读。指向别处的绝对路径不给
 * 前缀：它本身就是完整答案，加个方括号只会让人以为那是工作区里的子目录。
 */
function scopeOf(segment: string, workspaceRoot: string | undefined): string | undefined {
	const target = cdTarget(segment);
	if (target === undefined) return undefined;
	const trimmed = target.replace(/\/+$/, "");
	if (trimmed.length === 0 || trimmed === ".") return undefined;

	const relative = relativeToRoot(trimmed, workspaceRoot);
	if (relative !== undefined) return relative.length === 0 ? undefined : relative;
	if (isAbsoluteShaped(trimmed)) return undefined;
	// 没有工作根时无法判断相对目标落在哪里，保留原样最安全
	return workspaceRoot === undefined ? undefined : trimmed;
}

function isAbsoluteShaped(value: string): boolean {
	return /^(?:[a-zA-Z]:|\/|\\\\)/.test(value);
}

/** 目标落在工作根之下时返回相对部分；不在其下返回 undefined。 */
function relativeToRoot(target: string, workspaceRoot: string | undefined): string | undefined {
	if (workspaceRoot === undefined || workspaceRoot.length === 0) return undefined;
	const normalizedTarget = comparablePath(target);
	const normalizedRoot = comparablePath(workspaceRoot);
	if (normalizedTarget === normalizedRoot) return "";
	if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) return undefined;
	return normalizedTarget.slice(normalizedRoot.length + 1);
}

/** 只是给输出分段的命令，不是这条命令的目的。 */
function isBanner(segment: string): boolean {
	const trimmed = segment.trim();
	return /^echo\b/.test(trimmed) || trimmed === "true" || trimmed === ":";
}

function stripRedirection(segment: string): string {
	return segment.replace(REDIRECTION_TAIL, "").trim();
}

/**
 * 按 `&&`、`||`、`;`、`|` 切段，引号内的分隔符不算。
 *
 * 只用于挑出第一段，不追求还原 shell 语法：转义与引号处理到「不误切」的程度即可。
 */
function splitSegments(command: string): readonly string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			current += char;
			quote = char;
			continue;
		}
		if ((char === "&" || char === "|") && command[index + 1] === char) {
			segments.push(current);
			current = "";
			index += 1;
			continue;
		}
		if (char === "|" || char === ";") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	segments.push(current);
	return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}
