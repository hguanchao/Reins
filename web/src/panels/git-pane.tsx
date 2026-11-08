import { GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { DiffView } from "../components/diff-view.tsx";
import type { GitFileChange, GitStatus } from "../protocol.ts";

interface Selection {
	readonly path: string;
	readonly staged: boolean;
}

/**
 * Git 面板。
 *
 * 三段结构：状态头（分支、上下游、变更计数）、主滚动区（已暂存 / 未暂存分组）、单文件 diff。
 * 提交动作归内核，这里只做只读呈现——界面上不出现半截能力。
 */
export function GitPane({
	status,
	onRefresh,
	onOpenFile,
}: {
	readonly status: GitStatus | null;
	onRefresh(): void;
	onOpenFile(path: string): void;
}): ReactElement {
	const [selected, setSelected] = useState<Selection | undefined>(undefined);
	const [diff, setDiff] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (selected !== undefined) return;
		const first = status?.files[0];
		if (first !== undefined) setSelected({ path: first.path, staged: first.staged });
	}, [status, selected]);

	useEffect(() => {
		if (selected === undefined) {
			setDiff(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		void api
			.gitDiff(selected.path, selected.staged)
			.then((value) => {
				if (!cancelled) setDiff(value);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selected]);

	const staged = status?.files.filter((file) => file.staged) ?? [];
	const unstaged = status?.files.filter((file) => !file.staged) ?? [];

	return (
		<>
			<div style={{ padding: "11px 12px 9px", borderBottom: "1px solid var(--rule)" }}>
				<div className="flex items-center gap-[7px] text-[var(--fs-12)]">
					<GitBranch className="ic-14" style={{ color: "var(--ink-3)" }} />
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
						<RefreshCw className="ic-12" />
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
									<ChangeRow
										key={`s-${file.path}`}
										file={file}
										selected={selected?.path === file.path && selected.staged}
										onSelect={() => setSelected({ path: file.path, staged: true })}
										onOpenFile={() => onOpenFile(file.path)}
									/>
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
									<ChangeRow
										key={`w-${file.path}`}
										file={file}
										selected={selected?.path === file.path && !selected.staged}
										onSelect={() => setSelected({ path: file.path, staged: false })}
										onOpenFile={() => onOpenFile(file.path)}
									/>
								))}
							</div>
						</>
					)}

					<div className="panel-sec" style={{ borderTop: "1px solid var(--rule)" }}>
						<span className="truncate">{selected === undefined ? "改动" : selected.path}</span>
					</div>
					<div style={{ padding: "0 8px 8px" }}>
						{loading ? (
							<div
								className="flex items-center gap-2 px-2 py-2 text-[var(--fs-11)]"
								style={{ color: "var(--ink-3)" }}
							>
								<LoaderCircle className="ic-12 spin" />
								加载 diff
							</div>
						) : error !== undefined ? (
							<div className="px-2 py-2 text-[var(--fs-11)]" style={{ color: "var(--danger)" }}>
								{error}
							</div>
						) : diff === null || diff.length === 0 ? (
							<div className="px-2 py-2 text-[var(--fs-11)]" style={{ color: "var(--ink-3)" }}>
								这个文件没有可显示的 diff。
							</div>
						) : (
							<DiffView diff={diff} maxRows={400} showHeader={false} />
						)}
					</div>
				</>
			)}
		</>
	);
}

function ChangeRow({
	file,
	selected,
	onSelect,
	onOpenFile,
}: {
	readonly file: GitFileChange;
	readonly selected: boolean;
	onSelect(): void;
	onOpenFile(): void;
}): ReactElement {
	return (
		<button
			type="button"
			className="git-row"
			aria-selected={selected}
			style={selected ? { background: "var(--wash-2)" } : undefined}
			onClick={onSelect}
			onDoubleClick={onOpenFile}
		>
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
