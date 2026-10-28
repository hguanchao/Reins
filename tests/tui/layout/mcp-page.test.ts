import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runTui } from "../../../src/tui/layout.ts";
import type { McpControl } from "../../../src/mcp/service.ts";
import {
	FakeInput,
	FakeOutput,
	FOOTER_INFO,
	exitTui,
	frameLines,
	plain,
} from "../support/harness.ts";

const ROWS = [
	{ name: "alpha", description: "connected  2 tools" },
	{ name: "beta", description: "unreachable  connect ECONNREFUSED" },
];

function screen(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

describe("MCP 管理页", () => {
	it("选中 server 后可以重连，也可以检查全部连接", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const calls: string[] = [];
		const control: McpControl = {
			reconnect: async (name) => {
				calls.push(name);
				return `Reconnected ${name}: 2 tools`;
			},
			healthCheck: async () => ["alpha: ok", "beta: failed"],
		};
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			mcpServers: () => ROWS,
			mcpControl: control,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/mcps\r"));
			let text = screen(output);
			assert.ok(text.includes("Reins — MCP servers"));
			assert.ok(text.includes("› alpha"), "第一项默认选中");
			assert.ok(text.includes("r reconnect"));
			assert.ok(text.includes("h health check"));

			input.emit("data", Buffer.from("\x1b[B"));
			assert.ok(screen(output).includes("› beta"), "下移选中第二项");

			input.emit("data", Buffer.from("r"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(calls, ["beta"]);
			input.emit("data", Buffer.from("\x1b"));
			assert.ok(screen(output).includes("Reconnected beta: 2 tools"), screen(output));

			input.emit("data", Buffer.from("/mcps\r"));
			input.emit("data", Buffer.from("h"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			input.emit("data", Buffer.from("\x1b"));
			text = screen(output);
			assert.ok(text.includes("alpha: ok"));
			assert.ok(text.includes("beta: failed"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有配置 server 时显示空态且操作不报错", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const control: McpControl = {
			reconnect: async (name) => `Reconnected ${name}`,
			healthCheck: async () => [],
		};
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			mcpServers: () => [],
			mcpControl: control,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/mcps\r"));
			assert.ok(screen(output).includes("No MCP servers configured."));
			input.emit("data", Buffer.from("r"));
			input.emit("data", Buffer.from("h"));
			assert.ok(screen(output).includes("No MCP servers configured."));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
