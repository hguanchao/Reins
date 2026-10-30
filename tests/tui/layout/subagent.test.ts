import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, FOOTER_INFO, exitTui, frameLines, plain } from "#tests/tui/support/harness.ts";
import { runTui } from "#src/tui/layout.ts";

describe("子代理组", () => {
	it("subagent 调用归组,结束翻新成员与计数,冻结后落终态", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 60;
		output.rows = 24;
		const agent = createFakeAgent();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, agent: agent.runtime, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("hello\r"));
			agent.emit({ type: "tool_start", callId: "s1", name: "subagent", args: { task: "梳理结构" } });
			agent.emit({ type: "tool_start", callId: "s2", name: "subagent", args: { task: "修路径" } });
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("› Subagents  2 running"));

			agent.emit({
				type: "tool_end", callId: "s1", name: "subagent", isError: false, durationMs: 300,
				summary: "done report", content: "done report",
				details: { steps: 3, stopReason: "done", durationMs: 300 },
			});
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("1 running · 1 done"));

			// 双击组头展开清单
			const row = frameLines(output).map(plain).findIndex((line) => line.includes("Subagents")) + 1;
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			input.emit("data", Buffer.from(`\x1b[<0;5;${row}M`));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Subagent 1"));
			assert.ok(text.includes("●") || text.includes("Subagent 2"));

			await agent.finish();
			text = frameLines(output).map(plain).join("\n");
			// 回合结束:未归报的 s2 按失败落定,组头不再有 running
			assert.ok(!text.includes("2 running"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
