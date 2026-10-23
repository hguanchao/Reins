import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	COMPACT_FOOTER_HEIGHT,
	FOOTER_HEIGHT,
	inputView,
	queueHeight,
	renderFooter,
	type FooterInfo,
} from "../../src/tui/footer.ts";

const BORDER = "─";
const FOCUS = "\x1b[38;2;78;201;176m";
const BLUR = "\x1b[38;2;42;49;56m";
const INFO = "\x1b[38;2;167;176;186m";

const SESSION_INFO: FooterInfo = {
	project: "Reins",
	branch: "main",
	model: "gpt-5.6-luna",
	effort: "max",
	contextUsed: 100_000,
	contextWindow: 1_000_000,
	cacheHitRate: 0.98,
};

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("页脚输入框", () => {
	it("获得焦点时边框和提示符用强调色 #4ec9b0", () => {
		const lines = renderFooter(10, "", true);

		assert.equal(lines.length, FOOTER_HEIGHT);
		assert.equal(lines[0], "");
		assert.equal(lines[1], "");
		assert.ok(lines[2].startsWith(FOCUS));
		assert.equal(plain(lines[2]), BORDER.repeat(10));
		assert.ok(lines[3].startsWith(FOCUS));
		assert.equal(plain(lines[3]), " › ");
		assert.ok(lines[4].startsWith(FOCUS));
		assert.equal(plain(lines[4]), BORDER.repeat(10));
		assert.equal(lines[5], "");
	});

	it("失去焦点时边框和提示符用边框色 #2a3138", () => {
		const lines = renderFooter(10, "", false);

		assert.equal(lines[0], "");
		assert.ok(lines[2].startsWith(BLUR));
		assert.ok(lines[3].startsWith(BLUR));
		assert.equal(plain(lines[2]), BORDER.repeat(10));
		assert.equal(plain(lines[3]), " › ");
		assert.equal(plain(lines[4]), BORDER.repeat(10));
	});

	it("输入文字排在提示符之后，不受焦点颜色影响", () => {
		const lines = renderFooter(10, "abc", true);

		assert.equal(plain(lines[3]), " › abc");
		assert.ok(lines[3].startsWith(FOCUS));
		assert.ok(lines[3].endsWith("abc"));
	});

	it("命中的命令着色，参数保持正文色", () => {
		const lines = renderFooter(40, "/model 当前", true, undefined, undefined, {
			commandLength: 6,
		});
		const line = lines[3] ?? "";

		// 提示符是强调色，命令本身也是强调色，参数回到正文
		assert.equal(plain(line), " › /model 当前");
		assert.ok(line.includes(`${FOCUS}/model${"\x1b[0m"}`));
		assert.ok(line.endsWith(" 当前"));
	});

	it("没命中命令时不加任何颜色", () => {
		const lines = renderFooter(40, "/mod", true, undefined, undefined, { commandLength: 0 });
		const line = lines[3] ?? "";

		assert.equal(plain(line), " › /mod");
		assert.equal(line.split(FOCUS).length, 2);
	});

	it("输入框下方显示项目、分支、模型、思考强度、上下文与缓存命中率", () => {
		const lines = renderFooter(120, "", true, undefined, SESSION_INFO);
		const line = lines[5] ?? "";

		assert.equal(
			plain(line),
			"📁 Reins · 🌿 main | 🤖 gpt-5.6-luna · 🧠 max | 📊 100K / 1M | ⚡ 98%",
		);
		assert.ok(line.startsWith(INFO));
		assert.ok(line.endsWith("\x1b[0m"));
	});

	it("不在 git 仓库时不显示分支项", () => {
		const lines = renderFooter(120, "", true, undefined, { ...SESSION_INFO, branch: undefined });

		assert.equal(plain(lines[5] ?? ""), "📁 Reins | 🤖 gpt-5.6-luna · 🧠 max | 📊 100K / 1M | ⚡ 98%");
	});

	it("上下文上限未声明时只显示已用量", () => {
		const lines = renderFooter(120, "", true, undefined, {
			...SESSION_INFO,
			contextWindow: undefined,
		});

		assert.ok(plain(lines[5] ?? "").includes("📊 100K |"));
	});

	it("窄终端按优先级舍弃：先丢缓存，再丢位置，再丢模型，最后只留上下文", () => {
		const lineAt = (width: number): string =>
			plain(renderFooter(width, "", true, undefined, SESSION_INFO)[5] ?? "");

		assert.ok(lineAt(80).endsWith("| ⚡ 98%"));
		assert.equal(
			lineAt(70),
			"📁 Reins · 🌿 main | 🤖 gpt-5.6-luna · 🧠 max | 📊 100K / 1M",
		);
		assert.equal(lineAt(50), "🤖 gpt-5.6-luna · 🧠 max | 📊 100K / 1M");
		assert.equal(lineAt(20), "📊 100K / 1M");
	});

	it("审批徽标固定停在行尾，正文照常排在左侧", () => {
		const line = plain(renderFooter(120, "", true, undefined, { ...SESSION_INFO, approval: "yolo" })[5] ?? "");

		assert.ok(line.endsWith("YOLO"));
		// 徽标只占右端固定几列：原本完整的一组信息仍全部在位
		assert.ok(line.startsWith("📁 Reins · 🌿 main | 🤖 gpt-5.6-luna · 🧠 max | 📊 100K / 1M | ⚡ 98%"));
	});

	it("窄到放不下徽标时整档让位，不折行", () => {
		// 宽度不足以在行尾（避开最右两列）摆下 4 列的 YOLO 与至少一列间隔
		const line = plain(renderFooter(6, "", true, undefined, { ...SESSION_INFO, approval: "yolo" })[5] ?? "");

		assert.equal(line.includes("YOLO"), false);
		assert.ok(line.length > 0);
	});

	it("三档审批徽标各自用对应颜色", () => {
		const ASK = "\x1b[38;2;78;201;176m";
		const WARNING = "\x1b[38;2;224;175;104m";
		const ERROR = "\x1b[38;2;224;108;117m";
		const line = (approval: "ask" | "auto" | "yolo"): string =>
			renderFooter(120, "", true, undefined, { ...SESSION_INFO, approval })[5] ?? "";

		assert.ok(line("ask").includes(`${ASK}ASK`));
		assert.ok(line("auto").includes(`${WARNING}AUTO`));
		assert.ok(line("yolo").includes(`${ERROR}YOLO`));
	});

	it("省略审批时不画徽标，整行回到原有排版", () => {
		const line = renderFooter(120, "", true, undefined, SESSION_INFO)[5] ?? "";

		assert.equal(line.includes("ASK"), false);
		assert.equal(line.includes("AUTO"), false);
		assert.equal(line.includes("YOLO"), false);
	});

	it("上下文本身放不下时按显示宽度截断，不切半个 emoji", () => {
		assert.equal(plain(renderFooter(10, "", true, undefined, SESSION_INFO)[5] ?? ""), "📊 100K");
		assert.equal(plain(renderFooter(9, "", true, undefined, SESSION_INFO)[5] ?? ""), "📊 100K");
	});

	it("缓存命中率按整数百分比显示", () => {
		const lines = renderFooter(120, "", true, undefined, { ...SESSION_INFO, cacheHitRate: 0.984 });

		assert.ok(plain(lines[5] ?? "").endsWith("⚡ 98%"));
	});

	it("100 到 999 也进入 K，上下文与运行时状态共用规则", () => {
		const context = renderFooter(120, "", true, undefined, {
			...SESSION_INFO,
			contextUsed: 999,
		});
		assert.ok(plain(context[5] ?? "").includes("📊 0.9K / 1M"));

		const status = renderFooter(80, "", true, {
			symbol: "⠋",
			text: "Thinking...",
			tokens: 999,
		});
		assert.ok(plain(status[1] ?? "").includes("⇣0.9K"));
	});

	it("运行时 token 数超过一百万时晋升到 M", () => {
		const lines = renderFooter(80, "", true, {
			symbol: "⠋",
			text: "Thinking...",
			tokens: 1_500_000,
		});

		assert.ok(plain(lines[1] ?? "").includes("⇣1.5M"));
	});

	it("接近一百万的 K 值直接进位成 M，不显示 1000K", () => {
		const lines = renderFooter(120, "", true, undefined, {
			...SESSION_INFO,
			contextUsed: 999_950,
		});

		assert.ok(plain(lines[5] ?? "").includes("📊 1M / 1M"));
	});

	it("输入超出宽度时保留尾部", () => {
		const lines = renderFooter(5, "abcdef", true);
		assert.equal(plain(lines[3]), " › f");
	});

	it("菜单打开时使用紧凑页脚，去掉空白与状态行", () => {
		const lines = renderFooter(20, "/model", false, undefined, SESSION_INFO, {
			leadingGap: false,
			showStatus: false,
		});

		assert.equal(lines.length, COMPACT_FOOTER_HEIGHT);
		assert.equal(plain(lines[0] ?? ""), BORDER.repeat(20));
		assert.equal(plain(lines[1] ?? ""), " › /model");
		assert.equal(plain(lines[2] ?? ""), BORDER.repeat(20));
		assert.equal(plain(lines[3] ?? ""), "📊 100K / 1M");
	});

	it("宽字符按两列计算，不留下半个字", () => {
		const lines = renderFooter(6, "你好世界", true);
		assert.equal(plain(lines[3]), " › 界");
	});

	it("有运行时状态时显示加载符号与文字", () => {
		const lines = renderFooter(40, "", true, { symbol: "⠋", text: "Waiting for response..." });

		assert.equal(lines[0], "");
		assert.equal(plain(lines[1] ?? ""), " ⠋ Waiting for response...");
		assert.equal(plain(lines[1] ?? "").length, 26);
		assert.equal(plain(lines[3]), " › ");
	});

	it("状态行显示计时与 token 数，右侧对齐", () => {
		const lines = renderFooter(60, "", true, {
			symbol: "⠋",
			text: "Thinking...",
			elapsedMs: 1200,
			tokens: 128,
		});
		const left = " ⠋ Thinking...";
		const right = "1.2s  ⇣0.1K";
		const raw = lines[1] ?? "";

		assert.equal(plain(raw), left + " ".repeat(58 - left.length - right.length) + right);
		assert.ok(raw.includes("\x1b[38;2;107;117;128m"));
		assert.ok(raw.endsWith("\x1b[0m"));
	});

	it("阶段计时在左，总计时与 token 数在右", () => {
		const lines = renderFooter(70, "", true, {
			symbol: "⠧",
			text: "Writing response...",
			phaseMs: 2500,
			elapsedMs: 5300,
			tokens: 21400,
		});
		const left = " ⠧ Writing response...  2.5s";
		const right = "5.3s  ⇣21.4K";
		const raw = lines[1] ?? "";

		assert.equal(plain(raw), left + " ".repeat(68 - left.length - right.length) + right);
		assert.ok(raw.includes("\x1b[38;2;107;117;128m  2.5s"));
		assert.ok(raw.endsWith("\x1b[0m"));
	});

	it("耗时满一分钟后改为分钟与秒", () => {
		const lines = renderFooter(70, "", true, {
			symbol: "⠋",
			text: "Thinking...",
			phaseMs: 65_400,
			elapsedMs: 957_300,
		});
		const text = plain(lines[1] ?? "");

		assert.ok(text.includes("1m5s"));
		assert.ok(text.includes("15m57s"));
	});

	it("整分钟不显示零秒，有零头才带秒", () => {
		const at = (elapsedMs: number): string =>
			plain(
				renderFooter(70, "", true, { symbol: "⠋", text: "Thinking...", elapsedMs })[1] ?? "",
			);

		assert.ok(at(60_000).endsWith("1m"));
		assert.ok(at(61_000).endsWith("1m1s"));
		assert.ok(at(120_000).endsWith("2m"));
	});

	it("扫光只作用于活动描述，计时和 token 保持静态", () => {
		const lines = renderFooter(70, "", true, {
			symbol: "⠧",
			text: "Writing response...",
			phaseMs: 2500,
			elapsedMs: 5300,
			tokens: 21400,
			sweep: 0.5,
		});
		const meta = "\x1b[38;2;107;117;128m";
		const raw = lines[1] ?? "";
		const tail = raw.slice(raw.lastIndexOf(meta));

		assert.ok(tail.includes("2.5s"));
		assert.ok(tail.includes("5.3s  ⇣21.4K"));
		assert.ok(tail.endsWith("\x1b[0m"));
		assert.equal(plain(raw).length, 68);
	});

	it("状态行超出宽度时截断", () => {
		const lines = renderFooter(12, "", true, { symbol: "⠋", text: "Waiting for response..." });
		assert.equal(plain(lines[1] ?? ""), " ⠋ Waiting");
	});

	it("运行时状态可以带扫光", () => {
		const lines = renderFooter(40, "", true, {
			symbol: "⠋",
			text: "Waiting for response...",
			sweep: 0.5,
		});

		assert.equal(plain(lines[1] ?? ""), " ⠋ Waiting for response...");
		assert.ok(lines[1]?.includes("\x1b[38;2;255;255;255m"));
		assert.ok(lines[1]?.endsWith("\x1b[0m"));
	});

	it("多行输入按行显示，光标落在对应行", () => {
		const view = inputView("abc\ndef", 20, 5);
		assert.deepEqual(
			view.lines.map((line) => `${line.prefix}${line.text}`),
			[" › abc", "   def"],
		);
		assert.equal(view.row, 1);
		assert.equal(view.column, 5);

		const lines = renderFooter(20, "abc\ndef", true, undefined, undefined, { cursor: 5 });
		assert.equal(lines.length, FOOTER_HEIGHT + 1);
		assert.equal(plain(lines[3] ?? ""), " › abc");
		assert.equal(plain(lines[4] ?? ""), "   def");
	});

	it("光标列跟着提示符和可见文字走", () => {
		const empty = inputView("", 10);
		assert.equal(empty.prefix, " › ");
		assert.equal(empty.text, "");
		assert.equal(empty.column, 4);

		const ascii = inputView("abc", 10);
		assert.equal(ascii.prefix, " › ");
		assert.equal(ascii.text, "abc");
		assert.equal(ascii.column, 7);

		assert.equal(inputView("你好", 10).column, 8);
		assert.equal(inputView("abcdef", 5).column, 5);
		assert.equal(inputView("abcdef", 5).text, "f");
		assert.equal(inputView("你好世界", 6).column, 6);
		assert.equal(inputView("你好世界", 6).text, "界");
	});
});

