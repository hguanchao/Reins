import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PermissionGate,
	PermissionPolicy,
	type ApprovalReviewer,
	type Confirmer,
	type PermissionRule,
} from "../../src/permission/policy.ts";
import type { ToolAnnotations } from "../../src/tools/contract.ts";

const READ_ONLY: ToolAnnotations = { readOnly: true, destructive: false, openWorld: false };
const WRITES: ToolAnnotations = { readOnly: false, destructive: false, openWorld: false };

function rule(decision: "deny" | "ask", matches: PermissionRule["matches"], reason = "blocked by rule"): PermissionRule {
	return { decision, reason, matches };
}

describe("审批判定", () => {
	it("只读工具直接放行，不受审批方式影响", () => {
		for (const mode of ["ask", "auto", "yolo"] as const) {
			const policy = new PermissionPolicy(mode);
			assert.deepEqual(policy.decide("grep", READ_ONLY, {}), { kind: "allow" });
		}
	});

	it("会改状态的工具按审批方式给结论", () => {
		assert.deepEqual(new PermissionPolicy("ask").decide("write", WRITES, {}), {
			kind: "ask",
			reason: "write modifies state",
		});
		assert.deepEqual(new PermissionPolicy("auto").decide("write", WRITES, {}).kind, "review");
		assert.deepEqual(new PermissionPolicy("yolo").decide("write", WRITES, {}), { kind: "allow" });
	});

	it("规则排在最前：明令禁止不被审批方式绕过", () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule(rule("deny", (tool: string) => tool === "bash"));
		assert.deepEqual(policy.decide("bash", WRITES, {}), { kind: "deny", reason: "blocked by rule" });
	});

	it("ask 规则命中时即便 yolo 也要确认", () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule(rule("ask", (_tool, args) => args["danger"] === true, "dangerous"));
		assert.deepEqual(policy.decide("write", WRITES, { danger: true }), { kind: "ask", reason: "dangerous" });
	});

	it("规则不命中时回退到只读/审批方式判断", () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule(rule("deny", (tool: string) => tool === "other"));
		assert.deepEqual(policy.decide("bash", WRITES, {}), { kind: "allow" });
	});

	it("计数", () => {
		const policy = new PermissionPolicy("ask");
		assert.equal(policy.ruleCount(), 0);
		policy.addRule(rule("deny", () => false));
		assert.equal(policy.ruleCount(), 1);
	});
});

describe("审批落实", () => {
	it("允许与拒绝直接定", async () => {
		const allowGate = new PermissionGate({ policy: new PermissionPolicy("yolo") });
		assert.deepEqual(await allowGate.check({ tool: "write", annotations: WRITES, args: {}, signal: new AbortController().signal }), {
			allowed: true,
			reason: "",
		});

		const policy = new PermissionPolicy("yolo");
		policy.addRule(rule("deny", () => true, "forbidden"));
		const denyGate = new PermissionGate({ policy });
		const denied = await denyGate.check({ tool: "write", annotations: WRITES, args: {}, signal: new AbortController().signal });
		assert.deepEqual(denied, { allowed: false, reason: "forbidden" });
	});

	it("ask:无人可问时按拒绝处理", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer: undefined });
		const outcome = await gate.check({ tool: "bash", annotations: WRITES, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /no one to ask/);
	});

	it("ask:使用者拒绝则拒绝，同意则放行", async () => {
		const answer = (allowed: boolean): Confirmer => async () => allowed;
		const denyGate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer: answer(false) });
		const denied = await denyGate.check({ tool: "bash", annotations: WRITES, args: {}, signal: new AbortController().signal });
		assert.equal(denied.allowed, false);
		assert.match(denied.reason, /the user did not approve/);

		const allowGate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer: answer(true) });
		assert.deepEqual(
			await allowGate.check({ tool: "bash", annotations: WRITES, args: {}, signal: new AbortController().signal }),
			{ allowed: true, reason: "" },
		);
	});

	it("ask:确认问句带着调用摘要", async () => {
		let captured = "";
		const confirmer: Confirmer = async (question, detail) => {
			captured = `${question} ${detail}`;
			return true;
		};
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer });
		await gate.check({ tool: "bash", annotations: WRITES, args: { command: "ls" }, signal: new AbortController().signal });
		assert.match(captured, /Allow bash to run\?/);
		assert.match(captured, /"command": "ls"/);
	});

	it("auto:有审查模型时按其结论", async () => {
		const reviewer: ApprovalReviewer = {
			review: async () => ({ allowed: true, reason: "safe enough" }),
		};
		const gate = new PermissionGate({ policy: new PermissionPolicy("auto"), reviewer });
		assert.deepEqual(
			await gate.check({ tool: "bash", annotations: WRITES, args: {}, signal: new AbortController().signal }),
			{ allowed: true, reason: "safe enough" },
		);

		const rejectingReviewer: ApprovalReviewer = {
			review: async () => ({ allowed: false, reason: "unsafe" }),
		};
		const denyGate = new PermissionGate({ policy: new PermissionPolicy("auto"), reviewer: rejectingReviewer });
		const denied = await denyGate.check({ tool: "bash", annotations: WRITES, args: {}, signal: new AbortController().signal });
		assert.deepEqual(denied, { allowed: false, reason: "unsafe" });
	});

	it("auto:没有审查模型时按拒绝处理", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("auto") });
		const outcome = await gate.check({ tool: "bash", annotations: WRITES, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /no reviewer model/);
	});
});
