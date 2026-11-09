import { Archive, EyeOff } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Dialog } from "../components/ui/index.ts";
import { workspaceName } from "../lib/format.ts";
import type { SessionSummary, WorkspaceSummary } from "../protocol.ts";
import { Card, Empty, Row, Section, SettingsPane } from "./controls.tsx";
import { archivedAgo } from "./settings-model.ts";

/** 二次确认的目标：任务与工作区的删除代价不同，弹窗文案必须分开说清。 */
type DeleteTarget =
	| { readonly kind: "session"; readonly session: SessionSummary }
	| { readonly kind: "workspace"; readonly workspace: WorkspaceSummary };

/**
 * 归档与回收。
 *
 * 两段各自独立：工作区是目录容器，恢复会连带把名下任务重新归组，永久删除更会连任务
 * 一起清掉；不能和单条归档任务混排成一张列表。低频整理动作，不配筛选器。
 */
export function ArchivedSection({
	hidden,
	archived,
	onRestore,
	onDelete,
	onRestoreWorkspace,
	onDeleteWorkspace,
}: {
	readonly hidden: readonly WorkspaceSummary[];
	readonly archived: readonly SessionSummary[];
	onRestore(id: string): void;
	onDelete(id: string): void;
	onRestoreWorkspace(path: string): void;
	onDeleteWorkspace(path: string): void;
}): ReactElement {
	const [target, setTarget] = useState<DeleteTarget | undefined>(undefined);

	return (
		<SettingsPane
			eyebrow="SETTINGS / ARCHIVE"
			title="归档与回收"
			description="归档任务和从侧栏移除的工作区都还留在本机，可以随时恢复；永久删除才不可撤销。"
		>
			<Section
				name={`${hidden.length} 个工作区`}
				note="恢复后工作区回到侧栏，名下任务重新归入该分组；永久删除会连同名下任务一起移除。"
			>
				{hidden.length === 0 ? (
					<Empty
						icon={EyeOff}
						title="没有已移除的工作区"
						description="从侧栏移除的工作区会保留在这里，可随时恢复。"
					/>
				) : (
					<Card>
						{hidden.map((workspace) => (
							<Row key={workspace.path} title={workspace.name} description={workspace.path}>
								<button
									type="button"
									className="b b-line b-sm"
									onClick={() => onRestoreWorkspace(workspace.path)}
								>
									恢复
								</button>
								<button
									type="button"
									className="b b-ghost b-sm"
									style={{ color: "var(--danger)" }}
									onClick={() => setTarget({ kind: "workspace", workspace })}
								>
									永久删除
								</button>
							</Row>
						))}
					</Card>
				)}
			</Section>

			<Section name={`${archived.length} 个任务`} note="恢复后任务回到侧栏原分组；永久删除需要二次确认，不能撤销。">
				{archived.length === 0 ? (
					<Empty
						icon={Archive}
						title="没有已归档的任务"
						description="归档的任务会保留在这里；恢复后重新出现在侧栏的原分组。"
					/>
				) : (
					<Card>
						{archived.map((session) => (
							<Row
								key={session.id}
								title={session.title ?? "未命名任务"}
								description={`${session.workspacePath === undefined || session.workspacePath === null ? "未绑定工作区" : workspaceName(session.workspacePath)} · ${archivedAgo(session.updatedAt)}`}
							>
								<button type="button" className="b b-line b-sm" onClick={() => onRestore(session.id)}>
									恢复
								</button>
								<button
									type="button"
									className="b b-ghost b-sm"
									style={{ color: "var(--danger)" }}
									onClick={() => setTarget({ kind: "session", session })}
								>
									删除
								</button>
							</Row>
						))}
					</Card>
				)}
			</Section>

			<Dialog
				open={target !== undefined}
				onClose={() => setTarget(undefined)}
				title={target?.kind === "workspace" ? "永久删除工作区" : "永久删除任务"}
				footer={
					<>
						<button type="button" className="b b-line" onClick={() => setTarget(undefined)}>
							取消
						</button>
						<button
							type="button"
							className="b b-danger"
							onClick={() => {
								if (target === undefined) return;
								if (target.kind === "workspace") onDeleteWorkspace(target.workspace.path);
								else onDelete(target.session.id);
								setTarget(undefined);
							}}
						>
							永久删除
						</button>
					</>
				}
			>
				{target === undefined ? null : target.kind === "workspace" ? (
					<>
						<p style={{ margin: 0 }}>
							「{target.workspace.name}」名下的活动与归档任务会一并永久删除，不能恢复。
						</p>
						<p style={{ margin: 0, color: "var(--ink)" }}>{target.workspace.path}</p>
					</>
				) : (
					<>
						<p style={{ margin: 0 }}>删除后不能恢复，任务的记录会从本机移除。</p>
						<p style={{ margin: 0, color: "var(--ink)" }}>{target.session.title ?? "未命名任务"}</p>
					</>
				)}
			</Dialog>
		</SettingsPane>
	);
}
