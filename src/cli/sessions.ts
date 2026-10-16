import { sessionsDir } from "../config/paths.ts";
import { renderSessionMarkdown } from "../session/export.ts";
import type { SessionStore } from "../session/store.ts";
import type { CliOptions } from "./args.ts";
import { formatSessionDetail, formatSessionList } from "./session-report.ts";
import { resolveListing } from "./session-target.ts";

/**
 * `reins sessions` 的子命令。
 *
 * 它们只读会话文件，不看上下文：被压缩掉的历史照样列出来，它仍在文件里，用量统计也照旧。
 * 命令在插件装载之后执行，因此会话仓库由调用方交进来；没有仓库就如实报错。
 */

export interface SessionsDeps {
	readonly workRoot: string;
	readonly store: SessionStore | undefined;
	readonly stdout: (text: string) => void;
}

export function runSessions(options: CliOptions, deps: SessionsDeps): number {
	const { store } = deps;
	if (store === undefined) {
		throw new Error("会话存储没有装载（session-plugin 被禁用或装载失败），看不到会话");
	}

	const listings = store.list(sessionsDir(deps.workRoot));
	if (options.sessionsAction === "list") {
		writeln(deps.stdout, formatSessionList(listings));
		return 0;
	}

	const listing = resolveListing(listings, options.sessionRef ?? "");
	if (listing === undefined) {
		throw new Error(`没有找到会话 ${options.sessionRef ?? ""}；用 reins sessions list 看看有哪些`);
	}

	const opened = store.read(listing.file);
	if (options.sessionsAction === "show") {
		writeln(deps.stdout, formatSessionDetail(opened.header, opened.entries));
		return 0;
	}

	// 导出写成一份完整的 Markdown：标准输出因此可以原样重定向到文件
	deps.stdout(renderSessionMarkdown(opened.header, opened.entries));
	return 0;
}

function writeln(stdout: (text: string) => void, lines: readonly string[]): void {
	stdout(`${lines.join("\n")}\n`);
}
