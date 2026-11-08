import type { ApprovalAnswer, ApprovalRequest } from "../protocol.ts";

/** 待办槽位里排队的一条审批：模型提问与审批共用一条队列，先到先答。 */
export interface PendingGate {
	readonly id: number;
	readonly request: ApprovalRequest;
}

/**
 * 审批卡的数字键位。
 *
 * 高危操作只接受点击——反射性连按不该成为放行不可逆操作的通道，所以这里直接不给答案。
 * 「总是允许」只有在请求带保存标签时才存在，否则第二档退回拒绝。
 */
export function approvalShortcut(key: string, request: ApprovalRequest): ApprovalAnswer | undefined {
	if (request.risk === "destructive") return undefined;
	if (key === "1") return "once";
	if (key === "2") return request.saveLabel === undefined ? "deny" : "always";
	if (key === "3") return "deny";
	return undefined;
}
