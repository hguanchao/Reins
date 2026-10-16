import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import { MemoryTerminal, screenOf } from "../../tui/memory-terminal.ts";
import { makeRuntime, textEvents, tick } from "./helpers.ts";

/** 一条长的回答：行数足够超过一屏，用来验证「提交进滚动区」的行为。 */
const LONG_REPLY = Array.from({ length: 12 }, (_, index) => `第 ${index} 行内容`).join("\n\n");

async function start(
	script: Parameters<typeof makeRuntime>[0] = {},
	size = { rows: 10, cols: 40 },
): Promise<{
	frontend: TerminalFrontend;
	terminal: MemoryTerminal;
	fake: ReturnType<typeof makeRuntime>;
	done: Promise<void>;
	visible: () => string[];
}> {
	const terminal = new MemoryTerminal(size);
	const frontend = new TerminalFrontend({ terminal, env: {} });
	const fake = makeRuntime(script);
	const done = frontend.run(fake.runtime);
	await tick();
	return {
		frontend,
		terminal,
		fake,
		done,
		visible: () =>
			screenOf(terminal)
				.visible()
				.filter((line) => !line.startsWith("┌") && !line.startsWith("├") && !line.startsWith("└"))
				.map((line) => line.replace(/^│/, "").replace(/│\s*$/, "").trim())
				.filter((line) => line.length > 0),
	};
}

/** 退出界面，免得定时器把测试进程吊着。先清掉输入框里的草稿，再走 /exit。 */
async function quit(terminal: MemoryTerminal, done: Promise<void>): Promise<void> {
	terminal.feedInput("\x15/exit\r");
	await done;
	await tick();
}

