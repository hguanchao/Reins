import { ChevronRight, FileText, Folder, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { cn } from "../components/ui/cn.ts";
import type { FileTreeEntry, GitFileChange, GitStatus } from "../protocol.ts";

/** 文件树：按层加载，目录展开时才请求下一层；.gitignore 由服务端处理。 */
export function FilesPane({
	git,
	onOpenFile,
}: {
	readonly git: GitStatus | null;
	onOpenFile(path: string): void;
}): ReactElement {
	const [children, setChildren] = useState<Record<string, readonly FileTreeEntry[]>>({});
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([""]));
	const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
	const [error, setError] = useState<string | undefined>(undefined);

	const changes = useMemo(() => {
		const map = new Map<string, GitFileChange>();
		for (const file of git?.files ?? []) map.set(file.path, file);
		return map;
	}, [git]);

	const load = useCallback((path: string): void => {
		setLoading((current) => new Set(current).add(path));
		void api
			.fileTree(path)
			.then((tree) => {
				setChildren((current) => ({ ...current, [path]: tree.entries }));
				setError(undefined);
			})
			.catch((cause: unknown) => {
				setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				setLoading((current) => {
					const next = new Set(current);
					next.delete(path);
					return next;
				});
			});
	}, []);

	useEffect(() => {
		load("");
	}, [load]);

	const toggle = (path: string): void => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
				if (children[path] === undefined) load(path);
			}
			return next;
		});
	};

	const renderLevel = (parent: string, depth: number): ReactElement[] => {
		const entries = children[parent];
		if (entries === undefined) {
			return loading.has(parent)
				? [
						<div key={`loading-${parent}`} className="flex items-center gap-2 px-3 py-2 text-ui-sm text-foreground-subtlest">
							<Loader2 className="size-3.5 animate-spin" />
							加载中
						</div>,
					]
				: [];
		}
		if (entries.length === 0) {
			return [
				<div key={`empty-${parent}`} className="px-3 py-2 text-ui-sm text-foreground-subtlest">
					空目录
				</div>,
			];
		}
		return entries.map((entry) => {
			const directory = entry.kind === "directory";
			const open = expanded.has(entry.path);
			const change = changes.get(entry.path);
			return (
				<div key={entry.path}>
					<button
						type="button"
						onClick={() => (directory ? toggle(entry.path) : onOpenFile(entry.path))}
						className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-ui-sm transition-colors hover:bg-surface-hover"
						style={{ paddingLeft: 8 + depth * 12 }}
					>
						{directory ? (
							<ChevronRight
								className={cn("size-3.5 shrink-0 text-foreground-subtlest transition-transform", open && "rotate-90")}
							/>
						) : (
							<span className="w-3.5 shrink-0" />
						)}
						{directory ? (
							<Folder className="size-3.5 shrink-0 text-foreground-subtle" />
						) : (
							<FileText className="size-3.5 shrink-0 text-foreground-subtle" />
						)}
						<span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
						{change === undefined ? null : (
							<span className={cn("shrink-0 font-mono text-ui-xs", gitColor(change.kind))}>
								{gitLetter(change)}
							</span>
						)}
					</button>
					{directory && open ? renderLevel(entry.path, depth + 1) : null}
				</div>
			);
		});
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3 text-ui-sm text-foreground-subtle">
				<Folder className="size-4" />
				<span className="min-w-0 flex-1 truncate">文件</span>
				{git?.branch === undefined ? null : (
					<span className="truncate font-mono text-ui-xs text-foreground-subtlest">{git.branch}</span>
				)}
			</div>
			{error === undefined ? null : (
				<div className="border-b border-destructive/20 bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground">
					{error}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">{renderLevel("", 0)}</div>
		</div>
	);
}

function gitLetter(change: GitFileChange): string {
	if (change.kind === "untracked") return "U";
	if (change.kind === "added") return "A";
	if (change.kind === "deleted") return "D";
	if (change.kind === "renamed") return "R";
	if (change.kind === "modified") return "M";
	if (change.kind === "conflicted") return "!";
	return "?";
}

function gitColor(kind: GitFileChange["kind"]): string {
	if (kind === "added" || kind === "untracked") return "text-git-added";
	if (kind === "deleted" || kind === "conflicted") return "text-git-deleted";
	if (kind === "renamed") return "text-git-renamed";
	if (kind === "modified") return "text-git-modified";
	return "text-foreground-subtlest";
}
