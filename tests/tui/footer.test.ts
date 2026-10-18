import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FOOTER_HEIGHT, inputView, renderFooter, type FooterInfo } from "../../src/tui/footer.ts";

const BORDER = "─";
const FOCUS = "\x1b[38;2;225;225;225m";
const BLUR = "\x1b[38;2;36;36;36m";
const INFO = "\x1b[38;2;200;200;200m";

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
	it("获得焦点时边框和提示符用 #e1e1e1", () => {
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

	it("失去焦点时边框和提示符用 #242424", () => {
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

	it("常驻信息行按显示宽度截断，不切半个 emoji", () => {
		assert.equal(plain(renderFooter(10, "", true, undefined, SESSION_INFO)[5] ?? ""), "📁 Reins");
		assert.equal(plain(renderFooter(9, "", true, undefined, SESSION_INFO)[5] ?? ""), "📁 Rein");
	});

	it("缓存命中率按整数百分比显示", () => {
		const lines = renderFooter(120, "", true, undefined, { ...SESSION_INFO, cacheHitRate: 0.984 });

		assert.ok(plain(lines[5] ?? "").endsWith("⚡ 98%"));
	});

	it("输入超出宽度时保留尾部", () => {
		const lines = renderFooter(5, "abcdef", true);
		assert.equal(plain(lines[3]), " › f");
	});

	it("宽字符按两列计算，不留下半个字", () => {
		const lines = renderFooter(6, "你好世界", true);
		assert.equal(plain(lines[3]), " › 界");
	});

	it("有运行时状态时显示加载符号与文字", () => {
		const lines = renderFooter(40, "", true, { symbol: "⠋", text: "Waiting for response..." });

		assert.equal(lines[0], "");
		assert.equal(lines[1], " ⠋ Waiting for response...");
		assert.equal(lines[1]?.length, 26);
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
		const right = "1.2s  ⇣128";
		const raw = lines[1] ?? "";

		assert.equal(plain(raw), left + " ".repeat(58 - left.length - right.length) + right);
		assert.ok(raw.includes("\x1b[38;2;102;102;102m"));
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
		assert.ok(raw.includes("\x1b[38;2;102;102;102m  2.5s"));
		assert.ok(raw.endsWith("\x1b[0m"));
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
		const meta = "\x1b[38;2;102;102;102m";
		const raw = lines[1] ?? "";
		const tail = raw.slice(raw.lastIndexOf(meta));

		assert.ok(tail.includes("2.5s"));
		assert.ok(tail.includes("5.3s  ⇣21.4K"));
		assert.ok(tail.endsWith("\x1b[0m"));
		assert.equal(plain(raw).length, 68);
	});

	it("状态行超出宽度时截断", () => {
		const lines = renderFooter(12, "", true, { symbol: "⠋", text: "Waiting for response..." });
		assert.equal(lines[1], " ⠋ Waiting");
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
