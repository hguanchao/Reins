import { GitBranch, RefreshCw } from "lucide-react";
import { type ReactElement } from "react";

import type { GitFileChange, GitStatus } from "../protocol.ts";

/**
 * Git 面板。
 *
 * 两段结构：状态头（分支、上下游、变更计数）与主滚动区（已暂存 / 未暂存分组）。
 * 提交动作归内核，这里只做只读呈现——界面上不出现半截能力。
 */
export function GitPane({
	status,
	onRefresh,
}: {
	readonly status: GitStatus | null;
	onRefresh(): void;
}): ReactElement {
	const staged = status?.files.filter((file) => file.staged) ?? [];
	const unstaged = status?.files.filter((file) => !file.staged) ?? [];

	return (
		<>
			<div style={{ padding: "11px 12px 9px", borderBottom: "1px solid var(--rule)" }}>
				<div className="flex items-center gap-[7px] text-[var(--fs-12)]">
					<GitBranch className="ic ic-14" style={{ color: "var(--ink-3)" }} />
					<span style={{ fontWeight: 500 }}>{status?.branch ?? "未检测到 Git 仓库"}</span>
					{status?.upstream === undefined ? null : (
						<span className="text-[var(--fs-10)]" style={{ color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
							→ {status.upstream}
						</span>
					)}
					{status === null || (status.ahead === 0 && status.behind === 0) ? null : (
						<span className="ml-auto text-[var(--fs-10)]" style={{ color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
							↑{status.ahead} ↓{status.behind}
						</span>
					)}
					<button
						type="button"
						aria-label="刷新"
						title="刷新"
						onClick={onRefresh}
						className="ml-auto"
						style={{ color: "var(--ink-3)" }}
					>
						<RefreshCw className="ic ic-12" />
					</button>
				</div>
				<div
					className="mt-2 flex items-center text-[var(--fs-10)]"
					style={{ color: "var(--ink-2)", fontFamily: "var(--mono)" }}
				>
					<span className="flex items-center gap-1">
						<span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ink)" }} />
						{status?.files.length ?? 0} 变更
					</span>
					<span style={{ width: 1, height: 9, background: "var(--rule-2)", margin: "0 9px" }} />
					<span>{staged.length} 已暂存</span>
					<span style={{ width: 1, height: 9, background: "var(--rule-2)", margin: "0 9px" }} />
					<span>{unstaged.length} 未暂存</span>
				</div>
			</div>

			{status === null ? (
				<div className="px-3 py-3 text-[var(--fs-11)]" style={{ color: "var(--ink-3)" }}>
					当前目录不是 Git 仓库。
				</div>
			) : status.files.length === 0 ? (
				<div className="px-3 py-3 text-[var(--fs-11)]" style={{ color: "var(--ink-3)" }}>
					工作区干净，没有未提交的改动。
				</div>
			) : (
				<>
					{staged.length === 0 ? null : (
						<>
							<div className="panel-sec">
								已暂存<span className="n">{staged.length}</span>
							</div>
							<div style={{ padding: "0 6px 2px" }}>
								{staged.map((file) => (
									<ChangeRow key={`s-${file.path}`} file={file} />
								))}
							</div>
						</>
					)}
					{unstaged.length === 0 ? null : (
						<>
							<div className="panel-sec">
								未暂存<span className="n">{unstaged.length}</span>
							</div>
							<div style={{ padding: "0 6px 2px" }}>
								{unstaged.map((file) => (
									<ChangeRow key={`w-${file.path}`} file={file} />
								))}
							</div>
						</>
					)}
				</>
			)}
		</>
	);
}

function ChangeRow({ file }: { readonly file: GitFileChange }): ReactElement {
	return (
		<button type="button" className="git-row">
			<span className="st-mk">{letterOf(file)}</span>
			<span className="fn">{file.path}</span>
			<span className="ct">{file.staged ? "s" : ""}</span>
		</button>
	);
}

function letterOf(file: GitFileChange): string {
	if (file.kind === "untracked") return "U";
	if (file.kind === "added") return "A";
	if (file.kind === "deleted") return "D";
	if (file.kind === "renamed") return "R";
	if (file.kind === "modified") return "M";
	if (file.kind === "conflicted") return "!";
	return "?";
}
