import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	commandDetail,
	dialogDetail,
	panelRows,
} from "../../../src/plugins/tui-plugin/dialog-view.ts";
import { lineText } from "../../../src/tui/text/line.ts";

describe("权限弹窗", () => {
	it("标题、命令与纵向选项都在同一块里", () => {
		const rows = panelRows(
			40,
			{ question: "Allow Read to run?", detail: '{"path":"src/a.ts"}', resolve: () => undefined },
			0,
			"E:/w",
		).map(lineText);
		assert.ok(rows.some((line) => line.includes("Allow Read to run?")));
		assert.ok(rows.some((line) => line.includes("src/a.ts")));
		assert.ok(rows.some((line) => line.includes("1 (●) Allow")));
		assert.ok(rows.some((line) => line.includes("2 (○) Deny")));
	});

	it("JSON 详情转成工具摘要，非 JSON 原样显示", () => {
		assert.equal(dialogDetail('{"path":"src/a.ts"}', "Allow Read to run?", "E:/w"), "src/a.ts");
		assert.equal(dialogDetail("not json", "Question", undefined), "not json");
	});

	it("bash 命令的分隔符单独提亮", () => {
		const line = commandDetail("echo a && echo b", "Allow bash to run?");
		const separators = line.filter((span) => span.text.includes("&&"));
		assert.equal(separators.length, 1);
		assert.ok(separators[0].style?.color !== undefined);
	});
});
