import { ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "../components/ui/cn.ts";
import type { ApprovalAnswer, ApprovalRequest } from "../protocol.ts";

const DANGER_BUTTON =
	"flex h-7 items-center justify-center rounded-sm border-[0.5px] border-border px-3 text-[12px] leading-[18px] text-foreground transition-colors hover:bg-surface-hover";
const PRIMARY_BUTTON =
	"flex h-7 items-center justify-center rounded-sm bg-primary px-3 text-[12px] leading-[18px] text-primary-foreground transition-opacity hover:opacity-90";

/** 审批卡：风险、预览与三个结论在一张卡上，保持面板材质。 */
export function ApprovalCard({
	request,
	onAnswer,
}: {
	readonly request: ApprovalRequest;
	readonly onAnswer: (answer: ApprovalAnswer) => void;
}): ReactElement {
	const destructive = request.risk === "destructive";
	const external = request.risk === "external";

	return (
		<div className="animate-panel-in rounded-[20px] border-[0.5px] border-card-border bg-panel p-3 shadow-panel-elevated">
			<div className="flex flex-col gap-3">
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
							destructive ? "bg-destructive-surface text-destructive" : "bg-surface text-foreground-subtle",
						)}
					>
						<ShieldAlert className="size-4" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-[14px] leading-[22px] font-medium text-foreground">需要确认</span>
							{request.risk.length === 0 ? null : (
								<span
									className={cn(
										"rounded-xs border-[0.5px] border-border px-1.5 py-px text-[11px] leading-4",
										destructive
											? "border-destructive/30 text-destructive"
											: external
												? "border-warning/30 text-warning-surface-foreground"
												: "text-foreground-subtle",
									)}
								>
									{destructive ? "高风险" : external ? "外部访问" : request.risk}
								</span>
							)}
							<span className="font-mono text-[11px] leading-4 text-foreground-subtlest">{request.tool}</span>
						</div>
						<p className="mt-1 break-words text-[14px] leading-[22px] text-foreground">
							{request.summary ?? request.detail}
						</p>
						{request.summary !== undefined && request.summary !== request.detail ? (
							<p className="mt-1 break-words text-[13px] leading-5 text-foreground-subtle">{request.detail}</p>
						) : null}
					</div>
				</div>

				{request.preview === undefined ? null : (
					<details className="overflow-hidden rounded-lg border-[0.5px] border-border bg-code-block">
						<summary className="cursor-pointer select-none px-4 py-2 text-[12px] leading-[18px] text-foreground-subtle">
							{request.previewLabel ?? "详情"}
						</summary>
						<pre className="max-h-52 overflow-auto border-t-[0.5px] border-border px-4 py-3 font-mono text-[11px] leading-4 text-foreground-subtle">
							{request.preview}
						</pre>
					</details>
				)}

				<div className="flex flex-wrap items-center justify-end gap-2">
					<span className="mr-auto text-[11px] leading-4 text-foreground-subtlest">
						1 允许一次 · 2 {request.saveLabel === undefined ? "拒绝" : "总是允许"} · 3 拒绝
					</span>
					<button type="button" className={DANGER_BUTTON} onClick={() => onAnswer("deny")}>
						拒绝
					</button>
					{request.saveLabel === undefined ? null : (
						<button type="button" className={DANGER_BUTTON} onClick={() => onAnswer("always")}>
							{request.saveShort ?? "总是允许"}
						</button>
					)}
					<button type="button" className={PRIMARY_BUTTON} onClick={() => onAnswer("once")}>
						允许一次
					</button>
				</div>
			</div>
		</div>
	);
}
