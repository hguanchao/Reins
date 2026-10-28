import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeInput, FakeOutput, createFakeAgent, LEAVE, CURSOR_SUFFIX, FOOTER_INFO, IMAGE_ATTACHMENT, fakeImageSource, pressCtrlC, exitTui, rawFrame, frameLines, plain } from "../support/harness.ts";
import { runTui } from "../../../src/tui/layout.ts";
import type { ImageAttachment } from "../../../src/tui/image.ts";

describe("整屏页与图片附件", () => {
	it("插件命令出现在补全里并能执行，参数原样传入", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let call: { name: string; args: string } | undefined;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			pluginCommands: {
				list: () => [{ name: "reload", description: "Reload external plugins", enabled: true }],
				run: async (name, args) => {
					call = { name, args };
					return ["External plugins reloaded"];
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			// 内置命令已经占满一屏，先过滤出插件命令再看补全
			input.emit("data", Buffer.from("/reload"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("/reload"));
			assert.ok(text.includes("Reload external plugins"));

			input.emit("data", Buffer.from(" now\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			text = frameLines(output).map(plain).join("\n");
			assert.deepEqual(call, { name: "reload", args: "now" });
			assert.ok(text.includes("› /reload"));
			assert.ok(text.includes("External plugins reloaded"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("命令补全面板列出 /help", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/"));

			const panel = frameLines(output).map(plain).join("\n");
			assert.ok(panel.includes("/help"));
			assert.ok(panel.includes("Show the commands and keys"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /help 打开整屏帮助页，Esc 返回，期间按键不进输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));

			const help = frameLines(output).map(plain);
			const text = help.join("\n");
			assert.equal(help[0], "Reins — help");
			assert.ok(text.includes("Commands"));
			assert.ok(text.includes("/model"));
			// 帮助页顶掉启动画面，并且不再画光标
			assert.equal(text.includes("v1.2.3"), false);
			assert.equal(CURSOR_SUFFIX.test(rawFrame(output)), false);

			input.emit("data", Buffer.from("abc"));
			input.emit("data", Buffer.from("\x1b"));

			const back = frameLines(output).map(plain);
			assert.ok(back.join("\n").includes("v1.2.3"));
			assert.equal(back.join("\n").includes("Reins — help"), false);
			assert.equal(back[9], " › ");
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("整屏页打开时第一次 Ctrl+C 返回对话流，2 秒内再按退出", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		const running = runTui({ version: "1.2.3", info: FOOTER_INFO, stdin: input, stdout: output });

		try {
			input.emit("data", Buffer.from("/help\r"));
			assert.equal(frameLines(output).map(plain)[0], "Reins — help");

			pressCtrlC(input);
			const back = frameLines(output).map(plain);
			assert.ok(back.join("\n").includes("v1.2.3"));
			assert.equal(back.join("\n").includes("Reins — help"), false);
			// 第一次只返回对话流，不退出备用屏
			assert.equal(output.chunks.some((chunk) => chunk.includes(LEAVE)), false);

			// 退出确认窗口内的第二次按退出
			pressCtrlC(input);
			assert.ok(output.chunks.some((chunk) => chunk.includes(LEAVE)));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("输入 /skills 与 /mcps 打开对应的整屏页，Esc 返回", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			skills: {
				list: () => [
					{
						name: "writer",
						description: "把改动整理成文档",
						note: "/home/me/.reins/skills/writer/SKILL.md",
						scope: "user",
					},
				],
				directories: () => ["/home/me/.reins/skills"],
			},
			mcpServers: () => [{ name: "context7", description: "connected  2 tools: a, b" }],
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/skills\r"));
			const skills = frameLines(output).map(plain);
			assert.equal(skills[0], "Reins — skills");
			assert.ok(skills.join("\n").includes("writer"));
			assert.ok(skills.join("\n").includes("SKILL.md"));

			input.emit("data", Buffer.from("\x1b"));
			input.emit("data", Buffer.from("/mcps\r"));
			const mcps = frameLines(output).map(plain);
			assert.equal(mcps[0], "Reins — MCP servers");
			assert.ok(mcps.join("\n").includes("context7"));
			assert.ok(mcps.join("\n").includes("2 tools"));

			// 关掉之后回到启动画面：页面没有留下任何残影
			input.emit("data", Buffer.from("\x1b"));
			assert.ok(frameLines(output).map(plain).join("\n").includes("v1.2.3"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("沙箱限制在启动区提示，/sandbox 打开说明页", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 100;
		output.rows = 24;
		const warning =
			"Sandbox mode is workspace but this platform (win32) has no usable command isolation: " +
			"path checks still apply, and shell commands are refused.";
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			sandbox: {
				info: {
					mode: "workspace",
					platform: "win32",
					confinesCommands: false,
				},
				warning,
			},
			stdin: input,
			stdout: output,
		});

		try {
			let text = frameLines(output)
				.map(plain)
				.join("\n");
			assert.ok(text.includes("no usable command isolation"));

			input.emit("data", Buffer.from("/sandbox\r"));
			const page = frameLines(output).map(plain);
			text = page.join("\n");
			assert.equal(page[0]?.trimEnd(), "Reins — sandbox");
			assert.ok(text.includes("Command isolation"));
			assert.ok(text.includes("unavailable"));
			assert.ok(text.includes("Shell commands are refused"));
			assert.ok(text.includes("Esc close"));

			input.emit("data", Buffer.from("\x1b"));
			text = frameLines(output)
				.map(plain)
				.join("\n");
			assert.equal(text.includes("Reins — sandbox"), false);
			// 平台限制不是可修复的配置问题：页面关掉后启动说明仍在
			assert.ok(text.includes("no usable command isolation"));
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});

	it("Ctrl+V 把剪贴板图片插成正文标记，发送时随消息带上图片", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			imagesSupported: () => true,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("[image: screenshot.png]"));
			assert.equal(text.includes("[img]"), false);

			input.emit("data", Buffer.from("这个间距为什么不对\r"));
			assert.deepEqual(agent.prompts, ["[image: screenshot.png] 这个间距为什么不对"]);
			assert.equal(agent.images[0]?.[0]?.name, "screenshot.png");

			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("[image: screenshot.png] 这个间距为什么不对"));
			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("读图失败的错误提示不会在 1.5 秒后自动消失", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			images: fakeImageSource({
				clipboard: async () => {
					throw new Error("clipboard unavailable");
				},
			}),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			t.mock.timers.tick(100);

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("clipboard unavailable"), "错误应立即显示");

			t.mock.timers.tick(2000);
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("clipboard unavailable"), "错误不应自动消失");
		} finally {
			exitTui(input);
		}
	});

	it("图片标记可以单独发送，模型能力缺失时提示", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			imagesSupported: () => false,
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("does not declare image input"));

			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["[image: screenshot.png]"]);
			assert.equal(agent.images[0]?.[0]?.name, "screenshot.png");
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("[image: screenshot.png]"));

			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("删掉正文里的图片标记后，这张图不再发送", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const marker = `[image: ${IMAGE_ATTACHMENT.name}] `;
			input.emit("data", Buffer.from("\x7f".repeat(marker.length)));
			input.emit("data", Buffer.from("hi\r"));

			assert.deepEqual(agent.prompts, ["hi"]);
			assert.equal(agent.images[0]?.length, 0);

			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("读图期间回车不会发出缺少图片的半轮消息", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		let release!: (image: ImageAttachment) => void;
		const pending = new Promise<ImageAttachment>((resolve) => {
			release = resolve;
		});
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource({ clipboard: () => pending }),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("\x16"));
			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, []);
			assert.ok(frameLines(output).map(plain).join("\n").includes("Still reading an image"));

			release(IMAGE_ATTACHMENT);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));

			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["[image: screenshot.png]"]);
			assert.equal(agent.images[0]?.length, 1);
			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("拖入图片路径插入正文标记，不把路径留在输入框", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			images: fakeImageSource(),
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("drag.png"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const lines = frameLines(output).map(plain);
			const text = lines.join("\n");
			assert.ok(text.includes("[image: drag.png]"));
			assert.equal(text.includes("[img]"), false);
			// 路径本身没有作为文字留在输入框里
			assert.equal(lines.some((line) => line === " › drag.png"), false);
		} finally {
			exitTui(input);
		}
	});

	it("@ 打开文件补全，Tab 插入相对路径", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			files: { list: () => ["src/tui/layout.ts", "src/tui/text.ts", "README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看一下 @src/tu"));

			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("src/tui/layout.ts"));
			assert.ok(text.includes("src/tui/text.ts"));
			assert.equal(text.includes("README.md"), false);

			// 文件名更短的 text.ts 排在前面，Tab 选中它并补全整段 @片段
			input.emit("data", Buffer.from("\t"));
			text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("看一下 @src/tui/text.ts"));
			assert.equal(text.includes("src/tui/layout.ts"), false);
			assert.equal(agent.prompts.length, 0);
		} finally {
			exitTui(input);
		}
	});

	it("@ 文件补全面板点击把选中路径补进输入框，不发送", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			files: { list: () => ["src/tui/layout.ts", "src/tui/text.ts", "README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看一下 @src/tu"));
			const row =
				frameLines(output)
					.map(plain)
					.findIndex((line) => line.includes("src/tui/layout.ts")) + 1;
			assert.ok(row > 0, "第二项画出来了");

			// 点击第二项：整段 @片段换成完整路径，面板收起，不发送
			input.emit("data", Buffer.from(`\x1b[<0;10;${row}M\x1b[<0;10;${row}m`));
			const lines = frameLines(output).map(plain);
			assert.ok(
				lines.some((line) => line.includes("看一下 @src/tui/layout.ts")),
				"点击插入路径",
			);
			assert.equal(
				lines.some((line) => line.includes("src/tui/text.ts")),
				false,
				"面板收起",
			);
			assert.equal(agent.prompts.length, 0, "点击不发送");
		} finally {
			exitTui(input);
		}
	});

	it("@ 文件补全没有匹配时保留空态", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: { list: () => ["README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看一下 @zzz"));
			let text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("No matching files"));

			input.emit("data", Buffer.from("\x1b"));
			text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("No matching files"), false);
		} finally {
			exitTui(input);
		}
	});

	it("@ 面板里回车只插入路径，不发送", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			files: { list: () => ["src/tui/layout.ts"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看看 @lay"));
			input.emit("data", Buffer.from("\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("看看 @src/tui/layout.ts"));
			assert.equal(agent.prompts.length, 0);
		} finally {
			exitTui(input);
		}
	});

	it("@ 选中图片时插入正文标记，不把路径留在提示词里", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		const agent = createFakeAgent();
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			agent: agent.runtime,
			images: fakeImageSource(),
			files: { list: () => ["shots/screen.png", "src/a.ts"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("看看 @scr"));
			input.emit("data", Buffer.from("\r"));
			await new Promise<void>((resolve) => setImmediate(resolve));

			const lines = frameLines(output).map(plain);
			const text = lines.join("\n");
			assert.ok(text.includes("[image: screen.png]"));
			assert.equal(text.includes("[img]"), false);
			assert.equal(text.includes("@scr"), false);

			input.emit("data", Buffer.from("\r"));
			assert.deepEqual(agent.prompts, ["看看 [image: screen.png]"]);
			assert.equal(agent.images[0]?.[0]?.name, "screen.png");
			await agent.finish();
		} finally {
			exitTui(input);
		}
	});

	it("@ 每次重新打开都重扫文件，Esc 后输入变化才再弹", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		let scans = 0;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: {
				list: () => {
					scans += 1;
					return ["README.md"];
				},
			},
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("@"));
			assert.equal(scans, 1);
			assert.ok(frameLines(output).map(plain).join("\n").includes("README.md"));

			input.emit("data", Buffer.from("\x1b"));
			assert.equal(
				frameLines(output).map(plain).join("\n").includes("README.md"),
				false,
			);

			// Esc 之后同一段输入不弹；继续输入才重新打开并重扫
			input.emit("data", Buffer.from("r"));
			assert.equal(scans, 2);
			assert.ok(frameLines(output).map(plain).join("\n").includes("README.md"));

			// 结束当前片段后重新输入 @，又扫一次
			input.emit("data", Buffer.from(" "));
			input.emit("data", Buffer.from("@"));
			assert.equal(scans, 3);
		} finally {
			exitTui(input);
		}
	});

	it("邮箱里的 @ 不弹文件补全", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: { list: () => ["README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("name@example.com"));
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("README.md"), false);
		} finally {
			exitTui(input);
		}
	});

	it("斜杠命令参数里的 @ 不弹文件补全", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		output.rows = 24;
		void runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			files: { list: () => ["README.md"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/plan @rea"));
			const text = frameLines(output).map(plain).join("\n");
			assert.equal(text.includes("README.md"), false);
		} finally {
			exitTui(input);
		}
	});

	it("/skills 每次打开都重扫，改完技能重新打开就能看到", async () => {
		const input = new FakeInput();
		const output = new FakeOutput();
		output.columns = 80;
		let entries = [{ name: "writer", description: "旧说明", scope: "user" as const }];
		const running = runTui({
			version: "1.2.3",
			info: FOOTER_INFO,
			skills: { list: () => entries, directories: () => ["/skills"] },
			stdin: input,
			stdout: output,
		});

		try {
			input.emit("data", Buffer.from("/skills\r"));
			assert.ok(frameLines(output).map(plain).join("\n").includes("旧说明"));

			input.emit("data", Buffer.from("\x1b"));
			entries = [{ name: "writer", description: "新说明", scope: "user" as const }];
			input.emit("data", Buffer.from("/skills\r"));

			const text = frameLines(output).map(plain).join("\n");
			assert.ok(text.includes("新说明"));
			assert.equal(text.includes("旧说明"), false);
		} finally {
			exitTui(input);
		}

		assert.equal(await running, 0);
	});
});
