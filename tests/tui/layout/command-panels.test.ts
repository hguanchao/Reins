import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, LEAVE, FOCUS, CURSOR_SUFFIX, FOOTER_INFO, WARNING, MODEL_ITEMS, SESSION_ITEMS, FORKED_SESSION_ITEMS, pressCtrlC, exitTui, rawFrame, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import { THEME } from "../../../src/tui/theme.ts";

describe("命令补全与选择面板", () => {
	it("输入命中命令时输入框里的命令着色，参数不着色", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		const inputLine = (): string => {
			const lines = frameLines(output);
			const index = lines.findIndex((line) => plain(line).startsWith(" › "));
			return index < 0 ? "" : (lines[index] ?? "");
		};

		try {
			// 没打全不算命中
			input.emit("data", Buffer.from("/mod"));
			assert.equal(inputLine().includes(`${FOCUS}/mod`), false);

			// 打全之后命令着色，后面的参数保持正文色
			input.emit("data", Buffer.from("el foo"));
			const line = inputLine();
			assert.equal(plain(line), " › /model foo");
			assert.ok(line.includes(`${FOCUS}/model${THEME.reset}`));
			assert.ok(line.endsWith(" foo"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入完整命令再按空格，直接打开对应的选择面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session "));
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.includes(" 2 ────")), "会话面板打开了");
			assert.ok(lines.some((line) => line.includes("Fix the login flow")));
			// 命令本身留在输入框里，面板只是提前展开
			assert.ok(lines.some((line) => line.trim() === "› /session"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令后面继续输入参数时面板收起", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session "));
			assert.ok(frameLines(output).map(plain).some((line) => line.includes(" 2 ────")));

			input.emit("data", Buffer.from("fedcba"));
			assert.equal(
				frameLines(output).map(plain).some((line) => line.includes(" 2 ────")),
				false,
				"开始打参数后不再显示面板",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /model 在输入框上方打开模型面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));

			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.endsWith(" 3 ────")));
			assert.ok(lines.some((line) => line.includes("fengshao/")));
			assert.ok(lines.some((line) => line.includes("› /model")));
			// 面板只盖在输入框上方，输入行仍然可编辑，光标照常显示
			assert.equal(CURSOR_SUFFIX.test(rawFrame(output)), true);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话面板的鼠标点击即切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		output.rows = 12;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: (id) => {
					selected = id;
					return { changed: true, history: [], warnings: [] };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			// 行号从画面里取，不写死：面板位置取决于终端高度与页脚
			const rows = frameLines(output).map(plain);
			const borderRow = rows.findIndex((line) => line.includes(" 2 ────")) + 1;
			const secondRow = rows.findIndex((line) => line.includes("fedcba9876543210")) + 1;
			assert.ok(borderRow > 0 && secondRow > 0, "面板与第二项都画出来了");

			// 上边框本身不响应
			input.emit("data", Buffer.from(`\x1b[<0;10;${borderRow}M`));
			assert.equal(selected, undefined);

			// 点第二项直接切换，不需要回车
			input.emit("data", Buffer.from(`\x1b[<0;10;${secondRow}M`));
			assert.equal(selected, "fedcba9876543210", "点击即切换会话");
			assert.equal(
				frameLines(output)
					.map(plain)
					.join("\n")
					.includes("Fix the login flow"),
				false,
				"面板收掉",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话面板里点击当前会话不重新加载", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 40;
		output.rows = 12;
		let selectCalls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => {
					selectCalls += 1;
					return { changed: true, history: [], warnings: [] };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			const rows = frameLines(output).map(plain);
			const currentRow = rows.findIndex((line) => line.includes("0123456789abcdef")) + 1;
			assert.ok(currentRow > 0);

			// 点当前会话：面板收掉，但不切换
			input.emit("data", Buffer.from(`\x1b[<0;10;${currentRow}M`));
			assert.equal(selectCalls, 0);
			assert.equal(frameLines(output).map(plain).join("\n").includes("Fix the login flow"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("模型面板点击即切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			const rows = frameLines(output).map(plain);
			const borderRow = rows.findIndex((line) => line.includes(" 3 ────")) + 1;
			const secondRow = rows.findIndex((line) => line.includes("openai/gpt-5.2")) + 1;
			assert.ok(borderRow > 0 && secondRow > 0);

			// 点上边框不响应
			input.emit("data", Buffer.from(`\x1b[<0;10;${borderRow}M`));
			assert.equal(selected, undefined);

			// 点第二项直接切换，不需要回车
			input.emit("data", Buffer.from(`\x1b[<0;10;${secondRow}M`));
			assert.equal(selected, "openai/gpt-5.2", "点击即切换模型");
			// 面板收起：画面上不再有面板上边框
			assert.equal(
				frameLines(output)
					.map(plain)
					.some((line) => line.includes(" 3 ────")),
				false,
				"面板收掉",
			);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Esc 关掉命令补全面板后不会自己弹回来", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		const panelOpen = (): boolean =>
			frameLines(output).map(plain).some((line) => line.includes("/help"));

		try {
			input.emit("data", Buffer.from("/"));
			assert.equal(panelOpen(), true, "输入斜杠后面板打开");

			input.emit("data", Buffer.from("\x1b"));
			assert.equal(panelOpen(), false, "Esc 关掉面板");

			// 输入没变时再按回车，不会把面板重新算出来
			input.emit("data", Buffer.from("\r"));
			assert.equal(panelOpen(), false, "输入不变时面板保持关闭");

			// 输入一变，补全重新出现
			input.emit("data", Buffer.from("h"));
			assert.equal(panelOpen(), true, "继续输入后补全回来");
		} finally {
			exitTui(input);
		}
	});

	it("只有斜杠时回车不发送也不入队", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });

		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("first\r"));
			t.mock.timers.tick(50);

			// 一个斜杠还不是命令：关掉补全后回车，既不入队也不发出去
			input.emit("data", Buffer.from("/"));
			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["first"]);
			assert.equal(frameLines(output).map(plain).join("\n").includes("↳ /"), false);
			assert.ok(
				frameLines(output).map(plain).some((line) => line.trim() === "› /"),
				"输入框保留那个斜杠",
			);
		} finally {
			exitTui(input);
		}
	});

	it("命令补全面板点击即执行", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/"));
			// 点 /help 那一行：命令清单会随内置命令增减而整体移动，按内容找行比写死行号稳
			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("/help")) + 1;
			assert.ok(row > 0);
			input.emit("data", Buffer.from(`\x1b[<0;10;${row}M`));

			// 点击即执行：帮助页直接打开，不需要回车
			assert.ok(
				frameLines(output)
					.map(plain)
					.join("\n")
					.includes("Reins — help"),
			);
		} finally {
			exitTui(input);
		}
	});

	it("方向键移动并回车切换模型，页脚随之更新", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		// 块级空行让这段对话需要更多高度，默认 12 行会把首行正文顶到吸顶提示后面
		output.rows = 20;
		let selected: string | undefined;
		let info = FOOTER_INFO;
		const running = runTui({
			version: "1.2.3",
			info: () => info,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					info = { ...FOOTER_INFO, model: item.model };
					return { warnings: ["note"], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(selected, "openai/gpt-5.2");
			assert.ok(text.includes("Model switched to openai/gpt-5.2."));
			assert.ok(text.includes("! Warning: note"));
			assert.ok(text.includes("openai/gpt-5.2"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全同时匹配命令说明", () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		void runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/configuration"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("/effort"));
		} finally {
			exitTui(input);
		}
	});

	it("Esc 关闭模型面板且不切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x1b"));

			const lines = frameLines(output).map(plain);
			assert.equal(calls, 0);
			assert.equal(lines.some((line) => line.includes("Model switched")), false);
			assert.ok(lines.some((line) => line.includes("Reins")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("模型面板按 Tab 只补全到输入框，回车才切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(selected, undefined);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line === " › /model openai/gpt-5.2"));
			// 模型面板已经收起，没有切换记录
			assert.equal(lines.some((line) => line.includes("fengshao/")), false);

			input.emit("data", Buffer.from("\r"));
			assert.equal(selected, "openai/gpt-5.2");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("思考等级面板按 Tab 只补全到输入框，回车才写回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: (level) => {
					selected = level;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(selected, undefined);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line === " › /effort high"));

			input.emit("data", Buffer.from("\r"));
			assert.equal(selected, "high");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/model 带未知模型时报告错误，不切换", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model nope\r"));

			assert.equal(calls, 0);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Unknown model: nope"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/effort 带未知等级时报告错误，不写回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: (level) => {
					selected = level;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort bogus\r"));

			assert.equal(selected, undefined);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Unknown effort: bogus"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板打开时打字：面板收掉，文字进输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			// `/model` 不再是当前输入的内容，面板失去意义
			input.emit("data", Buffer.from("x"));

			assert.equal(calls, 0);
			const lines = frameLines(output).map(plain);
			assert.equal(lines.some((line) => line.includes("fengshao/")), false);
			assert.ok(lines.some((line) => line.includes("/modelx")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 补出普通命令名，补全面板保持打开", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/hel"));
			input.emit("data", Buffer.from("\t"));

			const lines = frameLines(output).map(plain);
			// 输入框补全成带空格的命令名
			assert.ok(lines.some((line) => line === " › /help "));
			// 补全面板没有收掉，说明行仍在画面里
			assert.ok(lines.some((line) => line.includes("Show the commands and keys")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 直接打开模型面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(calls, 0);
			const lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line.includes("fengshao/deepseek-v4.1-flash")));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 直接打开思考等级面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: () => {},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort"));
			input.emit("data", Buffer.from("\t"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("xhigh"));
			assert.ok(text.includes("› medium"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/session 打开当前项目的会话菜单，Esc 返回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Fix the login flow"));
			assert.ok(text.includes("0123456789abcdef"));
			assert.ok(text.includes("Write the release notes"));
			assert.ok(text.includes("current"));

			input.emit("data", Buffer.from("\x1b"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Write the release notes"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话菜单按 Tab 只补全，回车才切换并替换对话流", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: (id) => {
					selected = id;
					return {
						changed: true,
						history: [{ prompt: "old work", response: ["old answer"] }],
						warnings: [],
					};
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\t"));

			assert.equal(selected, undefined);
			let lines = frameLines(output).map(plain);
			assert.ok(lines.some((line) => line === " › /session fedcba9876543210"));
			assert.equal(lines.some((line) => line.includes("Write the release notes")), false);

			input.emit("data", Buffer.from("\r"));

			assert.equal(selected, "fedcba9876543210");
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("old work"));
			assert.ok(text.includes("old answer"));
			assert.ok(text.includes("Switched to session fedcba9876543210."));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/session 菜单标出分叉来源", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 100;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => FORKED_SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("↳ Fork of Fix the login flow"));
			assert.ok(text.includes("f fork at end"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("/fork 从当前会话末尾分叉并显示复制量", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const forks: string[] = [];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: (id) => {
					forks.push(id);
					return {
						changed: true,
						history: [{ prompt: "old work", response: ["old answer"] }],
						warnings: [],
						fork: { sourceId: id, copied: 4 },
					};
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/fork\r"));

			assert.deepEqual(forks, ["0123456789abcdef"]);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Forked from 0123456789abcdef · 4 entries copied"));
			assert.ok(text.includes("Workspace unchanged"));
			assert.ok(text.includes("old work"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话菜单按 f 从选中的会话分叉", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const forks: string[] = [];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: (id) => {
					forks.push(id);
					return {
						changed: true,
						history: [],
						warnings: [],
						fork: { sourceId: id, copied: 2 },
					};
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session\r"));
			// 光标从当前会话移到下一条，再按 f
			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("f"));

			assert.deepEqual(forks, ["fedcba9876543210"]);
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Forked from fedcba9876543210 · 2 entries copied"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("分叉失败时报告错误，保留当前对话", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
				fork: () => {
					throw new Error("This session has no entries to fork from");
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/fork\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Failed to fork session"));
			assert.ok(text.includes("no entries to fork from"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("会话切换失败时报告错误，保留当前对话", async () => {		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => {
					throw new Error("Session file is broken");
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session fedcba9876543210\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Failed to switch session"));
			assert.ok(text.includes("Session file is broken"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全里 Tab 直接打开会话菜单", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sessionMenu: {
				list: () => SESSION_ITEMS,
				select: () => ({ changed: false, history: [], warnings: [] }),
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/session"));
			input.emit("data", Buffer.from("\t"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Fix the login flow"));
			assert.ok(text.includes("Write the release notes"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板打开时退格：面板收掉，输入删掉一个字符", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: () => {
					calls += 1;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\x7f"));

			assert.equal(calls, 0);
			const lines = frameLines(output).map(plain);
			assert.equal(lines.some((line) => line.includes("fengshao/")), false);
			// 补全面板里也有 `/model`，只有整行匹配输入框才能确认退格真的删掉了字符
			assert.ok(lines.some((line) => line === " › /mode"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("没有菜单时 Tab 不改动输入", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\t"));

			const lines = frameLines(output).map(plain);
			assert.ok(lines.includes(" › abc"));
			// 输入框里不该留下制表符
			assert.equal(lines.some((line) => line.includes("\t")), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("面板打开时连按两次 Ctrl+C 仍能退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			pressCtrlC(input);
			// 第一次只进入待确认状态，不该退出备用屏
			assert.equal(output.chunks.some((chunk) => chunk.includes(LEAVE)), false);
			pressCtrlC(input);
			assert.ok(output.chunks.some((chunk) => chunk.includes(LEAVE)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入斜杠立即显示命令补全，配置不可用时也显示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		// 命令已经超过一屏：只显示前八条，默认 12 行终端会把主区域挤没，警告就看不见了
		output.rows = 20;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			warning: WARNING,
			ready: false,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/"));

			const lines = frameLines(output).map(plain);
			const text = lines.join("\n");
			assert.ok(text.includes("! Warning:"));
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("/effort"));
			assert.ok(text.includes("/compact"));
			assert.ok(text.includes("Requires a valid configuration"));
			assert.ok(lines.some((line) => line.includes("› /")));
			assert.ok(lines.some((line) => line.endsWith(" 14 ────")));
			assert.ok(CURSOR_SUFFIX.test(rawFrame(output)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全随输入过滤，回车打开模型面板", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/m"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/model"));
			assert.ok(text.includes("Choose the model for this session"));

			input.emit("data", Buffer.from("\r"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" 3 ────"));
			assert.ok(text.includes("fengshao/"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Esc 关闭命令补全并保留输入", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			modelMenu: { list: () => MODEL_ITEMS, select: () => ({ warnings: [], ready: true, warning: undefined }) },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/"));
			input.emit("data", Buffer.from("\x1b"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("Choose the model for this session"), false);
			assert.ok(text.includes("› /"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("配置对不上时仍可 /model，选中后解除受限", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const agent = createFakeAgent();
		let selected: string | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			warning: WARNING,
			ready: false,
			agent: agent.runtime,
			modelMenu: {
				list: () => MODEL_ITEMS,
				select: (item) => {
					selected = `${item.provider}/${item.model}`;
					return { warnings: [], ready: true, warning: undefined };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/model\r"));
			input.emit("data", Buffer.from("\r"));

			assert.equal(selected, "fengshao/deepseek-v4.1-flash");

			input.emit("data", Buffer.from("hello\r"));
			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("Waiting for model..."));
			assert.equal(text.includes("Configuration required"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /effort 打开等级面板，回车写回并更新页脚", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let selected: string | undefined;
		let info = FOOTER_INFO;
		const running = runTui({
			version: "1.2.3",
			info: () => info,
			effortMenu: {
				current: () => "medium",
				select: (level) => {
					selected = level;
					info = { ...FOOTER_INFO, effort: level };
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort\r"));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes(" 6 ────"));
			assert.ok(text.includes("off"));
			assert.ok(text.includes("xhigh"));
			assert.ok(text.includes("› medium"));
			assert.ok(text.includes("Everyday work with a clear scope"));
			assert.ok(text.includes("current"));

			input.emit("data", Buffer.from("\x1b[B"));
			input.emit("data", Buffer.from("\r"));

			text = frameLines(output).map(plain).join("\n");
			assert.equal(selected, "high");
			assert.ok(text.includes("Effort set to high."));
			assert.ok(text.includes("🧠 high"));
			// 确认后面板关闭、输入框重新获得焦点
			assert.equal(text.includes("xhigh"), false);
			assert.ok(CURSOR_SUFFIX.test(rawFrame(output)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Esc 关闭等级面板且不写回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let calls = 0;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			effortMenu: {
				current: () => "medium",
				select: () => {
					calls += 1;
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/effort\r"));
			input.emit("data", Buffer.from("\x1b"));

			const text = frameLines(output).map(plain).join("\n");
			assert.equal(calls, 0);
			assert.equal(text.includes("Effort set to"), false);
			assert.equal(text.includes("xhigh"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
