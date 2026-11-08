import { Check, ChevronDown, Eye, MapIcon, ShieldCheck, Zap } from "lucide-react";
import { type ReactElement } from "react";
import { cn } from "../../components/ui/cn.ts";
import { Popover } from "../../components/ui/popover.tsx";
import type { ApprovalMode } from "../../protocol.ts";
import { APPROVAL_LABELS } from "./model.ts";

const MODE_ICONS = { ask: ShieldCheck, auto: Eye, yolo: Zap } as const;

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
			placement="above"
			className="mode-panel"
			trigger={({ toggle, open }) => (
				<button
					type="button"
					className="chip"
					onClick={toggle}
					aria-haspopup="menu"
					aria-expanded={open}
					title="计划模式与审批方式"
				>
					<Icon className="ic ic-12" />
					<span>{planMode ? "计划模式" : APPROVAL_LABELS[approvalMode]}</span>
					<ChevronDown className="ic ic-12" />
				</button>
			)}
		>
			<div>
				<button
					type="button"
					className="pop-i plan-row"
					title="开启后只读调研，先出方案再动手"
					onClick={() => onPlanMode(!planMode)}
				>
					<MapIcon className="ic ic-14" />
					<span className="min-w-0 flex-1">计划模式</span>
					<span className="sw" aria-checked={planMode} role="switch" aria-label="计划模式">
						<i />
					</span>
				</button>
				<div className="pop-sep" />
				<div className={cn("ap-sec", planMode && "off")}>
					<div className="sec-label">审批方式</div>
					{(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((mode) => {
						const ModeIcon = MODE_ICONS[mode];
						return (
							<button
								key={mode}
								type="button"
								className={cn("pop-i", mode === approvalMode && "sel")}
								onClick={() => onApprovalMode(mode)}
							>
								<ModeIcon className="ic ic-14" />
								<span className="min-w-0 flex-1">{APPROVAL_LABELS[mode]}</span>
								<Check className="ic ic-12 ck" />
							</button>
						);
					})}
				</div>
			</div>
		</Popover>
	);
}
