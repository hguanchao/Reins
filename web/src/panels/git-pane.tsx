import { FileDiff, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { DiffView } from "../components/diff-view.tsx";
import { IconButton } from "../components/ui/button.tsx";
import { cn } from "../components/ui/cn.ts";
import type { GitFileChange, GitStatus } from "../protocol.ts";

interface Selection {
	readonly path: string;
	readonly staged: boolean;
}

/** Git 面板：分支、变更清单与单文件 diff；只读。 */
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

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
				<GitBranch className="size-4 shrink-0 text-foreground-subtle" />
				<span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle">
					{status?.branch ?? "未检测到 Git 仓库"}
				</span>
				{status !== null && (status.ahead > 0 || status.behind > 0) ? (
					<span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
						{status.ahead > 0 ? `↑${status.ahead}` : ""}
						{status.behind > 0 ? ` ↓${status.behind}` : ""}
					</span>
				) : null}
				<IconButton label="刷新" size="icon-sm" onClick={onRefresh}>
					<RefreshCw className="size-3.5" />
				</IconButton>
			</div>

			{status === null ? (
				<div className="px-4 py-3 text-ui-sm text-foreground-subtle">当前目录不是 Git 仓库。</div>
			) : status.files.length === 0 ? (
				<div className="px-4 py-3 text-ui-sm text-foreground-subtle">工作区干净，没有未提交的改动。</div>
			) : (
				<>
					<div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-border/50 px-1 py-1">
						{status.files.map((file) => (
							<ChangeRow
								key={`${file.staged ? "s" : "w"}-${file.path}`}
								file={file}
								selected={selected?.path === file.path && selected.staged === file.staged}
								onSelect={() => setSelected({ path: file.path, staged: file.staged })}
								onOpenFile={() => onOpenFile(file.path)}
							/>
						))}
					</div>

					<div className="min-h-0 flex-1 overflow-auto">
						{loading ? (
							<div className="flex items-center gap-2 px-4 py-3 text-ui-sm text-foreground-subtle">
								<Loader2 className="size-4 animate-spin" />
								加载 diff
							</div>
						) : error !== undefined ? (
							<div className="px-4 py-3 text-ui-sm text-destructive">{error}</div>
						) : diff === null || diff.length === 0 ? (
							<div className="px-4 py-3 text-ui-sm text-foreground-subtle">这个文件没有可显示的 diff。</div>
						) : (
							<DiffView diff={diff} className="px-2 py-2" />
						)}
					</div>
				</>
			)}
		</div>
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
		<div
			className={cn(
				"group/row flex h-7 items-center gap-2 rounded-md px-2 text-ui-sm transition-colors",
				selected ? "bg-selected" : "hover:bg-surface-hover",
			)}
		>
			<button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
				<span className={cn("w-4 shrink-0 font-mono text-ui-xs", colorOf(file.kind))}>{letterOf(file)}</span>
				<span className="min-w-0 flex-1 truncate text-foreground">{file.path}</span>
				{file.staged ? (
					<span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtlest">
						暂存
					</span>
				) : null}
			</button>
			<button
				type="button"
				onClick={onOpenFile}
				aria-label="打开文件"
				title="打开文件"
				className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-subtlest opacity-0 hover:bg-surface-hover hover:text-foreground group-hover/row:opacity-100"
			>
				<FileDiff className="size-3.5" />
			</button>
		</div>
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

function colorOf(kind: GitFileChange["kind"]): string {
	if (kind === "added" || kind === "untracked") return "text-git-added";
	if (kind === "deleted" || kind === "conflicted") return "text-git-deleted";
	if (kind === "renamed") return "text-git-renamed";
	if (kind === "modified") return "text-git-modified";
	return "text-foreground-subtlest";
}
