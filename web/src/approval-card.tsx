import type { ReactElement } from "react";

import type { ApprovalAnswer, ApprovalRequest } from "./types.ts";

/** 审批卡片:与全屏界面同一份请求形状,结论经 serve 转回审批桥。 */
export function ApprovalCard({
	request,
	onAnswer,
}: {
	request: ApprovalRequest;
	onAnswer: (answer: ApprovalAnswer) => void;
}): ReactElement {
	return (
		<div className="approval">
			<div className="head">
				{request.risk.length > 0 && <span className={"risk " + request.risk}>{request.risk}</span>}
				<span className="tool">{request.tool}</span>
			</div>
			{request.summary !== undefined && <div className="summary">{request.summary}</div>}
			<div className="detail">{request.detail}</div>
			{request.preview !== undefined && (
				<details className="preview">
					<summary>{request.previewLabel ?? "Detail"}</summary>
					<pre>{request.preview}</pre>
				</details>
			)}
			<div className="actions">
				<button className="allow" onClick={() => onAnswer("once")}>
					Allow once
				</button>
				{request.saveLabel !== undefined ? (
					<button className="always" title={request.saveLabel} onClick={() => onAnswer("always")}>
						{request.saveShort ?? "Always allow"}
					</button>
				) : null}
				<button className="deny" onClick={() => onAnswer("deny")}>
					Deny
				</button>
			</div>
		</div>
	);
}
