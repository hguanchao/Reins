import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayWidth } from "../../../src/tui/render/text.ts";
import {
	renderSessionMenu,
	sessionMenuHeight,
	type SessionMenuItem,
} from "../../../src/tui/panel/session-menu.ts";

const ITEMS: readonly SessionMenuItem[] = [
	{ id: "0123456789abcdef", title: "Fix the login flow", time: "2 hours ago", current: true },
	{ id: "fedcba9876543210", title: "Write the release notes", time: "3 days ago", current: false },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("会话选择面板", () => {
	it("高度由可见行数、边框与提示组成", () => {
		assert.equal(sessionMenuHeight(0), 3);
		assert.equal(sessionMenuHeight(2), 5);
		assert.equal(sessionMenuHeight(3, true), 6);
	});

	it("分叉会话标出来源，底部提示 f 键", () => {
		const items: readonly SessionMenuItem[] = [
			...ITEMS,
			{
				id: "aaaabbbbccccdddd",
				title: "Fix the login flow",
				time: "just now",
				current: false,
				forkedFrom: "Fix the login flow",
			},
		];
		const rows = renderSessionMenu(100, { items, cursor: 0, scrollTop: 0 }, true).map(plain);

		assert.ok(rows[3]?.includes("↳ Fork of Fix the login flow"));
		assert.ok(rows.at(-1)?.includes("f fork"));

		const withoutFork = renderSessionMenu(100, { items, cursor: 0, scrollTop: 0 }).map(plain);
		assert.equal(withoutFork.some((line) => line.includes("f fork")), false);
	});

	it("列顺序是会话标识、标题、时间，最后是 current", () => {
		const rows = renderSessionMenu(100, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);

		assert.ok(rows[0]?.endsWith(" 2 ────"));
		const first = rows[1] ?? "";
		const idAt = first.indexOf("0123456789abcdef");
		const titleAt = first.indexOf("Fix the login flow");
		const timeAt = first.indexOf("2 hours ago");
		const currentAt = first.indexOf("current");

		assert.ok(idAt > 0, "标识在第一列");
		assert.ok(titleAt > idAt, "标题在标识之后");
		assert.ok(timeAt > titleAt, "时间在标题之后");
		assert.ok(currentAt > timeAt, "current 在最后");
	});

	it("各列起点在每一行上都对齐", () => {
		const rows = renderSessionMenu(100, {
			items: [
				{ id: "0123456789abcdef", title: "短", time: "just now", current: true },
				{ id: "fedcba9876543210", title: "A much longer title here", time: "3 days ago", current: false },
			],
			cursor: 0,
			scrollTop: 0,
		}).map(plain);

		// 用显示宽度量，不能用字符串下标：宽字符占两列却只算一个字符
		const columnOf = (row: string, marker: string): number =>
			displayWidth(row.slice(0, row.indexOf(marker)));
		const starts = rows.slice(1, 3).map((row) => ({
			id: columnOf(row, row.includes("0123456789abcdef") ? "0123456789abcdef" : "fedcba9876543210"),
			title: columnOf(row, row.includes("短") ? "短" : "A much longer"),
			time: columnOf(row, row.includes("just now") ? "just now" : "3 days ago"),
		}));
		assert.deepEqual(starts[0], starts[1]);
	});

	it("列间留出四列间距", () => {
		const row = plain(renderSessionMenu(100, { items: ITEMS, cursor: 0, scrollTop: 0 })[1] ?? "");

		assert.ok(row.includes("0123456789abcdef    Fix the login flow"), "标识与标题间隔四列");
		assert.ok(row.includes("2 hours ago    current"), "时间与 current 间隔四列");
	});

	it("没有标题的会话仍然排在时间列之前", () => {
		const items: readonly SessionMenuItem[] = [
			{ id: "8dfc462420d1a8d6", title: "(no conversation yet)", time: "1 day ago", current: false },
		];
		const row = plain(renderSessionMenu(100, { items, cursor: 0, scrollTop: 0 })[1] ?? "");

		assert.ok(row.indexOf("(no conversation yet)") < row.indexOf("1 day ago"));
	});

	it("窄终端隐藏 current 列，标识与标题仍然可见", () => {
		const rows = renderSessionMenu(46, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);

		assert.equal(rows[1]?.includes("current"), false);
		assert.ok(rows[1]?.includes("0123456789abcdef"));
		assert.ok(rows[1]?.includes("Fix the"));
		for (const line of rows) assert.ok(displayWidth(line) <= 46, `"${line}" 超出 46 列`);
	});

	it("更窄时先舍标题，保住标识与时间", () => {
		const rows = renderSessionMenu(40, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);
		const row = rows[1] ?? "";

		assert.ok(row.includes("0123456789abcdef"));
		assert.ok(row.includes("2 hours ago"));
		assert.equal(row.includes("Fix the"), false);
	});

	it("超长标题截断，行宽不超过终端", () => {
		const long: readonly SessionMenuItem[] = [
			{ id: "0123456789abcdef", title: "x".repeat(200), time: "just now", current: false },
		];
		const rows = renderSessionMenu(80, { items: long, cursor: 0, scrollTop: 0 }).map(plain);

		assert.ok(rows[1]?.includes("…"));
		assert.ok(displayWidth(rows[1] ?? "") <= 80);
	});

	it("每行底色铺满整行，不随内容长度变化", () => {
		// 颜色转义序列也算字符：按带色字符串量宽度会少补白，行底色只铺到文字末尾
		const rows = renderSessionMenu(100, {
			items: [
				{ id: "0123456789abcdef", title: "短", time: "just now", current: true },
				{ id: "fedcba9876543210", title: "A much longer title here", time: "3 days ago", current: false },
			],
			cursor: 0,
			scrollTop: 0,
		}).map(plain);

		for (const row of rows) {
			assert.equal(displayWidth(row), 100, `"${row}" 应铺满 100 列`);
		}
	});

	it("极窄终端也不把行撑出边界", () => {
		for (const width of [20, 12]) {
			const rows = renderSessionMenu(width, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);
			for (const line of rows) {
				assert.ok(displayWidth(line) <= width, `宽度 ${width}: "${line}"`);
			}
		}
	});

	it("从极窄到很宽，任何宽度都不把行撑出终端", () => {
		// 逐列扫描：列宽是按内容与终端宽度算出来的，边界只会在某个具体宽度上出问题
		for (let width = 4; width <= 160; width += 1) {
			const rows = renderSessionMenu(width, { items: ITEMS, cursor: 0, scrollTop: 0 }).map(plain);
			for (const line of rows) {
				assert.ok(displayWidth(line) <= width, `宽度 ${width}: "${line}"`);
			}
		}
	});
});
