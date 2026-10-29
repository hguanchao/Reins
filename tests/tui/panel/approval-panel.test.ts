import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	APPROVAL_PANEL_BASE_HEIGHT,
	approvalPanelHeight,
	approvalPreviewScrollLimit,
	renderApprovalPanel,
} from "../../../src/tui/panel/approval-panel.ts";
import { ACCENT_COLOR } from "../../../src/tui/panel/menu-panel.ts";
import type { ApprovalAnswer, ApprovalRequest } from "../../../src/permission/policy.ts";
import { THEME } from "../../../src/tui/render/theme.ts";
import { displayWidth } from "../../../src/tui/render/text.ts";

const ROWS = 24;

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function render(
	width: number,
	prompt: ApprovalRequest,
	selected: ApprovalAnswer = "once",
	expanded = false,
	scrollTop = 0,
	rows = ROWS,
): readonly string[] {
	return renderApprovalPanel(width, rows, prompt, selected, expanded, scrollTop);
}

describe("审批面板", () => {
	it("标题用警告色、不显示风险词，工具与动作行保留", () => {
		const lines = render(60, {
			tool: "bash",
			risk: "destructive",
			detail: '{\n  "command": "npm test"\n}',
		});
		const rows = lines.map(plain);

		assert.equal(lines.length, APPROVAL_PANEL_BASE_HEIGHT);
		assert.ok(rows[0]?.includes("Permission required"));
		assert.equal(rows[0]?.includes("destructive"), false);
		assert.ok((lines[0] ?? "").includes(THEME.warning));
		assert.ok(rows[1]?.includes('Bash  { "command": "npm test" }'));
		assert.equal(rows[2], " ".repeat(60));
		assert.ok(rows[3]?.includes("› [y] allow once"));
		assert.ok(rows[3]?.includes("[n] deny"));
		assert.equal(rows[3]?.includes("› [n] deny"), false);
		assert.equal(rows[3]?.includes("[a]"), false);
		assert.equal(rows[4], "─".repeat(60));
	});

	it("没有风险时不画风险词", () => {
		const rows = render(60, { tool: "read", risk: "", detail: "a.ts" }).map(plain);
		assert.ok(rows[0]?.includes("Permission required"));
		assert.equal(rows[0]?.includes("destructive"), false);
		assert.equal(rows[0]?.includes("external"), false);
	});

	it("工具名使用与对话流一致的展示名", () => {
		const withTool = (tool: string): readonly string[] =>
			render(40, { tool, risk: "destructive", detail: "server" }).map(plain);

		assert.ok(withTool("bash")[1]?.includes("Bash  server"));
		// ls 的展示名是 List
		assert.ok(withTool("ls")[1]?.includes("List  server"));
		// 带命名空间的插件/MCP 名称保持原样
		assert.ok(withTool("mcp__fs__list")[1]?.includes("mcp__fs__list  server"));
	});

	it("可记住范围时把短标签放进动作行", () => {
		const rows = render(80, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		}).map(plain);

		assert.ok(rows[0]?.includes("Permission required"));
		assert.ok(rows[1]?.includes("Bash  git status"));
		assert.ok(rows[3]?.includes('[a] always for "git status"'));
		assert.ok(rows[3]?.includes("[n] deny"));
		assert.equal(rows[3]?.includes("› [a]"), false);
		assert.equal(rows[3]?.includes("› [n]"), false);
	});

	it("长摘要仍在第二行续写，仍放不下时末尾省略", () => {
		const detail = "x".repeat(120);
		const rows = render(40, {
			tool: "bash",
			risk: "destructive",
			detail,
		}).map(plain);

		assert.ok(rows[1]?.startsWith("  Bash  "));
		assert.equal(rows[1]?.length, 40);
		assert.ok(rows[2]?.startsWith("        "));
		assert.ok(rows[2]?.includes("x"));
		assert.ok(rows[2]?.trimEnd().endsWith("…"));
	});

	it("摘要优先于完整 detail 显示在卡片上", () => {
		const rows = render(80, {
			tool: "bash",
			risk: "destructive",
			detail: "python -c 'a very long inline script that should stay in details'",
			summary: "python -c [inline script]",
			preview: "python -c 'a very long inline script that should stay in details'",
			previewLabel: "Command",
		}).map(plain);

		const card = rows.slice(0, APPROVAL_PANEL_BASE_HEIGHT).join("\n");
		assert.ok(card.includes("python -c [inline script]"));
		assert.equal(card.includes("a very long inline script"), false);
	});

	it("展开后显示详情，滚动位置落在可见窗口", () => {
		const preview = Array.from({ length: 40 }, (_, index) => `row-${String(index + 1).padStart(2, "0")}`).join("\n");
		const prompt: ApprovalRequest = {
			tool: "bash",
			risk: "destructive",
			detail: "npm test",
			summary: "npm test",
			preview,
			previewLabel: "Command",
		};

		const collapsed = render(60, prompt);
		assert.equal(collapsed.length, APPROVAL_PANEL_BASE_HEIGHT);
		assert.equal(collapsed.map(plain).join("\n").includes("row-01"), false);

		const expanded = render(60, prompt, "once", true, 0);
		assert.equal(expanded.length, approvalPanelHeight(prompt, true, 60, ROWS));
		const text = expanded.map(plain).join("\n");
		assert.ok(text.includes("Command"));
		assert.ok(text.includes("row-01"));

		const scrolled = render(60, prompt, "once", true, 5).map(plain).join("\n");
		assert.equal(scrolled.includes("row-01"), false);
		assert.ok(scrolled.includes("row-06"));
		assert.ok(scrolled.includes("[y] allow once"));
	});

	it("展开高度封顶并给对话流留出空间", () => {
		const preview = Array.from({ length: 30 }, (_, index) => `row-${index + 1}`).join("\n");
		const prompt: ApprovalRequest = {
			tool: "bash",
			risk: "destructive",
			detail: "npm test",
			preview,
			previewLabel: "Command",
		};

		// 12 行终端：最多占 9 行，余下 3 行给对话流
		assert.equal(render(60, prompt, "once", true, 0, 12).length, 9);
		assert.ok(approvalPreviewScrollLimit(prompt, true, 60, 12) > 0);
	});

	it("默认选中 allow once", () => {
		const row = render(80, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		})[3];

		assert.ok(row?.includes(`${ACCENT_COLOR}› [y] allow once`));
		assert.equal(row?.includes(`${THEME.error}[n]`), false);
	});

	it("选中的动作高亮", () => {
		const prompt: ApprovalRequest = {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "git status"',
			saveShort: "git status",
		};

		const always = render(80, prompt, "always")[3];
		assert.ok(always?.includes(`${ACCENT_COLOR}› [a] always for "git status"`));
		assert.ok(always?.includes("\x1b[1m"));
		assert.equal(always?.includes(`${ACCENT_COLOR}[y]`), false);
		assert.equal(always?.includes("› [y]"), false);

		// 默认选中的拒绝用危险色，而不是主题强调色
		const deny = render(80, prompt, "deny")[3];
		assert.ok(deny?.includes(`${THEME.error}› [n] deny`));
		assert.equal(deny?.includes(`${ACCENT_COLOR}[n]`), false);
		assert.equal(deny?.includes("› [y]"), false);
	});

	it("文件类范围不重复路径，显示 always for this file", () => {
		const rows = render(80, {
			tool: "edit",
			risk: "destructive",
			detail: "src/a.ts",
			saveLabel: "src/a.ts",
			saveShort: "src/a.ts",
		}).map(plain);

		assert.ok(rows[1]?.includes("Edit  src/a.ts"));
		assert.ok(rows[3]?.includes("[a] always for this file"));
		assert.ok(rows[3]?.includes("[y] allow once"));
	});

	it("窄终端下退化为短动作行，拒绝键仍然可见", () => {
		const rows = render(40, {
			tool: "bash",
			risk: "destructive",
			detail: "git status",
			saveLabel: 'commands starting with "a very long prefix"',
			saveShort: "a very long prefix",
		}).map(plain);

		assert.ok(rows[1]?.includes("Bash  git status"));
		assert.ok(rows[3]?.includes("› [y] once"));
		assert.ok(rows[3]?.includes("[a] always"));
		assert.ok(rows[3]?.includes("[n] deny"));
		assert.equal(rows[3]?.includes("› [a]"), false);
		assert.equal(rows[3]?.includes("› [n]"), false);
	});
});

