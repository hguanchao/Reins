import { Check, ChevronDown, Globe, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type { ApprovalAnswer, ApprovalRequest } from "../protocol.ts";

/**
 * 审批闸门。
 *
 * 三个层级对应三种重量：可逆用实线描边、越界用虚线、不可逆整卡反白。选项顺序永不改变——
 * 拒绝永远最左、允许永远最右，肌肉记忆比视觉一致性重要。裁决类卡片不做「稍后」，只能答
 * 或拒。高危卡不接受数字键（由应用层的键盘处理排除），只能逐个点击：反射性连按不该成为
 * 放行不可逆操作的通道。
 */
export function ApprovalCard({
	request,
	onAnswer,
	count,
}: {
	readonly request: ApprovalRequest;
	readonly onAnswer: (answer: ApprovalAnswer) => void;
	/** 待办队列里的位置，例如「1 / 2」；单张卡不传 */
	readonly count?: string;
}): ReactElement {
	const destructive = request.risk === "destructive";
	const external = request.risk === "external";
	const [more, setMore] = useState(false);
	const card = useRef<HTMLDivElement | null>(null);
	const TagIcon = destructive ? ShieldAlert : external ? Globe : ShieldCheck;
	const hasPreview = request.preview !== undefined && request.preview.length > 0;

	// 卡片出现即自动聚焦，但焦点落在卡片本身而不是任何按钮——默认焦点不可以是「允许」
	useEffect(() => {
		card.current?.focus({ preventScroll: true });
	}, []);

	return (
		<div
			ref={card}
			tabIndex={-1}
			role="alertdialog"
			aria-label={`需要确认：${request.summary ?? request.detail}`}
			className={`gate${destructive ? " gate-danger" : external ? " gate-ext" : ""}`}
		>
			<div className="gate-h">
				<span className="mk">
					<TagIcon className="ic ic-12" />
				</span>
				<span className="t">需要确认</span>
				<span className="tag">
					{destructive ? "高风险 · 不可逆" : external ? "工作区外" : request.risk.length === 0 ? "写文件" : request.risk}
				</span>
				{count === undefined ? null : <span className="cnt">{count}</span>}
				<span className="tool-name">{request.tool}</span>
			</div>
			<div className="gate-b">
				<p className="req">{request.summary ?? request.detail}</p>
				{request.summary === undefined || request.summary === request.detail ? null : (
					<p className="sub">{request.detail}</p>
				)}
				{hasPreview ? (
					<>
						<button type="button" className="more" onClick={() => setMore((value) => !value)} aria-expanded={more}>
							<ChevronDown className="ic ic-12" style={more ? { transform: "rotate(180deg)" } : undefined} />
							{request.previewLabel ?? "查看完整请求"}
						</button>
						{more ? (
							<div className="targets">
								<pre className="row" style={{ margin: 0 }}>
									{request.preview}
								</pre>
							</div>
						) : null}
					</>
				) : null}
			</div>
			<div className="gate-f">
				<button type="button" className="b b-danger b-sm" onClick={() => onAnswer("deny")}>
					拒绝
				</button>
				{request.saveLabel === undefined ? null : (
					<button type="button" className="b b-line b-sm" onClick={() => onAnswer("always")}>
						{request.saveShort ?? "总是允许"}
					</button>
				)}
				<button type="button" className="b b-solid b-sm" onClick={() => onAnswer("once")}>
					允许一次
				</button>
			</div>
		</div>
	);
}

/**
 * 已裁决的审批记录。
 *
 * 首行给结论与来源标签，第二行给「放行了什么」+ 时间；点开才露出当时的完整请求。
 * 只写「已允许一次」不够——两周后回看必须知道当时放行了哪条命令。
 */
export function ApprovalRecord({
	request,
	answer,
	at,
}: {
	readonly request: ApprovalRequest;
	readonly answer: ApprovalAnswer;
	readonly at: string;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const destructive = request.risk === "destructive";
	const external = request.risk === "external";
	const verdict = answer === "deny" ? "已拒绝" : answer === "always" ? "已总是允许" : "已允许一次";
	const command = request.preview?.split("\n")[0] ?? request.summary ?? request.detail;

	return (
		<div
			className={`gate${destructive && answer !== "deny" ? " gate-danger" : external ? " gate-ext" : ""} is-done${open ? " is-open" : ""}`}
		>
			<div className="gate-h">
				<span className="mk">
					{answer === "deny" ? <TriangleAlert className="ic ic-12" /> : <Check className="ic ic-12" />}
				</span>
				<span className="t">{verdict}</span>
				{destructive ? <span className="tag">不可逆</span> : external ? <span className="tag">工作区外</span> : null}
				<span className="tool-name">{request.tool}</span>
			</div>
			<button type="button" className="gate-sum" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
				<span className="cmd">{command}</span>
				<span className="tm">{at}</span>
				<ChevronDown className="ic ic-12 ck2" />
			</button>
			<div className="gate-b">
				<p className="req">{request.summary ?? request.detail}</p>
				{request.summary === undefined || request.summary === request.detail ? null : (
					<p className="sub">{request.detail}</p>
				)}
				{request.preview === undefined ? null : (
					<div className="targets">
						<pre className="row" style={{ margin: 0 }}>
							{request.preview}
						</pre>
					</div>
				)}
				<p className="meta">你的决定 · 审批方式：逐次询问</p>
			</div>
		</div>
	);
}
