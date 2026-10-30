import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, exitTui, frameLines, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";

/** 双击历史里的计划卡：没有 /view-plan 之后，这是重新打开计划的入口。 */
async function openPlanCard(input: FakeInput, output: FakeOutput): Promise<void> {
	const row = frameLines(output)
		.map(plain)
		.findIndex((line) => line.includes("◇ Plan")) + 1;
	assert.ok(row > 0, "plan card is visible");
	input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
	input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Plan 模式", () => {
	it("提交计划后自动打开审批页，批准后带着完整计划实现", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		let planMode = false;
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan\r"));
			assert.equal(planMode, true);
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("PLAN"));

			input.emit("data", Buffer.from("plan it\r"));
			assert.deepEqual(agent.prompts, ["plan it"]);

			agent.emit({
				type: "tool_start",
				callId: "p1",
				name: "present_plan",
				args: { plan: "# Add Plan mode\n\n## Steps\n\n1. Add the gate." },
			});
			agent.emit({
				type: "tool_end",
				callId: "p1",
				name: "present_plan",
				isError: false,
				durationMs: 1,
				summary: "Plan submitted for review.",
			});
			await agent.finish();
			await new Promise<void>((resolve) => setImmediate(resolve));

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins · plan"));
			assert.ok(text.includes("Add Plan mode"));
			assert.ok(text.includes("approve & implement"));

			input.emit("data", Buffer.from("a"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(planMode, false);
			assert.equal(agent.prompts.length, 2);
			assert.ok(agent.prompts[1]?.startsWith("Implement this plan:"));
			assert.ok(agent.prompts[1]?.includes("Add the gate."));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Implement this plan:"));
			assert.equal(text.includes("Reins · plan"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批页关闭后排队消息继续发送", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		let planMode = false;
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan\r"));
			input.emit("data", Buffer.from("plan it\r"));
			agent.emit({
				type: "tool_start",
				callId: "p1",
				name: "present_plan",
				args: { plan: "# Queued plan\n\n1. Do it." },
			});
			agent.emit({
				type: "tool_end",
				callId: "p1",
				name: "present_plan",
				isError: false,
				durationMs: 1,
				summary: "Plan submitted for review.",
			});
			// 本轮运行中再提交一条：进入队列，审批页打开时先暂停
			input.emit("data", Buffer.from("queued later\r"));
			await agent.finish();
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.ok(frameLines(output).map(plain).join("\n").includes("approve & implement"));
			assert.deepEqual(agent.prompts, ["plan it"]);

			input.emit("data", Buffer.from("q"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			// 离开审批页后队列接上，排队消息进入下一轮
			assert.deepEqual(agent.prompts, ["plan it", "queued later"]);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入框有草稿时不自动打开审批页，草稿保留", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		let planMode = false;
		const agent = createFakeAgent();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan\r"));
			input.emit("data", Buffer.from("plan it\r"));
			// 回合运行中继续写草稿：整屏审批页不该把它抢走
			input.emit("data", Buffer.from("my draft"));
			agent.emit({
				type: "tool_start",
				callId: "p1",
				name: "present_plan",
				args: { plan: "# Draft plan\n\n1. Do it." },
			});
			agent.emit({
				type: "tool_end",
				callId: "p1",
				name: "present_plan",
				isError: false,
				durationMs: 1,
				summary: "Plan submitted for review.",
			});
			await agent.finish();
			await new Promise<void>((resolve) => setImmediate(resolve));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Reins · plan"), false);
			assert.ok(text.includes("my draft"));
			assert.ok(text.includes("Plan ready · double-click the plan card"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("历史计划可以重新打开，双击计划卡与 q 退出都生效", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		let planMode = false;
		const plan = {
			kind: "plan" as const,
			text: "# Saved plan\n\n## Steps\n\n1. Keep it.",
		};
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			history: [{ prompt: "old", response: [plan] }],
			historyPlan: plan,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan\r"));
			assert.equal(planMode, true);
			await openPlanCard(input, output);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Reins · plan"));
			assert.ok(text.includes("Saved plan"));

			// Esc 只关页面，Plan 模式仍然开着
			input.emit("data", Buffer.from("\x1b"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, true);
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Reins · plan"), false);

			// 再次双击计划卡重新打开
			await openPlanCard(input, output);
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins · plan"));

			// q 退出 Plan 模式
			input.emit("data", Buffer.from("q"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, false);
			assert.equal(plain(frameLines(output).join("\n")).includes("Reins · plan"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Plan 模式下插件命令不执行", async () => {
		let called = false;
		let planMode = true;
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			pluginCommands: {
				list: () => [{ name: "reload", description: "Reload plugins", enabled: true }],
				run: async () => {
					called = true;
					return ["reloaded"];
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/reload\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(called, false);
			assert.ok(
				plain(frameLines(output).join("\n")).includes("Plugin commands don't run in Plan mode"),
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("要求修改时关闭页面、保持 Plan 模式并预填输入", async () => {
		let planMode = false;
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 30;
		const plan = { kind: "plan" as const, text: "# Saved plan\n\n1. Keep it." };
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			history: [{ prompt: "old", response: [plan] }],
			historyPlan: plan,
			stdin: input,
			stdout: output,
		});

		try {
			await openPlanCard(input, output);
			assert.ok(plain(frameLines(output).join("\n")).includes("Reins · plan"));

			input.emit("data", Buffer.from("r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(planMode, true);
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Reins · plan"), false);
			assert.ok(text.includes("Revise the plan:"));
			assert.ok(text.includes("PLAN"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Plan 模式隐藏旧任务表，退出后恢复", async () => {
		let planMode = false;
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			planMode: {
				current: () => planMode,
				select: (enabled) => {
					planMode = enabled;
				},
			},
			historyTodo: {
				kind: "todo",
				items: [{ content: "写工具", status: "in_progress" }],
			},
			stdin: input,
			stdout: output,
		});

		try {
			assert.ok(frameLines(output).map(plain).join("\n").includes("写工具"));

			input.emit("data", Buffer.from("/plan\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, true);
			assert.equal(frameLines(output).map(plain).join("\n").includes("写工具"), false);

			input.emit("data", Buffer.from("/plan\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(planMode, false);
			assert.ok(frameLines(output).map(plain).join("\n").includes("写工具"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
