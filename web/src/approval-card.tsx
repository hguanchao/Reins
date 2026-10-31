import type { ReactElement } from "react";

import type { ApprovalAnswer, ApprovalRequest } from "./types.ts";

/**
 * 审批卡:弹层色圆角卡 + 数字列表框,与 zcode 的 PermissionDialog 同构。
 * 键盘 1/2/3 直接触发对应选项,由 App 层监听。
 */
export function ApprovalCard({
	request,
	onAnswer,
}: {
	request: ApprovalRequest;
	onAnswer: (answer: ApprovalAnswer) => void;
}): ReactElement {
	const canAlways = request.saveLabel !== undefined;
	return (
		<div className="approval">
			<div className="head">
				{request.risk.length > 0 && <span className={"risk " + request.risk}>{request.risk}</span>}
				<span className="tool">{request.tool}</span>
			</div>
			{request.summary !== undefined && <div className="summary">{request.summary}</div>}
			{request.detail.length > 0 && <div className="detail">{request.detail}</div>}
			{request.preview !== undefined && (
				<details className="preview">
					<summary>{request.previewLabel ?? "详情"}</summary>
					<pre>{request.preview}</pre>
				</details>
			)}
			<div className="options">
				<button type="button" className="option" onClick={() => onAnswer("once")}>
					<span className="num">1.</span>
					<span className="label">Allow once</span>
					<span className="desc">仅这一次放行</span>
				</button>
				{canAlways ? (
					<button type="button" className="option" title={request.saveLabel} onClick={() => onAnswer("always")}>
						<span className="num">2.</span>
						<span className="label">{request.saveShort ?? "Always allow"}</span>
						<span className="desc">记住这个选择</span>
					</button>
				) : null}
				<button type="button" className="option danger" onClick={() => onAnswer("deny")}>
					<span className="num">{canAlways ? "3." : "2."}</span>
					<span className="label">Deny</span>
					<span className="desc">拒绝这次调用</span>
				</button>
			</div>
		</div>
	);
}
