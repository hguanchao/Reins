import { CalendarClock, Plus } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Button, Dialog } from "../components/ui/index.ts";
import { PanelPage } from "../shell/panel-page.tsx";

/** 定时任务页：调度器接入前的空态与新建说明。 */
export function SchedulesPage({ onClose }: { onClose(): void }): ReactElement {
	const [dialogOpen, setDialogOpen] = useState(false);

	return (
		<>
			<PanelPage
				title="定时任务"
				description="按计划自动唤醒会话并执行任务。"
				onClose={onClose}
				actions={
					<Button
						variant="primary"
						size="sm"
						className="h-7 rounded-sm px-3 text-[12px]"
						onClick={() => setDialogOpen(true)}
					>
						<Plus className="size-3.5" />
						新建任务
					</Button>
				}
			>
				<div className="flex flex-col items-center gap-3 py-24 text-center">
					<CalendarClock className="size-12 text-foreground-subtlest" />
					<div className="mt-2 text-[14px] leading-[22px] font-medium">还没有定时任务</div>
					<p className="m-0 max-w-[400px] text-[13px] leading-5 text-foreground-subtlest">
						定时任务需要宿主侧持久化调度与后台会话。当前版本尚未接入调度器，这里不会创建无效的定时任务。
					</p>
				</div>
			</PanelPage>

			<Dialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				title="新建定时任务"
				footer={
					<Button variant="primary" size="sm" onClick={() => setDialogOpen(false)}>
						知道了
					</Button>
				}
			>
				<div className="flex flex-col gap-2 text-[13px] leading-5 text-foreground-subtle">
					<p className="m-0">调度器尚未接入，当前版本无法创建定时任务。</p>
					<p className="m-0">
						接入后，任务会记录执行时间、重复规则、目标会话与投递历史；在此之前不会生成占位任务。
					</p>
				</div>
			</Dialog>
		</>
	);
}
