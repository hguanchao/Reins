import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TerminalFrontend } from "../../../src/plugins/tui-plugin/frontend.ts";
import { MemoryTerminal, screenOf } from "../../tui/memory-terminal.ts";
import { makeRuntime, textEvents, tick, type RuntimeScript } from "./helpers.ts";

/** 一条长的回答：行数足够超过一屏，用来验证主区的翻阅。 */
const LONG_REPLY = Array.from({ length: 12 }, (_, index) => `第 ${index} 行内容`).join("\n\n");

/** 把整段长回答一次吐完的一轮。 */
const LONG_TURN: NonNullable<RuntimeScript["onRun"]> = async ({ emit }) => {
	for (const event of textEvents(LONG_REPLY)) await emit(event);
	await emit({ type: "run_end" });
};

/** 顶部两行是状态行与空行，底部五行是输入框三行加快捷键条，中间才是会话区。 */
const HEADER_ROWS = 2;
const FOOTER_ROWS = 5;
/** 跑着的时候会话区底下多出空行与状态行，它每一帧都在动。 */
const RUNNING_ROWS = 2;

/** 会话区当前显示的内容。 */
function mainArea(terminal: MemoryTerminal): string[] {
	const screen = screenOf(terminal);
	return screen.visible().slice(HEADER_ROWS, screen.rows - FOOTER_ROWS);
}

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
				.map((line) => line.trim())
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
	it("首屏摆出入口框：模型、菜单与开场提示", async () => {
		const { terminal, visible, done } = await start({}, { rows: 24, cols: 80 });
		const lines = visible();
		assert.ok(lines.some((line) => line.includes("Reins") && line.includes("demo/m1")));
		assert.ok(lines.some((line) => line.includes("说点什么开始")));
		assert.ok(lines.some((line) => line.startsWith("╭")));
		assert.ok(lines.some((line) => line.includes("全部命令") && line.includes("/help")));
		assert.ok(lines.some((line) => line.includes("退出") && line.includes("/exit")));
		await quit(terminal, done);
	});

	it("顶部一行报出用量，右侧是模型与两个开关", async () => {
		const { terminal, visible, done } = await start({
			usage: {
				requests: 3,
				compactions: 1,
				subagents: 0,
				cost: 0.0123,
				unpriced: 0,
				input: 900,
				output: 120,
				cacheRead: 40,
				cacheWrite: 0,
				total: 1060,
			},
		}, { rows: 24, cols: 80 });
		const top = visible()[0];
		assert.ok(top.includes("1.1k token"), top);
		assert.ok(top.includes("$0.01"), top);
		assert.ok(top.includes("demo/m1"), top);
		assert.ok(top.includes("approval=ask") && top.includes("sandbox=off"), top);
		await quit(terminal, done);
	});

	it("输入框把模型与审批状态嵌在下边框里", async () => {
		const { terminal, visible, done } = await start({}, { rows: 24, cols: 80 });
		assert.ok(
			visible().some(
				(line) => line.includes("╰─") && line.includes("demo/m1 · approval=ask · sandbox=off"),
			),
		);
		await quit(terminal, done);
	});

	it("没有信任工作区时在首屏把这件事说出来", async () => {
		const { terminal, visible, done } = await start(
			{ trust: { trusted: false, root: "/work", files: ["/work/.reins/config.toml"] } },
			{ rows: 24, cols: 80 },
		);
		assert.ok(visible().some((line) => line.includes("工作区自带的配置没有读取")));
		await quit(terminal, done);
	});

	it("接续旧会话时说出屏幕外还有多少条历史", async () => {
		const { terminal, visible, done } = await start(
			{ session: { id: "abc", path: "/work/session.jsonl", entries: 12 } },
			{ rows: 24, cols: 80 },
		);
		assert.ok(visible().some((line) => line.includes("已有 12 条条目")));
		await quit(terminal, done);
	});

	it("输入的内容显示在输入框里", async () => {
		const { terminal, visible, done } = await start();
		terminal.feedInput("你好");
		await tick();
		assert.ok(visible().some((line) => line.includes("❯ 你好")));
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
		assert.ok(lines.some((line) => line.includes("❯ 问题")));
		assert.ok(lines.some((line) => line.includes("答案是 42")));
		// 说过话之后就不再是首屏了
		assert.ok(!lines.some((line) => line.includes("说点什么开始")));

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

		const line = visible().find((item) => item.includes("◆ read"));
		assert.ok(line !== undefined, visible().join("\n"));
		assert.ok(line.includes('{"path":"a.ts"}'), line);
		assert.ok(line.endsWith("12ms"), line);

		await quit(terminal, done);
	});

	it("失败的工具调用把原因单独说一行", async () => {
		const { terminal, visible, done } = await start({
			onRun: async ({ emit }) => {
				await emit({ type: "tool_start", callId: "c1", name: "bash", args: { command: "ls" } });
				await emit({
					type: "tool_end",
					callId: "c1",
					name: "bash",
					isError: true,
					durationMs: 5,
					summary: "没这条命令",
				});
				await emit({ type: "run_end" });
			},
		});

		terminal.feedInput("跑一下\r");
		await tick();
		await tick();

		assert.ok(visible().some((line) => line.includes("◆ bash")));
		assert.ok(visible().some((line) => line.includes("没这条命令")));

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
		assert.ok(visible().some((line) => line.includes("✗ 出错：连接中断")));

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
		assert.equal(aborted, false);

		terminal.feedInput("\x03");
		await tick();
		await tick();
		assert.equal(aborted, true);
		assert.ok(visible().some((line) => line.includes("❯ 干活")));

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

	it("空输入按回车什么也不做", async () => {
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

	it("跑起来时中间多出一行：当前动作与这一轮的耗时", async () => {
		const { terminal, visible, done } = await start({
			onRun: ({ signal }) =>
				new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => resolve());
				}),
		});

		terminal.feedInput("干活\r");
		await tick();
		assert.ok(visible().some((line) => line.includes("正在思考")), visible().join("\n"));
		// 跑的时候快捷键条先把中止摆在最前面
		assert.ok(visible().some((line) => line.includes("Ctrl+C") && line.includes("中止")));

		terminal.feedInput("\x03");
		await tick();
		await quit(terminal, done);
	});

	it("退出后把终端恢复原状，并留下接续命令", async () => {
		const { terminal, done } = await start();
		terminal.feedInput("\x04");
		await done;
		await tick();

		assert.equal(terminal.rawModes.at(-1), false);
		assert.deepEqual(terminal.pasteModes, [true, false]);
		assert.deepEqual(terminal.focusModes, [true, false]);
		assert.deepEqual(terminal.mouseModes, [true, false]);
		const text = terminal.writes.join("");
		assert.ok(text.includes("reins --resume abc"), text);
	});

	it("主屏上只留接续命令，不再报用量", async () => {
		const { terminal, done } = await start({
			usage: {
				requests: 3,
				compactions: 1,
				subagents: 0,
				cost: undefined,
				unpriced: 0,
				input: 900,
				output: 120,
				cacheRead: 40,
				cacheWrite: 0,
				total: 1060,
			},
		});
		terminal.feedInput("\x04");
		await done;
		await tick();

		// 交还主屏后只写这一行：屏幕上那些帧里带着用量，但退出后留下的只有它
		assert.equal(terminal.writes.at(-1), "reins --resume abc" + String.fromCharCode(10));
	});

	it("进出备用屏成对出现，主屏不会被整屏清空", async () => {
		const { terminal, done } = await start();
		terminal.feedInput("随便\r");
		await tick();
		await quit(terminal, done);

		assert.deepEqual(terminal.alternateScreens.slice(0, 2), [true, false]);
	});

	it("窗口缩放后按新宽度重排", async () => {
		const { terminal, visible, done } = await start({}, { rows: 10, cols: 60 });
		terminal.feedInput("一二三四五六七八九十甲乙丙丁");
		await tick();
		assert.ok(visible().some((line) => line.includes("一二三四五六七八九十甲乙丙丁")));

		terminal.resize({ rows: 10, cols: 24 });
		await tick();

		for (const line of screenOf(terminal).visible()) {
			assert.ok([...line].length <= 24, `超宽的行：${line}`);
		}

		await quit(terminal, done);
	});
});

