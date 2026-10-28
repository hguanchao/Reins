import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	FakeInput,
	FakeOutput,
	FOOTER_INFO,
	exitTui,
	frameLines,
	plain,
	pressCtrlC,
} from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import type { TrustPromptSource } from "../../../src/tui/options.ts";

/** 让 accept 的 Promise 与随后的重绘跑到下一轮事件循环。 */
function flush(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

function fakeTrust(overrides: Partial<TrustPromptSource> = {}): TrustPromptSource & {
	readonly accepted: number;
} {
	let accepted = 0;
	return {
		root: "/work/project",
		files: ["/work/project/.reins/config.toml", "/work/project/AGENTS.md"],
		skillDirectories: ["/work/project/.reins/skills"],
		accept: async () => {
			accepted += 1;
			return ["Trusted the workspace"];
		},
		...overrides,
		get accepted(): number {
			return accepted;
		},
	};
}

function textOf(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

describe("启动信任页", () => {
	it("还没结论时先画信任页，画出列出的文件，不留下输入光标", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: fakeTrust(),
			stdin: input,
			stdout: output,
		});

		try {
			const text = textOf(output);
			assert.match(text, /Reins — workspace trust/);
			assert.match(text, /\.reins\/config\.toml|\.reins\\config\.toml/);
			assert.match(text, /AGENTS\.md/);
			assert.match(text, /› \[y\] trust this workspace/);
			// 信任页独占画面：没有输入框的页脚，也没有光标
			assert.equal(output.chunks.at(-1)?.includes("\x1b[?25h"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("按 y 记录信任后回到对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const trust = fakeTrust();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: trust,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("y"));
			await flush();

			assert.equal(trust.accepted, 1);
			const text = textOf(output);
			assert.equal(text.includes("workspace trust"), false);
			assert.match(text, /Trusted the workspace/);
			assert.match(text, /Reins/);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("回车执行高亮项，左右键先切换选中", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const trust = fakeTrust();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: trust,
			stdin: input,
			stdout: output,
		});

		try {
			// 默认高亮「信任」，右键切到「跳过」后回车：不应记录信任
			input.emit("data", Buffer.from("\x1b[C"));
			assert.match(textOf(output), /› \[n\] not now/);
			input.emit("data", Buffer.from("\r"));
			await flush();

			assert.equal(trust.accepted, 0);
			assert.match(textOf(output), /Workspace config skipped/);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("按 n 跳过时不写配置，直接进入对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const trust = fakeTrust();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: trust,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("n"));
			await flush();

			assert.equal(trust.accepted, 0);
			assert.equal(textOf(output).includes("workspace trust"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("记录期间重复按键不会再次触发记录", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let release: (() => void) | undefined;
		const trust = fakeTrust({
			accept: () =>
				new Promise<readonly string[]>((resolve) => {
					release = () => resolve([]);
				}),
		});
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: trust,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("y"));
			await flush();
			assert.match(textOf(output), /Recording the decision/);

			input.emit("data", Buffer.from("y"));
			await flush();
			assert.equal(trust.accepted, 0);

			release?.();
			await flush();
			assert.equal(textOf(output).includes("Recording the decision"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("信任页上按一次 Ctrl+C 就退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: fakeTrust(),
			stdin: input,
			stdout: output,
		});

		pressCtrlC(input);

		assert.equal(await running, 0);
		assert.equal(input.rawMode, false);
	});

	it("记录期间退出后，晚到的结论不再往主屏画帧", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let release: (() => void) | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: fakeTrust({
				accept: () =>
					new Promise<readonly string[]>((resolve) => {
						release = () => resolve(["Trusted the workspace"]);
					}),
			}),
			stdin: input,
			stdout: output,
		});

		input.emit("data", Buffer.from("y"));
		await flush();
		pressCtrlC(input);
		assert.equal(await running, 0);

		const written = output.chunks.length;
		release?.();
		await flush();
		assert.equal(output.chunks.length, written);
	});

	it("没有信任页时首帧直接是对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			stdin: input,
			stdout: output,
		});

		try {
			const text = textOf(output);
			assert.equal(text.includes("workspace trust"), false);
			assert.match(text, /v1\.2\.3/);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
