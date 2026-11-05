import { Archive, ArchiveRestore } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button, Dialog } from "../components/ui/index.ts";
import { relativeTime } from "../lib/format.ts";
import type { SessionSummary } from "../protocol.ts";
import { EmptyState, SettingsCard, SettingsHeader } from "./controls.tsx";

/** 归档管理：归档不删除数据，恢复后回到侧栏；永久删除需要确认。 */
export function ArchivedSection({
	archived,
	onRestore,
	onDelete,
}: {
	readonly archived: readonly SessionSummary[];
	onRestore(id: string): void;
	onDelete(id: string): void;
}): ReactElement {
	const [deleteTarget, setDeleteTarget] = useState<SessionSummary | undefined>(undefined);

	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader
				title="已归档任务"
				description="归档不会删除数据，可以随时恢复；删除则会永久移除。"
			/>
			{archived.length === 0 ? (
				<EmptyState
					icon={Archive}
					title="没有已归档的任务"
					description="归档的任务会保留在这里，恢复后重新出现在侧栏。"
				/>
			) : (
				<SettingsCard>
					{archived.map((session, index) => (
						<div
							key={session.id}
							className={
								index === archived.length - 1
									? "flex items-center gap-3 px-4 py-3"
									: "flex items-center gap-3 border-b-[0.5px] border-border px-4 py-3"
							}
						>
							<span className="min-w-0 flex-1 truncate text-[13px] leading-5">
								{session.title ?? "未命名任务"}
							</span>
							<span className="shrink-0 text-[11px] leading-4 text-foreground-subtlest">
								{relativeTime(session.updatedAt)}
							</span>
							<Button
								variant="outline"
								size="sm"
								className="h-7 rounded-md px-2.5 text-[12px]"
								onClick={() => onRestore(session.id)}
							>
								<ArchiveRestore className="size-3.5" />
								恢复
							</Button>
							<button
								type="button"
								onClick={() => setDeleteTarget(session)}
								className="flex h-7 items-center rounded-md px-2.5 text-[12px] leading-[18px] text-destructive transition-colors hover:bg-destructive-surface"
							>
								删除
							</button>
						</div>
					))}
				</SettingsCard>
			)}

			<Dialog
				open={deleteTarget !== undefined}
				onClose={() => setDeleteTarget(undefined)}
				title="永久删除任务"
				footer={
					<>
						<Button variant="outline" size="sm" onClick={() => setDeleteTarget(undefined)}>
							取消
						</Button>
						<Button
							variant="danger"
							size="sm"
							onClick={() => {
								if (deleteTarget === undefined) return;
								onDelete(deleteTarget.id);
								setDeleteTarget(undefined);
							}}
						>
							删除
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">删除后不能恢复，任务的记录会从本机移除。</p>
					<p className="m-0 text-foreground">{deleteTarget?.title ?? "未命名任务"}</p>
				</div>
			</Dialog>
		</div>
	);
}
