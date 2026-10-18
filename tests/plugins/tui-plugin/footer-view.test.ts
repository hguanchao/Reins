import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INPUT_LEFT } from "../../../src/plugins/tui-plugin/input-box.ts";
import { footerHints, runningRow } from "../../../src/plugins/tui-plugin/footer-view.ts";
import { THEME } from "../../../src/plugins/tui-plugin/theme.ts";
import { lineText, lineWidth } from "../../../src/tui/text/line.ts";

describe("运行状态行", () => {
	it("左边与输入框提示符同列，动作后面跟这一步的耗时，右缘是整轮耗时、上下文规模与停止按钮", () => {
		const { line } = runningRow({
			activity: "Running Read",
			startedAt: 0,
			phaseStartedAt: 9_500,
			tokens: 12_345,
			width: 60,
			now: 10_000,
		});
		const text = lineText(line);
		assert.equal(text.indexOf("⠸"), INPUT_LEFT, "指示器与输入框的提示符同列");
		assert.ok(text.includes("Running Read 500ms"), `阶段耗时紧跟动作: ${text}`);
		assert.ok(text.endsWith("10s ⇣12.3k  [stop]"), `整轮耗时、令牌数与按钮贴住右缘: ${text}`);
		// 占输入框的内区：右侧让出右边框那一格
		assert.equal(lineWidth(line), 60 - 3);
	});

	it("还没有令牌数时只显示整轮耗时", () => {
		const { line } = runningRow({
			activity: "Thinking",
			startedAt: 0,
			phaseStartedAt: 0,
			tokens: 0,
			width: 60,
			now: 1_000,
		});
		const text = lineText(line);
		assert.ok(text.endsWith("1.0s  [stop]"), `右缘只留耗时与按钮: ${text}`);
		assert.ok(!text.includes("⇣"), `不写空的令牌数: ${text}`);
	});

	it("窄屏先隐藏阶段计时，动作名截断，整轮计时与令牌数不动", () => {
		const { line } = runningRow({
			activity: "Running A_Very_Long_Tool_Name_For_Truncation",
			startedAt: 0,
			phaseStartedAt: 9_500,
			tokens: 12_345,
			width: 40,
			now: 10_000,
		});
		const text = lineText(line);
		assert.ok(text.includes("…"), `动作名截断: ${text}`);
		assert.ok(!text.includes("500ms"), `窄屏不画阶段耗时: ${text}`);
		assert.ok(text.endsWith("10s ⇣12.3k  [stop]"), `整轮耗时、令牌数与按钮仍在: ${text}`);
		assert.equal(lineWidth(line), 40 - 3);
	});

	it("指针停在按钮上时停止变红、跟随变亮", () => {
		const { line } = runningRow({
			activity: "Thinking…",
			startedAt: 0,
			phaseStartedAt: 0,
			tokens: 1_000,
			width: 60,
			now: 5_000,
			following: false,
			stopHover: true,
			followHover: true,
		});
		assert.equal(line.find((span) => span.text === "[stop]")?.style?.color, THEME.bad);
		assert.equal(line.find((span) => span.text === "[↓]")?.style?.color, THEME.accent);
	});

	it("查看器打开时快捷键条只留滚动与关闭", () => {
		const hints = footerHints({
			dialog: false,
			viewer: true,
			pane: "scrollback",
			menu: undefined,
			running: false,
			following: true,
			editorEmpty: true,
			hasStash: false,
		});
		assert.deepEqual(hints.map((hint) => hint.keys), ["j/k", "PgUp/PgDn", "Esc"]);
	});

	it("翻上去时多出回到底部的按钮，中止后动作名改成 Cancelling 且收起停止按钮", () => {
		const scrolled = runningRow({
			activity: "Thinking",
			startedAt: 0,
			phaseStartedAt: 0,
			tokens: 1_000,
			width: 60,
			now: 5_000,
			following: false,
		});
		const text = lineText(scrolled.line);
		assert.ok(text.endsWith("5.0s ⇣1.0k  [↓] [stop]"), text);
		assert.ok(scrolled.follow && scrolled.stop, "both buttons have hit ranges");
		assert.equal(lineText(scrolled.line).slice(scrolled.stop!.from, scrolled.stop!.to), "[stop]");
		assert.equal(lineText(scrolled.line).slice(scrolled.follow!.from, scrolled.follow!.to), "[↓]");

		const cancelling = runningRow({
			activity: "Thinking",
			startedAt: 0,
			phaseStartedAt: 0,
			tokens: 1_000,
			width: 60,
			now: 5_000,
			cancelling: true,
		});
		assert.ok(lineText(cancelling.line).includes("Cancelling…"));
		assert.equal(cancelling.stop, undefined);
	});
});
