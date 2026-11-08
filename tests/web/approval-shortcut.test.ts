import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { approvalShortcut } from "#web/state/approval-shortcut.ts";
import type { ApprovalRequest } from "#web/protocol.ts";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
	return {
		id: 1,
		tool: "bash",
		summary: "执行删除",
		risk: "normal",
		...overrides,
	} as ApprovalRequest;
}

describe("审批数字键位", () => {
	it("常规请求三档：一次、总是、拒绝", () => {
		const withSave = request({ saveLabel: "总是允许" });
		assert.equal(approvalShortcut("1", withSave), "once");
		assert.equal(approvalShortcut("2", withSave), "always");
		assert.equal(approvalShortcut("3", withSave), "deny");
	});

	it("没有保存标签时第二档退回拒绝", () => {
		assert.equal(approvalShortcut("2", request()), "deny");
	});

	it("高危裁决只接受点击，任何数字键都不放行", () => {
		const destructive = request({ risk: "destructive", saveLabel: "总是允许" });
		for (const key of ["1", "2", "3"]) {
			assert.equal(approvalShortcut(key, destructive), undefined);
		}
	});

	it("其他按键不产生裁决", () => {
		assert.equal(approvalShortcut("Enter", request()), undefined);
		assert.equal(approvalShortcut("a", request()), undefined);
	});
});
