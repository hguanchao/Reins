import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	APPROVAL_PANEL_HEIGHT,
	renderApprovalPanel,
} from "../../../src/tui/panel/approval-panel.ts";
import { ACCENT_COLOR } from "../../../src/tui/panel/menu-panel.ts";
import { THEME } from "../../../src/tui/theme.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("审批面板", () => {
	it("显示标题、工具与参数、动作行，不显示风险文字", () => {
		const lines = renderApprovalPanel(60, {
			tool: "bash",
			risk: "destructive",
			detail: '{\n  "command": "npm test"\n}',
		});
		const rows = lines.map(plain);

		assert.equal(lines.length, APPROVAL_PANEL_HEIGHT);
		assert.ok(rows[0]?.includes("Permission required"));
		assert.ok(rows[1]?.includes('Bash  { "command": "npm test" }'));
		assert.equal(rows[2], " ".repeat(60));
		assert.ok(rows[3]?.includes("←/→ select"));
		assert.ok(rows[3]?.includes("Enter confirm"));
		assert.ok(rows[3]?.includes("Esc deny"));
		assert.ok(rows[4]?.includes("› [y] allow once"));
		assert.ok(rows[4]?.includes("[n] deny"));
		assert.equal(rows[4]?.includes("› [n] deny"), false);
		assert.equal(rows[4]?.includes("[a]"), false);
		assert.equal(rows.join("\n").includes("destructive"), false);
		assert.equal(rows[5], "─".repeat(60));
	});

	it("工具名使用与对话流一致的展示名", () => {
		const render = (tool: string): readonly string[] =>
			renderApprovalPanel(40, { tool, risk: "destructive", detail: "server" }).map(plain);

		assert.ok(render("bash")[1]?.includes("Bash  server"));
		// ls 的展示名是 List
		assert.ok(render("ls")[1]?.includes("List  server"));
		// 带命名空间的插件/MCP 名称保持原样
		assert.ok(render("mcp__fs__list")[1]?.includes("mcp__fs__list  server"));
	});

	it("可记住范围时把短标签放进动作行", () => {
		const rows = renderApprovalPanel(80, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		}).map(plain);

		assert.ok(rows[0]?.includes("Permission required"));
		assert.ok(rows[1]?.includes("Bash  git status"));
		assert.ok(rows[4]?.includes('[a] always for "git status"'));
		assert.ok(rows[4]?.includes("[n] deny"));
		assert.equal(rows[4]?.includes("› [a]"), false);
		assert.equal(rows[4]?.includes("› [n]"), false);
	});

	it("长命令在第二行续写，仍放不下时末尾省略", () => {
		const detail = "x".repeat(120);
		const rows = renderApprovalPanel(40, {
			tool: "bash",
			risk: "destructive",
			detail,
		}).map(plain);

		assert.ok(rows[1]?.startsWith("  Bash  "));
		assert.equal(rows[1]?.length, 40);
		assert.ok(rows[2]?.startsWith("        "));
		assert.ok(rows[2]?.includes("x"));
		assert.ok(rows[2]?.trimEnd().endsWith("…"));
		assert.equal(rows.join("\n").includes("destructive"), false);
	});

	it("默认选中 allow once", () => {
		const row = renderApprovalPanel(80, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		})[4];

		assert.ok(row?.includes(`${ACCENT_COLOR}› [y] allow once`));
		assert.equal(row?.includes(`${THEME.error}[n]`), false);
	});

	it("选中的动作高亮", () => {
		const prompt = {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		};

		const always = renderApprovalPanel(80, prompt, "always")[4];
		assert.ok(always?.includes(`${ACCENT_COLOR}› [a] always for "git status"`));
		assert.ok(always?.includes("\x1b[1m"));
		assert.equal(always?.includes(`${ACCENT_COLOR}[y]`), false);
		assert.equal(always?.includes("› [y]"), false);

		// 默认选中的拒绝用危险色，而不是主题强调色
		const deny = renderApprovalPanel(80, prompt, "deny")[4];
		assert.ok(deny?.includes(`${THEME.error}› [n] deny`));
		assert.equal(deny?.includes(`${ACCENT_COLOR}[n]`), false);
		assert.equal(deny?.includes("› [y]"), false);
	});

	it("文件类范围不重复路径，显示 always for this file", () => {
		const rows = renderApprovalPanel(80, {
			tool: "edit",
			risk: "destructive",
			detail: "src/a.ts",
			saveLabel: "src/a.ts",
			saveShort: "src/a.ts",
		}).map(plain);

		assert.ok(rows[1]?.includes("Edit  src/a.ts"));
		assert.ok(rows[4]?.includes("[a] always for this file"));
		assert.ok(rows[4]?.includes("[y] allow once"));
	});

	it("窄终端下退化为短动作行，拒绝键仍然可见", () => {
		const rows = renderApprovalPanel(40, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "a very long prefix"',
			saveShort: "a very long prefix",
		}).map(plain);

		assert.ok(rows[1]?.includes("Bash  git status"));
		assert.ok(rows[4]?.includes("› [y] once"));
		assert.ok(rows[4]?.includes("[a] always"));
		assert.ok(rows[4]?.includes("[n] deny"));
		assert.equal(rows[4]?.includes("› [a]"), false);
		assert.equal(rows[4]?.includes("› [n]"), false);
	});
});
