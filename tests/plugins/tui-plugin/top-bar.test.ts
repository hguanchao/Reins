import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shortenPath, topBarRow } from "../../../src/plugins/tui-plugin/top-bar.ts";
import { lineText } from "../../../src/tui/text/line.ts";

const STATE = {
	width: 80,
	branch: "main",
	cwd: "E:\\Projects\\Reins",
	sandbox: "off",
	used: 12_345,
	total: 128_000,
	hover: false,
} as const;

describe("顶部状态行", () => {
	it("左边是分支与目录，右边是上下文占用", () => {
		const { line, context } = topBarRow(STATE);
		const text = lineText(line);
		assert.ok(text.startsWith("  ⎇ main  E:/Projects/Reins"), text);
		assert.ok(text.endsWith("12.3k / 128.0k"), text);
		assert.ok(context);
		assert.equal(text.slice(context!.from, context!.to), "12.3k / 128.0k");
	});

	it("悬停时换成进度条与百分比", () => {
		const { line } = topBarRow({ ...STATE, hover: true });
		const text = lineText(line);
		assert.ok(text.includes("█"), "filled cell");
		assert.ok(text.includes("░"), "track");
		assert.ok(text.endsWith("9.6%"), text);
	});

	it("有沙箱时放在占用条左边", () => {
		const { line } = topBarRow({ ...STATE, sandbox: "bubblewrap" });
		const text = lineText(line);
		assert.ok(text.includes("sandbox:bubblewrap"), text);
		assert.ok(text.endsWith("12.3k / 128.0k"), text);
	});

	it("没有上下文上限时不显示占用条", () => {
		const { line, context } = topBarRow({ ...STATE, total: undefined });
		assert.equal(context, undefined);
		assert.ok(!lineText(line).includes("12.3k"), lineText(line));
	});

	it("窄屏放不下右侧整组时直接丢弃，不截成半截", () => {
		const { line, context } = topBarRow({ ...STATE, width: 20 });
		assert.equal(context, undefined);
		assert.ok(!lineText(line).includes("12.3k"), lineText(line));
	});

	it("长路径保留最后几段", () => {
		const shortened = shortenPath("E:\\Projects\\Reins\\src\\plugins\\tui-plugin", 24);
		assert.ok(shortened.startsWith("…/"), shortened);
		assert.ok(shortened.endsWith("tui-plugin"), shortened);
		assert.ok(shortened.length <= 24, shortened);
	});
});
