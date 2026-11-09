import { Archive } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Dialog } from "../components/ui/index.ts";
import { workspaceName } from "../lib/format.ts";
import type { SessionSummary } from "../protocol.ts";
import { Card, Empty, Row, Section, SettingsPane } from "./controls.tsx";
import { archivedAgo } from "./settings-model.ts";

/**
 * 已归档任务。
 *
 * 归档不删除数据，恢复后回到侧栏；删除则永久移除，走一次确认。低频清理动作，不配筛选器。
 */
export function ArchivedSection({
	archived,
	onRestore,
	onDelete,
}: {
	readonly archived: readonly SessionSummary[];
	onRestore(id: string): void;
	onDelete(id: string): void;
}): ReactElement {
	const [target, setTarget] = useState<SessionSummary | undefined>(undefined);

	return (
		<SettingsPane
			eyebrow="SETTINGS / ARCHIVE"
			title="已归档任务"
			description="归档不会删除数据，可以随时恢复；删除才会永久移除。"
		>
			<Section name={`${archived.length} 个任务`}>
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
									onClick={() => setTarget(session)}
								>
									删除
								</button>
							</Row>
						))}
					</Card>
				)}
				<p className="set-note">恢复后任务回到侧栏原分组；永久删除需要二次确认，不能撤销。</p>
			</Section>

			<Dialog
				open={target !== undefined}
				onClose={() => setTarget(undefined)}
				title="永久删除任务"
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
								onDelete(target.id);
								setTarget(undefined);
							}}
						>
							删除
						</button>
					</>
				}
			>
				<p style={{ margin: 0 }}>删除后不能恢复，任务的记录会从本机移除。</p>
				<p style={{ margin: 0, color: "var(--ink)" }}>{target?.title ?? "未命名任务"}</p>
			</Dialog>
		</SettingsPane>
	);
}
