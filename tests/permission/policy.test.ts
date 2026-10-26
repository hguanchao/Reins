import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PermissionGate,
	PermissionPolicy,
	type ApprovalAnswer,
	type ApprovalRequest,
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

	it("插件工具自称只读也不直接放行", () => {
		const policy = new PermissionPolicy("ask");
		assert.deepEqual(policy.decide("plugin-read", READ_ONLY, {}, "plugin"), {
			kind: "ask",
			reason: "plugin-read modifies state",
		});
	});

	it("随包插件的只读工具直接放行", () => {
		const policy = new PermissionPolicy("ask");
		assert.deepEqual(policy.decide("ls", READ_ONLY, {}, "bundled"), { kind: "allow" });
	});

	it("会改状态的工具按审批方式给结论", () => {
		assert.deepEqual(new PermissionPolicy("ask").decide("write", WRITES, {}), {
			kind: "ask",
			reason: "write modifies state",
		});
		assert.deepEqual(new PermissionPolicy("auto").decide("write", WRITES, {}).kind, "review");
		assert.deepEqual(new PermissionPolicy("yolo").decide("write", WRITES, {}), { kind: "allow" });
	});

	it("运行中切换审批方式，判定立刻跟着变", () => {
		const policy = new PermissionPolicy("ask");
		assert.equal(policy.mode, "ask");
		assert.deepEqual(policy.decide("write", WRITES, {}).kind, "ask");

		policy.setMode("yolo");
		assert.equal(policy.mode, "yolo");
		assert.deepEqual(policy.decide("write", WRITES, {}), { kind: "allow" });

		policy.setMode("auto");
		assert.equal(policy.mode, "auto");
		assert.deepEqual(policy.decide("write", WRITES, {}).kind, "review");
	});

	it("切换只影响后续判定，会话放行与规则仍然优先", () => {
		const policy = new PermissionPolicy("ask");
		policy.addRule(rule("deny", (tool: string) => tool === "bash"));
		policy.allowForSession("write", { key: "src/a.ts", label: "src/a.ts" });

		policy.setMode("yolo");
		assert.deepEqual(policy.decide("bash", WRITES, {}), { kind: "deny", reason: "blocked by rule" });
		assert.deepEqual(policy.decide("write", WRITES, {}, "core", "src/a.ts"), { kind: "allow" });
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

	it("会话放行按工具与范围匹配", () => {
		const policy = new PermissionPolicy("ask");
		policy.allowForSession("bash", { key: "git status", label: "git status" });

		assert.deepEqual(policy.decide("bash", WRITES, {}, "core", "git status"), { kind: "allow" });
		assert.deepEqual(policy.decide("bash", WRITES, {}, "core", "git push"), {
			kind: "ask",
			reason: "bash modifies state",
		});
	});

	it("插件 ask 规则优先于会话放行", () => {
		const policy = new PermissionPolicy("ask");
		policy.addRule(rule("ask", () => true, "plugin wants a look"));
		policy.allowForSession("bash", { key: "git status", label: "git status" });

		assert.deepEqual(policy.decide("bash", WRITES, {}, "core", "git status"), {
			kind: "ask",
			reason: "plugin wants a look",
		});
	});

	it("Plan 模式只放行只读工具，yolo 与会话放行都不能绕过", () => {
		const policy = new PermissionPolicy("yolo");
		policy.allowForSession("bash", { key: "git status", label: "git status" });
		policy.setPlanMode(true);

		assert.equal(policy.planMode, true);
		assert.deepEqual(policy.decide("read", READ_ONLY, {}), { kind: "allow" });
		assert.deepEqual(policy.decide("present_plan", READ_ONLY, {}), { kind: "allow" });
		assert.equal(policy.decide("bash", WRITES, {}, "core", "git status").kind, "deny");
		assert.equal(policy.decide("todo", READ_ONLY, {}).kind, "deny");
		assert.equal(policy.decide("plugin-read", READ_ONLY, {}, "plugin").kind, "deny");

		policy.setPlanMode(false);
		assert.equal(policy.planMode, false);
		assert.deepEqual(policy.decide("bash", WRITES, {}, "core", "git status"), { kind: "allow" });
	});

	it("present_plan 只在 Plan 模式可用", () => {
		const policy = new PermissionPolicy("ask");
		assert.deepEqual(policy.decide("present_plan", READ_ONLY, {}), {
			kind: "deny",
			reason: "present_plan is only available in Plan mode",
		});
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
		assert.deepEqual(await allowGate.check({ tool: "write", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal }), {
			allowed: true,
			reason: "",
		});

		const policy = new PermissionPolicy("yolo");
		policy.addRule(rule("deny", () => true, "forbidden"));
		const denyGate = new PermissionGate({ policy });
		const denied = await denyGate.check({ tool: "write", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal });
		assert.deepEqual(denied, { allowed: false, reason: "forbidden" });
	});

	it("ask:无人可问时按拒绝处理", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer: undefined });
		const outcome = await gate.check({ tool: "bash", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /no one to ask/);
	});

	it("ask:使用者拒绝则拒绝，同意则放行", async () => {
		const answer = (reply: ApprovalAnswer): Confirmer => async () => reply;
		const denyGate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer: answer("deny") });
		const denied = await denyGate.check({ tool: "bash", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal });
		assert.equal(denied.allowed, false);
		assert.match(denied.reason, /the user did not approve/);

		const allowGate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer: answer("once") });
		assert.deepEqual(
			await allowGate.check({ tool: "bash", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal }),
			{ allowed: true, reason: "" },
		);
	});

	it("ask:确认请求带着工具、风险、摘要与可记住范围", async () => {
		let captured: ApprovalRequest | undefined;
		const confirmer: Confirmer = async (request) => {
			captured = request;
			return "once";
		};
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer });
		await gate.check({
			tool: "bash",
			annotations: { readOnly: false, destructive: true, openWorld: true },
			args: { command: "git status" },
			source: "core",
			scope: {
				key: "git status",
				label: 'commands starting with "git status"',
				short: "git status",
			},
			signal: new AbortController().signal,
		});

		assert.deepEqual(captured, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		});
	});

	it("ask:文件工具把路径作为摘要", async () => {
		let captured: ApprovalRequest | undefined;
		const confirmer: Confirmer = async (request) => {
			captured = request;
			return "once";
		};
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer });
		await gate.check({
			tool: "edit",
			annotations: WRITES,
			args: { path: "src/a.ts", edits: [] },
			source: "core",
			scope: undefined,
			signal: new AbortController().signal,
		});

		assert.equal(captured?.detail, "src/a.ts");
	});

	it("auto:有审查模型时按其结论", async () => {
		const reviewer: ApprovalReviewer = {
			review: async () => ({ allowed: true, reason: "safe enough" }),
		};
		const gate = new PermissionGate({ policy: new PermissionPolicy("auto"), reviewer });
		assert.deepEqual(
			await gate.check({ tool: "bash", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal }),
			{ allowed: true, reason: "safe enough" },
		);

		const rejectingReviewer: ApprovalReviewer = {
			review: async () => ({ allowed: false, reason: "unsafe" }),
		};
		const denyGate = new PermissionGate({ policy: new PermissionPolicy("auto"), reviewer: rejectingReviewer });
		const denied = await denyGate.check({ tool: "bash", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal });
		assert.deepEqual(denied, { allowed: false, reason: "unsafe" });
	});

	it("auto:没有审查模型时按拒绝处理", async () => {
		const gate = new PermissionGate({ policy: new PermissionPolicy("auto") });
		const outcome = await gate.check({ tool: "bash", annotations: WRITES, args: {}, source: "core", scope: undefined, signal: new AbortController().signal });
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /no reviewer model/);
	});

	it("always:记住范围，后续同类调用不再询问", async () => {
		let prompts = 0;
		const confirmer: Confirmer = async () => {
			prompts += 1;
			return "always";
		};
		const policy = new PermissionPolicy("ask");
		const gate = new PermissionGate({ policy, confirmer });
		const scope = { key: "git status", label: 'commands starting with "git status"' };
		const request = {
			tool: "bash",
			annotations: WRITES,
			args: { command: "git status" },
			source: "core" as const,
			scope,
			signal: new AbortController().signal,
		};

		assert.deepEqual(await gate.check(request), { allowed: true, reason: "" });
		assert.deepEqual(await gate.check(request), { allowed: true, reason: "" });
		assert.equal(prompts, 1);
	});

	it("always:没有可记住范围时拒绝，而不是假装记住", async () => {
		const confirmer: Confirmer = async () => "always";
		const gate = new PermissionGate({ policy: new PermissionPolicy("ask"), confirmer });
		const outcome = await gate.check({
			tool: "bash",
			annotations: WRITES,
			args: {},
			source: "core",
			scope: undefined,
			signal: new AbortController().signal,
		});
		assert.equal(outcome.allowed, false);
		assert.match(outcome.reason, /cannot be remembered/);
	});
});

describe("Plan 模式与插件规则", () => {
	it("Plan 模式下 ask 规则不能让写操作变成「可批准」", () => {
		// 规则说 ask 时，使用者点一次同意就能在规划阶段写文件，而 Plan 的语义是「能不能改」
		const policy = new PermissionPolicy("ask");
		policy.addRule(rule("ask", (tool) => tool === "write"));
		policy.setPlanMode(true);

		assert.deepEqual(policy.decide("write", WRITES, {}), {
			kind: "deny",
			reason: "Plan mode is read-only; finish the plan and call present_plan, or leave Plan mode",
		});
	});

	it("Plan 模式下 deny 规则仍是终局", () => {
		const policy = new PermissionPolicy("ask");
		policy.addRule(rule("deny", (tool) => tool === "write", "blocked"));
		policy.setPlanMode(true);

		assert.deepEqual(policy.decide("write", WRITES, {}), { kind: "deny", reason: "blocked" });
	});

	it("非 Plan 模式下 ask 规则照常询问", () => {
		const policy = new PermissionPolicy("ask");
		policy.addRule(rule("ask", (tool) => tool === "write"));
		assert.deepEqual(policy.decide("write", WRITES, {}), { kind: "ask", reason: "blocked by rule" });
	});
});