describe("排队消息预览", () => {
	it("没有排队消息时不占行", () => {
		assert.equal(queueHeight(0), 0);
		assert.equal(renderFooter(20, "", true).length, FOOTER_HEIGHT);
	});

	it("每条排队消息占一行，排在状态行与输入框上边框之间", () => {
		const lines = renderFooter(40, "", true, { symbol: "⠋", text: "Thinking..." }, undefined, {
			queued: ["顺便更新 README", "然后跑一遍测试"],
		});

		assert.equal(lines.length, FOOTER_HEIGHT + 2);
		assert.equal(queueHeight(2), 2);
		assert.equal(plain(lines[2] ?? ""), " ↳ 顺便更新 README");
		assert.equal(plain(lines[3] ?? ""), " ↳ 然后跑一遍测试");
		// 上边框挪到排队行之后，输入行紧跟其后
		assert.equal(plain(lines[4] ?? ""), BORDER.repeat(40));
		assert.equal(plain(lines[5] ?? ""), " › ");
	});

	it("超出上限时收成一行计数", () => {
		const lines = renderFooter(40, "", true, undefined, undefined, {
			queued: ["一", "二", "三", "四", "五"],
		});

		assert.equal(queueHeight(5), 4);
		assert.equal(lines.length, FOOTER_HEIGHT + 4);
		assert.equal(plain(lines[2] ?? ""), " ↳ 一");
		assert.equal(plain(lines[4] ?? ""), " ↳ 三");
		assert.equal(plain(lines[5] ?? ""), "   +2 more");
		assert.equal(plain(lines[6] ?? ""), BORDER.repeat(40));
	});

	it("单条消息压成一行并按宽度截断", () => {
		const lines = renderFooter(16, "", true, undefined, undefined, {
			queued: ["第一行\n第二行\t制表"],
		});

		// 换行与制表符都压成一个空格；宽度 16 去掉 " ↳ " 与右侧留白后只放得下 12 列
		assert.equal(plain(lines[2] ?? ""), " ↳ 第一行 第二");
	});

	it("预览用弱化色，与正文区分", () => {
		const lines = renderFooter(30, "", true, undefined, undefined, { queued: ["稍后再说"] });

		assert.ok(lines[2]?.startsWith("\x1b[38;2;107;117;128m"));
		assert.ok(lines[2]?.endsWith("\x1b[0m"));
	});

	it("紧凑页脚不显示排队预览：菜单打开时它会让面板错位", () => {
		const lines = renderFooter(30, "", false, undefined, undefined, {
			leadingGap: false,
			showStatus: false,
			queued: ["稍后再说"],
		});

		assert.equal(lines.length, COMPACT_FOOTER_HEIGHT);
		assert.equal(lines.some((line) => plain(line).includes("↳")), false);
	});
});
