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
	/** 记录到的 remember 参数，按调用顺序 */
	readonly remembered: boolean[];
	/** decline 被调用的次数 */
	declined: number;
} {
	const remembered: boolean[] = [];
	const self: TrustPromptSource & { remembered: boolean[]; declined: number } = {
		root: "/work/project",
		files: ["/work/project/.reins/config.toml", "/work/project/AGENTS.md"],
		skillDirectories: ["/work/project/.reins/skills"],
		accept: async (remember) => {
			remembered.push(remember);
			return ["Trusted the workspace"];
		},
		decline: () => {
			self.declined += 1;
		},
		...overrides,
		remembered,
		declined: 0,
	};
	return self;
}

function textOf(output: FakeOutput): string {
	return frameLines(output).map(plain).join("\n");
}

describe("启动信任页", () => {
	it("还没结论时先画信任页，画出列出的文件，不留下输入光标", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 40;
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
			assert.match(text, /› Trust this workspace/);
			// 信任页独占画面：没有输入框的页脚，也没有光标
			assert.equal(output.chunks.at(-1)?.includes("\x1b[?25h"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("按 y 记住信任后回到对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 40;
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

			assert.deepEqual(trust.remembered, [true]);
			const text = textOf(output);
			assert.equal(text.includes("workspace trust"), false);
			assert.match(text, /Trusted the workspace/);
			assert.match(text, /Reins/);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("左右键在三档间移动，回车执行高亮项", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 40;
		const trust = fakeTrust();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			trustPrompt: trust,
			stdin: input,
			stdout: output,
		});

		try {
			// 上下键不再参与：选项是横排的，按了不该有任何移动
			input.emit("data", Buffer.from("\x1b[B"));
			assert.match(textOf(output), /› Trust this workspace/);

			// 右移一档到「仅本次」，回车后不写配置
			input.emit("data", Buffer.from("\x1b[C"));
			assert.match(textOf(output), /› Trust for this session/);
			input.emit("data", Buffer.from("\r"));
			await flush();

			assert.deepEqual(trust.remembered, [false]);
			assert.equal(textOf(output).includes("workspace trust"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("y / s / n 三个字母与三档一一对应", async () => {
		for (const [key, remember] of [
			["y", true],
			["s", false],
		] as const) {
			const input = new FakeInput();
			const output = new FakeOutput();
			output.columns = 80;
			output.rows = 40;
			const trust = fakeTrust();
			const running = runTui({
				version: "1.2.3",
				info: FOOTER_INFO,
				trustPrompt: trust,
				stdin: input,
				stdout: output,
			});

			try {
				input.emit("data", Buffer.from(key));
				await flush();
				assert.deepEqual(trust.remembered, [remember], `按 ${key} 的 remember 应为 ${remember}`);
			} finally {
				exitTui(input);
			}

			assert.equal(await running, 0);
		}
	});

	it("按 n 不信任：不记录、不写配置，界面直接收尾退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 40;
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

			// 拒绝没有「继续」可言：decline 被调用，accept 从未被调用，界面退出
			assert.equal(trust.declined, 1);
			assert.deepEqual(trust.remembered, []);
			assert.equal(await running, 0);
			assert.equal(input.rawMode, false);
		} finally {
			exitTui(input);
		}
	});

	it("只有技能目录时拒绝：不退出，进入对话流并说明少了什么", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 40;
		const trust = fakeTrust({ files: [] });
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

			// 技能只是可选增强，拒绝后对话照常可用
			assert.equal(trust.declined, 0);
			const text = textOf(output);
			assert.match(text, /Workspace skills skipped/);
			assert.match(text, /v1\.2\.3/);
			assert.equal(text.includes("Reins — workspace trust"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("记录期间重复按键不会再次触发记录", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 40;
		const calls: boolean[] = [];
		let release: (() => void) | undefined;
		const trust = fakeTrust({
			accept: (remember) => {
				calls.push(remember);
				return new Promise<readonly string[]>((resolve) => {
					release = () => resolve([]);
				});
			},
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
			assert.equal(calls.length, 1);

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
