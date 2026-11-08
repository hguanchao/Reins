import { Check, ChevronDown, Eye, MapIcon, ShieldCheck, Zap } from "lucide-react";
import { type ReactElement } from "react";
import { cn } from "../../components/ui/cn.ts";
import { Popover } from "../../components/ui/popover.tsx";
import type { ApprovalMode } from "../../protocol.ts";
import { APPROVAL_LABELS, APPROVAL_HINTS } from "./model.ts";

/** 模式选择器：芯片显示当前档名；浮层里计划模式置顶，审批方式其次。 */
export function ModeChip({
	planMode,
	approvalMode,
	onPlanMode,
	onApprovalMode,
}: {
	readonly planMode: boolean;
	readonly approvalMode: ApprovalMode;
	onPlanMode(enabled: boolean): void;
	onApprovalMode(mode: ApprovalMode): void;
}): ReactElement {
	const Icon = planMode ? MapIcon : approvalMode === "yolo" ? Zap : approvalMode === "auto" ? Eye : ShieldCheck;
	return (
		<Popover
			align="start"
			trigger={({ toggle, open }) => (
				<button
					type="button"
					className="chip"
					onClick={toggle}
					aria-haspopup="menu"
					aria-expanded={open}
					title="计划模式与审批方式"
				>
					<Icon className="ic-12" />
					<span>{planMode ? "计划模式" : APPROVAL_LABELS[approvalMode]}</span>
					<ChevronDown className="ic-12" />
				</button>
			)}
		>
			<div className="mode-panel">
				<button type="button" className="pop-i plan-row" onClick={() => onPlanMode(!planMode)}>
					<MapIcon className="ic-14" />
					<span className="min-w-0 flex-1">计划模式</span>
					<span className="sw" aria-checked={planMode} role="switch" aria-label="计划模式">
						<i />
					</span>
				</button>
				<div className={cn("ap-sec", planMode && "off")}>
					<div className="sec-label">审批方式</div>
					{(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => (
						<button
							key={mode}
							type="button"
							className={cn("pop-i two", mode === approvalMode && "sel")}
							onClick={() => onApprovalMode(mode)}
						>
							<span className="sk-col">
								<span className="n">{APPROVAL_LABELS[mode]}</span>
								<span className="d">{APPROVAL_HINTS[mode]}</span>
							</span>
							<Check className="ic-12 ck" />
						</button>
					))}
				</div>
			</div>
		</Popover>
	);
}