describe("审批面板的内容净化", () => {
	it("参数里的转义序列不会进入终端", () => {
		// 模型给出的命令可以带 ESC 序列：不清掉就能在用户按下确认前清屏、移动光标，
		// 让面板显示的与实际执行的不是同一条命令
		const lines = render(60, {
			tool: "bash",
			risk: "destructive",
			detail: "echo safe\u001b[2K\u001b[1Grm -rf /",
		});
		const joined = lines.join("");
		assert.equal(joined.includes("\u001b[2K"), false);
		assert.equal(joined.includes("\u001b[1G"), false);
	});

	it("OSC 序列同样被清掉", () => {
		const lines = render(60, {
			tool: "bash",
			risk: "destructive",
			detail: "a\u001b]52;c;ZXZpbA==\u0007b",
		});
		assert.equal(lines.join("").includes("\u001b]52"), false);
	});

	it("展开详情里的转义序列不会进入终端", () => {
		const lines = render(
			60,
			{
				tool: "bash",
				risk: "destructive",
				detail: "safe",
				preview: "safe\u001b[2K\u001b[1Gbad",
				previewLabel: "Command",
			},
			"once",
			true,
		);
		const joined = lines.join("");
		assert.equal(joined.includes("\u001b[2K"), false);
		assert.equal(joined.includes("\u001b[1G"), false);
	});

	it("可记住范围里的转义序列不会进入动作行", () => {
		const lines = render(80, {
			tool: "bash",
			risk: "destructive",
			detail: "npm test",
			saveShort: "npm\u001b[2Jtest",
		});
		const joined = lines.join("");
		const rows = lines.map(plain);

		assert.equal(joined.includes("\u001b[2J"), false);
		assert.ok(rows.some((row) => row.includes('always for "npmtest"')));
	});

	it("超长工具名不会让整行溢出面板宽度", () => {
		const width = 40;
		const lines = render(width, {
			tool: "mcp_server__a_very_long_tool_name_that_goes_on_and_on",
			risk: "destructive",
			detail: "x",
		});
		for (const line of lines) {
			assert.ok(displayWidth(plain(line)) <= width, `line wider than ${width}: ${plain(line)}`);
		}
	});
});