describe("翻阅历史", () => {
	it("PageUp 向上翻阅，PageDown 回到底部", async () => {
		const { terminal, visible, done } = await start({ onRun: LONG_TURN }, { rows: 24, cols: 40 });

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		// 跟尾时只能看到最后一段
		assert.ok(!visible().some((line) => line.includes("第 0 行内容")));

		terminal.feedInput("\x1b[5~");
		await tick();
		assert.ok(visible().some((line) => line.includes("第 0 行内容")));
		// 翻阅时快捷键条说的是怎么翻
		assert.ok(visible().some((line) => line.includes("PageUp/PageDown") && line.includes("翻页")));

		// 翻到底部自动恢复跟尾，提示也就没了
		terminal.feedInput("\x1b[6~");
		terminal.feedInput("\x1b[6~");
		await tick();
		assert.ok(!visible().some((line) => line.includes("PageUp/PageDown")));

		await quit(terminal, done);
	});

	it("滚轮向上翻阅历史，向下滚回末尾", async () => {
		const { terminal, visible, done } = await start({ onRun: LONG_TURN }, { rows: 24, cols: 40 });

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		terminal.feedInput("\x1b[<64;10;5M");
		terminal.feedInput("\x1b[<64;10;5M");
		terminal.feedInput("\x1b[<64;10;5M");
		await tick();
		assert.ok(visible().some((line) => line.includes("第 0 行内容")));

		terminal.feedInput("\x1b[<65;10;5M");
		terminal.feedInput("\x1b[<65;10;5M");
		terminal.feedInput("\x1b[<65;10;5M");
		await tick();
		assert.ok(!visible().some((line) => line.includes("第 0 行内容")));

		await quit(terminal, done);
	});

	it("Ctrl+P 与 Ctrl+N 逐行翻阅", async () => {
		const { terminal, done } = await start({ onRun: LONG_TURN }, { rows: 24, cols: 40 });

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		// 先翻到最早那一行：跑着的时候主区还少两行，翻页到不了顶，用 Home 一步到位
		terminal.feedInput("\x1b[5~\x1b[H");
		await tick();
		assert.ok(mainArea(terminal)[0].includes("❯ 写点什么"), mainArea(terminal)[0]);

		terminal.feedInput("\x0e");
		await tick();
		assert.ok(mainArea(terminal)[0].includes("第 0 行内容"), mainArea(terminal)[0]);

		terminal.feedInput("\x10");
		await tick();
		assert.ok(mainArea(terminal)[0].includes("❯ 写点什么"), mainArea(terminal)[0]);

		await quit(terminal, done);
	});

	it("翻阅时 Home 跳到最早，End 回到末尾", async () => {
		const { terminal, visible, done } = await start({ onRun: LONG_TURN }, { rows: 24, cols: 40 });

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		terminal.feedInput("\x1b[5~\x1b[H");
		await tick();
		assert.ok(mainArea(terminal)[0].includes("❯ 写点什么"), mainArea(terminal)[0]);

		terminal.feedInput("\x1b[F");
		await tick();
		assert.ok(!visible().some((line) => line.includes("PageUp/PageDown")));
		assert.ok(visible().some((line) => line.includes("第 11 行内容")), visible().join("\n"));

		await quit(terminal, done);
	});

	it("跟尾时 Home 与 End 仍归输入框管", async () => {
		const { terminal, visible, done } = await start({ onRun: LONG_TURN }, { rows: 24, cols: 40 });

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		terminal.feedInput("ab\x1b[Hc");
		await tick();
		assert.ok(visible().some((line) => line.includes("❯ cab")), visible().join("\n"));
		// 光标跳行首并没有顺手把画面翻到最早
		assert.ok(!visible().some((line) => line.includes("PageUp/PageDown")));

		terminal.feedInput("\x1b[Fd");
		await tick();
		assert.ok(visible().some((line) => line.includes("❯ cabd")));

		await quit(terminal, done);
	});

	it("翻阅期间新到的内容不把画面推走", async () => {
		let more: (() => Promise<void>) | undefined;
		const { terminal, visible, done } = await start(
			{
				onRun: async ({ emit }) => {
					for (const event of textEvents(LONG_REPLY)) await emit(event);
					// 写到这里去调工具：已经写好的部分定稿进历史，活动块只剩这一行工具
					await emit({ type: "tool_start", callId: "c1", name: "read", args: { path: "a.ts" } });
					// 停在这里，等测试把画面翻上去以后再接着来东西
					await new Promise<void>((resolve) => {
						more = async () => {
							await emit({ type: "tool_update", callId: "c1", text: "读到一半" });
							resolve();
						};
					});
					await emit({
						type: "tool_end",
						callId: "c1",
						name: "read",
						isError: false,
						durationMs: 5,
						summary: "好了",
					});
					await emit({ type: "run_end" });
				},
			},
			{ rows: 24, cols: 40 },
		);

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		// 跑着的时候主区少两行：翻两次才到顶；状态行每一帧都在动，比较时把它去掉
		const content = (): string[] => mainArea(terminal).slice(0, -RUNNING_ROWS);
		terminal.feedInput("\x1b[5~");
		terminal.feedInput("\x1b[5~");
		await tick();
		const before = content();
		assert.ok(before.some((line) => line.includes("第 0 行内容")), before.join("\n"));

		await more?.();
		await tick();
		// 画面一行都没动：新内容接在末尾，视口还钉在原处
		assert.deepEqual(content(), before);
		assert.ok(!visible().some((line) => line.includes("读到一半")), visible().join("\n"));

		await quit(terminal, done);
	});

	it("发出新的一句就回到末尾", async () => {
		const { terminal, visible, done } = await start(
			{
				onRun: async ({ prompt, emit }) => {
					const text = prompt === "第一句" ? LONG_REPLY : "短回答";
					for (const event of textEvents(text)) await emit(event);
					await emit({ type: "run_end" });
				},
			},
			{ rows: 24, cols: 40 },
		);

		terminal.feedInput("第一句\r");
		await tick();
		await tick();

		terminal.feedInput("\x1b[5~");
		await tick();
		assert.ok(visible().some((line) => line.includes("PageUp/PageDown")));

		terminal.feedInput("再来\r");
		await tick();
		await tick();
		assert.ok(!visible().some((line) => line.includes("PageUp/PageDown")), visible().join("\n"));
		assert.ok(visible().some((line) => line.includes("❯ 再来")));
		assert.ok(visible().some((line) => line.includes("短回答")));

		await quit(terminal, done);
	});

	it("确认卡片问着的时候也能翻上去看清楚", async () => {
		const { terminal, fake, visible, done } = await start({ onRun: LONG_TURN }, { rows: 24, cols: 40 });

		terminal.feedInput("写点什么\r");
		await tick();
		await tick();

		const answer = fake.confirm("是否允许执行 bash？", "{}");
		await tick();
		assert.ok(visible().some((line) => line.includes("是否允许执行 bash？")));

		// 卡片又占掉六行：翻三次才到顶
		terminal.feedInput("\x1b[5~\x1b[5~\x1b[5~");
		await tick();
		assert.ok(visible().some((line) => line.includes("第 0 行内容")), visible().join("\n"));
		// 问题本身在卡片里，翻页翻不掉
		assert.ok(visible().some((line) => line.includes("是否允许执行 bash？")));

		terminal.feedInput("1");
		assert.equal(await answer, true);

		await tick();
		await quit(terminal, done);
	});
});

describe("回合轨道", () => {
	it("两个回合之后在右侧出现，当前回合点亮", async () => {
		const { terminal, visible, done } = await start({ onRun: LONG_TURN }, { rows: 20, cols: 80 });

		terminal.feedInput("第一句\r");
		await tick();
		await tick();

		// 只有一个回合时不放轨道：那几列留给正文
		assert.ok(!visible().some((line) => line.includes("▴")));

		terminal.feedInput("第二句\r");
		await tick();
		await tick();

		const lines = screenOf(terminal).visible();
		assert.ok(lines.some((line) => line.endsWith("▴")), lines.join("\n"));
		assert.ok(lines.some((line) => line.endsWith("▾")), lines.join("\n"));
		assert.ok(lines.some((line) => line.endsWith("━━")), lines.join("\n"));

		await quit(terminal, done);
	});
});
