import { ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "../components/ui/button.tsx";
import { cn } from "../components/ui/cn.ts";
import type { ApprovalAnswer, ApprovalRequest } from "../protocol.ts";

/** 审批卡：把风险、命令/内容预览和三个结论放在同一张卡上。 */
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
		<div className="animate-panel-in rounded-2xl border border-popover-border bg-card p-4 shadow-md">
			<div className="flex items-start gap-3">
				<div
					className={cn(
						"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
						destructive
							? "bg-destructive-surface text-destructive"
							: "bg-surface text-foreground-subtle",
					)}
				>
					<ShieldAlert className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-ui-base font-semibold text-foreground">需要确认</span>
						{request.risk.length === 0 ? null : (
							<span
								className={cn(
									"rounded-full px-2 py-0.5 text-ui-xs font-medium",
									destructive
										? "bg-destructive-surface text-destructive-surface-foreground"
										: external
											? "bg-warning-surface text-warning-surface-foreground"
											: "bg-surface text-foreground-subtle",
								)}
							>
								{destructive ? "高风险" : external ? "外部访问" : request.risk}
							</span>
						)}
						<span className="font-mono text-ui-xs text-foreground-subtlest">{request.tool}</span>
					</div>
					<p className="mt-1 break-words text-ui-base text-foreground">
						{request.summary ?? request.detail}
					</p>
					{request.summary !== undefined && request.summary !== request.detail ? (
						<p className="mt-1 break-words text-ui-sm text-foreground-subtle">{request.detail}</p>
					) : null}
				</div>
			</div>

			{request.preview === undefined ? null : (
				<details className="mt-3 rounded-xl border border-border bg-surface">
					<summary className="cursor-pointer select-none px-3 py-2 text-ui-sm text-foreground-subtle">
						{request.previewLabel ?? "详情"}
					</summary>
					<pre className="max-h-52 overflow-auto border-t border-border px-3 py-2 font-mono text-ui-sm leading-5 text-foreground-subtle">
						{request.preview}
					</pre>
				</details>
			)}

			<div className="mt-4 flex flex-wrap items-center justify-end gap-2">
				<span className="mr-auto text-ui-xs text-foreground-subtlest">
					1 允许一次 · 2 {request.saveLabel === undefined ? "拒绝" : "总是允许"} · 3 拒绝
				</span>
				<Button variant="outline" size="sm" onClick={() => onAnswer("deny")}>
					拒绝
				</Button>
				{request.saveLabel === undefined ? null : (
					<Button variant="secondary" size="sm" onClick={() => onAnswer("always")}>
						{request.saveShort ?? "总是允许"}
					</Button>
				)}
				<Button variant="primary" size="sm" onClick={() => onAnswer("once")}>
					允许一次
				</Button>
			</div>
		</div>
	);
}
