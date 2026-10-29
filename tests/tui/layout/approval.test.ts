import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, exitTui, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import { ApprovalBroker } from "../../../src/permission/approval.ts";
import type { ApprovalAnswer } from "../../../src/permission/policy.ts";

describe("审批卡", () => {
	it("审批面板替换输入区与页脚，结束后恢复", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);
			assert.ok(frameLines(output).map(plain).join("\n").includes("📁 Reins"));

			let decision: ApprovalAnswer | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			let lines = frameLines(output);
			let text = lines.map(plain).join("\n");
			assert.ok(text.includes("Permission required"));
			assert.ok(text.includes("Bash  npm test"));
			assert.equal(text.includes("destructive"), false);
			assert.ok(text.includes("[y] allow once"));
			assert.ok(text.includes("[n] deny"));
			// 面板占据原本页脚的五行；输入行、状态行与信息行都不再显示
			assert.ok(plain(lines[7] ?? "").includes("Permission required"));
			assert.equal(text.includes("📁 Reins"), false);

			input.emit("data", Buffer.from("y"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
			lines = frameLines(output);
			text = lines.map(plain).join("\n");
			assert.equal(text.includes("Permission required"), false);
			// 审批结束后输入区与页脚原样恢复
			assert.ok(text.includes("📁 Reins"));
			assert.equal(plain(lines[9] ?? ""), " › ");

			decision = undefined;
			void broker.request({ tool: "write", risk: "destructive", detail: "a.ts" }).then((value) => {
				decision = value;
			});
			t.mock.timers.tick(100);
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批请求出现时窗口失焦会响铃", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);
			// 窗口失焦：auto 模式只在看不到卡片时提醒
			input.emit("data", Buffer.from("\x1b[O"));
			output.chunks.length = 0;

			void broker.request({ tool: "bash", risk: "destructive", detail: "npm test" });
			t.mock.timers.tick(100);

			assert.ok(output.chunks.some((chunk) => chunk.includes("\x07")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批卡展开详情后可滚动，动作行随之下移仍可确认", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});
		const text = (): string => frameLines(output).map(plain).join("\n");
		const preview = Array.from(
			{ length: 30 },
			(_, index) => `detail-${String(index + 1).padStart(2, "0")}`,
		).join("\n");

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let decision: ApprovalAnswer | undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "npm test",
					summary: "npm test",
					preview,
					previewLabel: "Command",
				})
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			assert.ok(text().includes("Permission required"));
			assert.equal(text().includes("detail-01"), false, "默认收起");

			// d 展开：详情标题与第一行出现
			input.emit("data", Buffer.from("d"));
			t.mock.timers.tick(100);
			assert.ok(text().includes("Command"));
			assert.ok(text().includes("detail-01"));

			// PageDown 滚详情：第一行移出视口
			input.emit("data", Buffer.from("\x1b[6~"));
			t.mock.timers.tick(100);
			assert.equal(text().includes("detail-01"), false);
			assert.ok(text().includes("detail-12"));

			// PageUp 回到详情顶部
			input.emit("data", Buffer.from("\x1b[5~"));
			t.mock.timers.tick(100);
			assert.ok(text().includes("detail-01"));

			// d 收起
			input.emit("data", Buffer.from("d"));
			t.mock.timers.tick(100);
			assert.equal(text().includes("detail-01"), false);

			// 再展开，点动作行：动作行随面板高度下移，命中仍然正确
			input.emit("data", Buffer.from("d"));
			t.mock.timers.tick(100);
			const actionRow =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("[y] allow once")) + 1;
			assert.ok(actionRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${actionRow}M`));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批卡显示时对话流仍可双击展开和滚动", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});
		const plainLines = (): string[] => frameLines(output).map(plain);
		const rowOf = (needle: string): number =>
			plainLines().findIndex((line) => line.includes(needle)) + 1;

		try {
			input.emit("data", Buffer.from("hello\r"));
			const body = Array.from({ length: 30 }, (_, index) => `line${String(index + 1).padStart(2, "0")}`);
			agent.emit({ type: "reasoning_delta", text: body.join("\n") });
			t.mock.timers.tick(100);

			void broker.request({ tool: "bash", risk: "destructive", detail: "npm test" });
			t.mock.timers.tick(100);
			assert.ok(plainLines().join("\n").includes("Permission required"));

			// 双击审批卡上方的思考标题：对话流照常展开，审批卡不消失
			let headerRow = rowOf("Thinking…");
			assert.ok(headerRow > 0);
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			let text = plainLines().join("\n");
			assert.ok(text.includes("line01"));
			assert.ok(text.includes("Permission required"));

			// PageDown/PageUp 滚动对话流
			input.emit("data", Buffer.from("\x1b[6~"));
			text = plainLines().join("\n");
			assert.equal(text.includes("line01"), false);
			assert.ok(text.includes("Permission required"));

			input.emit("data", Buffer.from("\x1b[5~"));
			text = plainLines().join("\n");
			assert.ok(text.includes("line01"));

			// 滚轮同样可以滚动
			input.emit("data", Buffer.from(`${"\x1b[<65;10;10M".repeat(5)}`));
			text = plainLines().join("\n");
			assert.equal(text.includes("line01"), false);
			input.emit("data", Buffer.from(`${"\x1b[<64;10;10M".repeat(5)}`));
			text = plainLines().join("\n");
			assert.ok(text.includes("line01"));

			// 再双击收起，审批卡仍在
			headerRow = rowOf("Thinking…");
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${headerRow}M`));
			text = plainLines().join("\n");
			assert.equal(text.includes("line01"), false);
			assert.ok(text.includes("Permission required"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批动作支持鼠标点击", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let decision: string | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 面板占底部六行；动作行是主区域之后的第 5 行，点 [y]
			input.emit("data", Buffer.from("\x1b[<0;5;19M"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("粘贴内容里的鼠标序列不会确认审批", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let decision: ApprovalAnswer | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 动作行在 19 行；点击序列藏在 bracketed paste 里，不能当成真实点击
			input.emit("data", Buffer.from("\x1b[200~\x1b[<0;5;19M\x1b[201~"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, undefined, "粘贴里的鼠标序列不应确认审批");

			input.emit("data", Buffer.from("y"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批出现后直接回车确认", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);
			let decision: string | undefined;
			void broker
				.request({ tool: "bash", risk: "destructive", detail: "npm test" })
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("审批面板按 a 记住本会话范围", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let answer: string | undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "git status",
					saveLabel: 'commands starting with "git status"',
					saveShort: "git status",
				})
				.then((value) => {
					answer = value;
				});
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes('[a] always for "git status"'));
			assert.ok(text.includes("[n] deny"));

			input.emit("data", Buffer.from("a"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			assert.equal(answer, "always");
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Permission required"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("方向键选择审批动作，回车确认", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const agent = createFakeAgent();
		const broker = new ApprovalBroker();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			approval: broker,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("hello\r"));
			t.mock.timers.tick(100);

			let decision: string | undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "git status",
					saveLabel: 'commands starting with "git status"',
					saveShort: "git status",
				})
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 默认高亮 once；右键移到 always，回车确认
			input.emit("data", Buffer.from("\x1b[C"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "always");

			decision = undefined;
			void broker
				.request({
					tool: "bash",
					risk: "destructive",
					detail: "git push",
					saveLabel: 'commands starting with "git push"',
					saveShort: "git push",
				})
				.then((value) => {
					decision = value;
				});
			t.mock.timers.tick(100);

			// 新请求回到默认的 once，直接回车确认
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(decision, "once");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
