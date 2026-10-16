import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PermissionGate,
	PermissionPolicy,
	type ApprovalReviewer,
	type PermissionRule,
} from "../../src/permission/policy.ts";
import type { ToolAnnotations } from "../../src/tools/contract.ts";

const READ_ONLY: ToolAnnotations = { readOnly: true, destructive: false, openWorld: false };
const MUTATING: ToolAnnotations = { readOnly: false, destructive: true, openWorld: false };

function denyRule(tool: string, reason = "明令禁止"): PermissionRule {
	return { decision: "deny", reason, matches: (name) => name === tool };
}

describe("审批判定", () => {
	it("只读工具直接放行", () => {
		const policy = new PermissionPolicy("ask");
		assert.deepEqual(policy.decide("read", READ_ONLY, {}), { kind: "allow" });
	});

	it("按审批方式决定改动类工具怎么处理", () => {
		assert.equal(new PermissionPolicy("ask").decide("write", MUTATING, {}).kind, "ask");
		assert.equal(new PermissionPolicy("auto").decide("write", MUTATING, {}).kind, "review");
		assert.equal(new PermissionPolicy("yolo").decide("write", MUTATING, {}).kind, "allow");
	});

	it("规则优先于审批方式", () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule(denyRule("bash"));
		const decision = policy.decide("bash", MUTATING, { command: "rm -rf /" });
		assert.equal(decision.kind, "deny");
		assert.equal(decision.kind === "deny" ? decision.reason : "", "明令禁止");
	});

	it("规则也能收紧只读工具", () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule(denyRule("read"));
		assert.equal(policy.decide("read", READ_ONLY, {}).kind, "deny");
	});

	it("规则可以要求询问", () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule({ decision: "ask", reason: "这类命令要看一眼", matches: () => true });
		assert.equal(policy.decide("write", MUTATING, {}).kind, "ask");
	});

	it("没命中的规则不影响判定", () => {
		const policy = new PermissionPolicy("ask");
		policy.addRule(denyRule("bash"));
		assert.equal(policy.decide("write", MUTATING, {}).kind, "ask");
		assert.equal(policy.ruleCount(), 1);
	});
});

describe("审批判定的落实", () => {
	it("放行时不带理由", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("yolo") });
		assert.deepEqual(await gate.check({ tool: "write", annotations: MUTATING, args: {}, signal: new AbortController().signal }), {
			allowed: true,
			reason: "",
		});
	});

	it("拒绝时给出规则写的理由", async () => {
		const policy = new PermissionPolicy("yolo");
		policy.addRule(denyRule("bash", "不许执行命令"));
		const gate = new PermissionGate({ policy });
		const outcome = await gate.check({ tool: "bash", annotations: MUTATING, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.equal(outcome.reason, "不许执行命令");
	});

	it("没有人可以询问时按拒绝处理，并说明怎么办", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask") });
		const outcome = await gate.check({ tool: "write", annotations: MUTATING, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /无法征求同意/);
		assert.match(outcome.reason, /--yes/);
	});

	it("有确认入口时按使用者的回答定", async () => {
		const asked: string[] = [];
		const gate = new PermissionGate({
			policy: new PermissionPolicy("ask"),
			confirmer: async (question) => {
				asked.push(question);
				return true;
			},
		});
		const outcome = await gate.check({ tool: "write", annotations: MUTATING, args: { path: "a" }, signal: new AbortController().signal });
		assert.equal(outcome.allowed, true);
		assert.equal(asked.length, 1);
		assert.match(asked[0], /write/);
	});

	it("使用者不同意时说明这一点", async () => {
		const gate = new PermissionGate({
			policy: new PermissionPolicy("ask"),
			confirmer: async () => false,
		});
		const outcome = await gate.check({ tool: "write", annotations: MUTATING, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /没有同意/);
	});

	it("auto 模式交给审查模型，理由原样带回", async () => {
		const reviewer: ApprovalReviewer = {
			async review() {
				return { allowed: false, reason: "会改动工作区之外的文件" };
			},
		};
		const gate = new PermissionGate({ policy: new PermissionPolicy("auto"), reviewer });
		const outcome = await gate.check({ tool: "bash", annotations: MUTATING, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.equal(outcome.reason, "会改动工作区之外的文件");
	});

	it("auto 模式却没有审查模型时按拒绝处理", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("auto") });
		const outcome = await gate.check({ tool: "write", annotations: MUTATING, args: {}, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /没有可用的审查模型/);
	});
});