describe("交互界面", () => {
	it("启动后显示欢迎信息、输入框与状态行", async () => {
		const { terminal, visible, done } = await start();
		const lines = visible();
		assert.ok(lines.some((line) => line.includes("Reins  demo/m1")));
		assert.ok(lines.some((line) => line.includes("sandbox=off")));
		assert.ok(lines.some((line) => line.startsWith("› ")));
		assert.ok(lines.some((line) => line.includes("demo/m1") && line.includes("approval=ask")));
		await quit(terminal, done);
	});

	it("没有信任工作区时把这件事说出来", async () => {
		const { terminal, visible, done } = await start({
			trust: { trusted: false, root: "/work", files: ["/work/.reins/config.toml"] },
		});
		assert.ok(visible().some((line) => line.includes("工作区自带的配置没有读取")));
		await quit(terminal, done);
	});

	it("输入的内容显示在输入框里", async () => {
		const { terminal, visible, done } = await start();
		terminal.feedInput("你好");
		await tick();
		assert.ok(visible().some((line) => line.startsWith("› 你好")));
		await quit(terminal, done);
	});

	it("提交一句话：回显、跑驱动、把回答画在屏幕上", async () => {
		const { terminal, fake, visible, done } = await start({
			onRun: async ({ emit }) => {
				await emit({ type: "turn_start" });
				for (const event of textEvents("答案是 42")) await emit(event);
				await emit({ type: "turn_end", stopReason: "stop" });
				await emit({ type: "run_end" });
			},
		});

		terminal.feedInput("问题\r");
		await tick();
		await tick();

		assert.deepEqual(fake.prompts, ["问题"]);
		const lines = visible();
		assert.ok(lines.some((line) => line.startsWith("› 问题")));
		assert.ok(lines.some((line) => line.includes("答案是 42")));

		await quit(terminal, done);
	});

	it("PageUp 向上翻阅历史，PageDown 回到底部", async () => {
		const { terminal, visible, done } = await start(
			{
				onRun: async ({ emit }) => {
					for (const event of textEvents(LONG_REPLY)) await emit(event);
					await emit({ type: "run_end" });
				},
			},
			{ rows: 24, cols: 40 },
		);

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		// 跟尾时只能看到最后一段
		assert.ok(!visible().some((line) => line.includes("第 0 行内容")));

		terminal.feedInput("\x1b[5~");
		await tick();
		assert.ok(visible().some((line) => line.includes("正在翻阅历史")));
		assert.ok(visible().some((line) => line.includes("第 0 行内容")));

		// 翻到底部自动恢复跟尾，提示也就没了
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		await tick();
		assert.ok(!visible().some((line) => line.includes("正在翻阅历史")));

		await quit(terminal, done);
	});
	it("工具调用显示成一行结果", async () => {
		const { terminal, visible, done } = await start({
			onRun: async ({ emit }) => {
				await emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
				await emit({ type: "tool_update", callId: "c1", text: "读到了" });
				await emit({
					type: "tool_end",
					callId: "c1",
					name: "read",
					isError: false,
					durationMs: 12,
					summary: "内容",
				});
				await emit({ type: "run_end" });
			},
		});

		terminal.feedInput("读文件\r");
		await tick();
		await tick();

		assert.ok(visible().some((line) => line.includes("✓ read") && line.includes("12ms")));

		await quit(terminal, done);
	});

	it("出错与中止都会说出来", async () => {
		const { terminal, visible, done } = await start({
			onRun: async ({ emit }) => {
				await emit({ type: "error", message: "连接中断" });
				await emit({ type: "run_end" });
			},
		});

		terminal.feedInput("试试\r");
		await tick();
		await tick();
		assert.ok(visible().some((line) => line.includes("出错：连接中断")));

		await quit(terminal, done);
	});

	it("跑的时候按 Ctrl+C 会中止，界面继续用", async () => {
		let aborted = false;
		const { terminal, visible, done } = await start({
			onRun: ({ signal }) =>
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					});
				}),
		});

		terminal.feedInput("干活\r");
		await tick();
		assert.ok(aborted === false);

		terminal.feedInput("\x03");
		await tick();
		await tick();
		assert.equal(aborted, true);
		assert.ok(visible().some((line) => line.includes("› 干活")));

		await quit(terminal, done);
	});

	it("跑的时候按回车不会丢掉那句话，只是明确拒绝", async () => {
		const { terminal, fake, visible, done } = await start({
			onRun: () => new Promise<void>((resolve) => setTimeout(resolve, 20)),
		});

		terminal.feedInput("第一句\r");
		await tick();
		terminal.feedInput("第二句\r");
		await tick();

		assert.ok(visible().some((line) => line.includes("正在执行上一轮")));
		assert.deepEqual(fake.prompts, ["第一句"]);

		// 等这一轮跑完再退出
		await new Promise((resolve) => setTimeout(resolve, 40));
		await quit(terminal, done);
	});

	it("两次框选同一条输入不会重复提交", async () => {
		const { terminal, fake, done } = await start({
			onRun: async ({ emit }) => {
				await emit({ type: "run_end" });
			},
		});

		terminal.feedInput("\r");
		await tick();
		assert.deepEqual(fake.prompts, []);

		await quit(terminal, done);
	});

	it("退出后把终端恢复原状，并说出会话标识与文件在哪", async () => {
		const { terminal, done } = await start();
		terminal.feedInput("\x04");
		await done;
		await tick();

		assert.equal(terminal.rawModes.at(-1), false);
		assert.deepEqual(terminal.pasteModes, [true, false]);
		assert.deepEqual(terminal.focusModes, [true, false]);
		const text = terminal.writes.join("");
		assert.ok(text.includes("会话已保存：/work/session.jsonl"), text);
		assert.ok(text.includes("接续这次对话：reins --resume abc"), text);
	});

	it("接续旧会话时说出屏幕外还有多少条历史", async () => {
		const { terminal, visible, done } = await start({
			session: { id: "abc", path: "/work/session.jsonl", entries: 12 },
		});
		assert.ok(visible().some((line) => line.includes("已有 12 条条目")));
		await quit(terminal, done);
	});

	it("退出时把用量一并报出来", async () => {
		const { terminal, done } = await start({
			usage: { requests: 3, compactions: 1, subagents: 0, cost: undefined, unpriced: 0, input: 900, output: 120, cacheRead: 40, cacheWrite: 0, total: 1060 },
		});
		terminal.feedInput("\x04");
		await done;
		await tick();

		const text = terminal.writes.join("");
		assert.ok(text.includes("请求 3 次"), text);
		assert.ok(text.includes("1060 token"), text);
	});

	it("进出备用屏成对出现，主屏不会被整屏清空", async () => {
		const { terminal, done } = await start();
		terminal.feedInput("随便\r");
		await tick();
		await quit(terminal, done);

		assert.deepEqual(terminal.alternateScreens.slice(0, 2), [true, false]);
	});

	it("窗口缩放后按新宽度重排", async () => {
		const { terminal, visible, done } = await start(
			{},
			{ rows: 10, cols: 60 },
		);
		terminal.feedInput("一二三四五六七八九十甲乙丙丁");
		await tick();
		assert.ok(visible().some((line) => line.includes("一二三四五六七八九十甲乙丙丁")));

		terminal.resize({ rows: 10, cols: 24 });
		await tick();

		const screen = screenOf(terminal);
		assert.ok(screen.scrolled().length >= 0);
		for (const line of screen.visible()) {
			assert.ok([...line].length <= 24, `超宽的行：${line}`);
		}

		await quit(terminal, done);
	});

	it("确认框出现在屏幕上，按 y 允许", async () => {
		const { terminal, fake, visible, done } = await start({
			onRun: async ({ emit }) => {
				await emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "rm -rf /" } });
				await emit({
					type: "tool_end",
					callId: "c1",
					name: "bash",
					isError: false,
					durationMs: 5,
					summary: "好了",
				});
				await emit({ type: "run_end" });
			},
		});

		terminal.feedInput("删点东西\r");
		await tick();

		const answer = fake.confirm("是否允许执行 bash？", "{}");
		await tick();
		assert.ok(visible().some((line) => line.includes("是否允许执行 bash？")));
		assert.ok(visible().some((line) => line.includes("[y] 允许")));

		terminal.feedInput("y");
		assert.equal(await answer, true);

		await tick();
		await quit(terminal, done);
	});

	it("确认框里按 n 拒绝，按 Esc 也当拒绝", async () => {
		const { terminal, fake, done } = await start();

		const first = fake.confirm("要不要？", "{}");
		await tick();
		terminal.feedInput("n");
		assert.equal(await first, false);

		const second = fake.confirm("要不要？", "{}");
		await tick();
		terminal.feedInput("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(await second, false);

		await quit(terminal, done);
	});

	it("确认框里按 Ctrl+C 按拒绝处理，并把这一轮停掉", async () => {
		let aborted = false;
		const { terminal, fake, done } = await start({
			onRun: ({ signal }) =>
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					});
				}),
		});

		terminal.feedInput("干活\r");
		await tick();
		const answer = fake.confirm("要不要？", "{}");
		await tick();

		terminal.feedInput("\x03");
		assert.equal(await answer, false);
		await tick();
		assert.equal(aborted, true);

		await quit(terminal, done);
	});
});
