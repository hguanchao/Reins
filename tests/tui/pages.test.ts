import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eastAsianWidth } from "get-east-asian-width";

import type { CommandMenuItem } from "../../src/tui/command-menu.ts";
import { helpPageLines, mcpsPageLines, renderPage, skillsPageLines } from "../../src/tui/pages.ts";

const COMMANDS: readonly CommandMenuItem[] = [
	{ name: "model", description: "Choose the model for this session", enabled: true },
	{ name: "help", description: "Show the commands and keys", enabled: true },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function width(text: string): number {
	let total = 0;
	for (const char of text) total += eastAsianWidth(char.codePointAt(0) ?? 0);
	return total;
}

describe("整屏页", () => {
	it("帮助页按标题、命令与按键分区呈现", () => {
		const rows = helpPageLines(80, COMMANDS).map(plain);
		const text = rows.join("\n");

		assert.equal(rows[0], "Reins — help");
		assert.ok(text.includes("Commands"));
		assert.ok(text.includes("Keys"));
		assert.ok(text.includes("/model"));
		assert.ok(text.includes("Choose the model for this session"));
		assert.ok(text.includes("Enter"));
		assert.ok(text.includes("Send the prompt"));
		assert.ok(text.includes("Ctrl+C twice"));
	});

	it("命令清单由调用方传入，未启用的命令同样列出", () => {
		const disabled: readonly CommandMenuItem[] = [
			{ name: "search", description: "Search the workspace", enabled: false },
		];
		const text = helpPageLines(80, disabled).map(plain).join("\n");

		assert.ok(text.includes("/search"));
		assert.ok(text.includes("Search the workspace"));
		assert.equal(text.includes("/model"), false);
	});

	it("说明按剩余宽度换行，续行与首行说明对齐，单词不被切开", () => {
		const description = "Choose the model for this session";
		const long: readonly CommandMenuItem[] = [{ name: "model", description, enabled: true }];
		const rows = helpPageLines(28, long).map(plain);
		const first = rows.findIndex((line) => line.includes("Choose"));

		assert.ok(first > 0);
		// 首行放不下时会另起一行，续行缩进与首行说明起始列一致
		const column = rows[first]?.indexOf("Choose") ?? -1;
		const parts = [rows[first]?.slice(column) ?? ""];
		for (let index = first + 1; index < rows.length; index += 1) {
			const line = rows[index] ?? "";
			if (line.length === 0) break;
			assert.equal(line.search(/\S/), column === 0 ? -1 : column);
			parts.push(line.slice(column));
		}

		// 折行后拼回来与原说明一致，说明每个单词都完整落在某一行里
		assert.equal(parts.join(" "), description);
	});

	it("每一行都不超过给定宽度", () => {
		const skills = [
			{
				name: "writer",
				description: "把改动整理成文档",
				note: "/home/me/.reins/skills/writer/SKILL.md",
				scope: "user" as const,
			},
		];
		const servers = [{ name: "context7", description: "connected  2 tools: a, b" }];
		for (const terminalWidth of [12, 20, 40, 80]) {
			const lines = [
				...helpPageLines(terminalWidth, COMMANDS),
				...skillsPageLines(terminalWidth, skills, ["/home/me/.reins/skills"]),
				...mcpsPageLines(terminalWidth, servers),
			];
			for (const line of lines.map(plain)) {
				assert.ok(width(line) <= terminalWidth, `"${line}" 超出 ${terminalWidth} 列`);
			}
		}
	});

	it("技能页按来源分节，并带上 SKILL.md 的路径", () => {
		const text = skillsPageLines(
			80,
			[
				{
					name: "writer",
					description: "把改动整理成文档",
					note: "/home/me/.reins/skills/writer/SKILL.md",
					scope: "user",
				},
				{
					name: "reviewer",
					description: "按清单审查改动",
					note: "/repo/.agents/skills/reviewer/SKILL.md",
					scope: "project",
				},
			],
			["/home/me/.reins/skills", "/repo/.agents/skills"],
		)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("Reins — skills"));
		assert.ok(text.includes("User skills"));
		assert.ok(text.includes("Project skills"));
		assert.ok(text.includes("writer"));
		assert.ok(text.includes("把改动整理成文档"));
		assert.ok(text.includes("/home/me/.reins/skills/writer/SKILL.md"));
		assert.ok(text.includes("reviewer"));
		assert.ok(text.includes("next turn"));
	});

	it("技能名不截断：名字再长也完整显示", () => {
		const text = skillsPageLines(
			80,
			[{ name: "karparthy-guidelines", description: "Behavioral guidelines", scope: "user" }],
			[],
		)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("karparthy-guidelines"));
		assert.equal(text.includes("…"), false);
	});

	it("技能条目之间留空行，说明与路径缩进比名称深", () => {
		const rows = skillsPageLines(
			80,
			[
				{ name: "alpha", description: "第一条", note: "/skills/alpha/SKILL.md", scope: "user" },
				{ name: "beta", description: "第二条", note: "/skills/beta/SKILL.md", scope: "user" },
			],
			[],
		).map(plain);

		const alpha = rows.indexOf("  alpha");
		const beta = rows.indexOf("  beta");
		assert.ok(alpha > 0 && beta > alpha);
		// 名称、说明、路径三级缩进依次加深
		assert.equal(rows[alpha + 1], "    第一条");
		assert.equal(rows[alpha + 2], "    /skills/alpha/SKILL.md");
		// 两条之间正好一个空行
		assert.equal(rows[beta - 1], "");
		assert.notEqual(rows[beta - 2], "");
	});

	it("技能页没有技能时给出空状态，而不是只剩一个标题", () => {
		const text = skillsPageLines(80, [], ["/home/me/.reins/skills"]).map(plain).join("\n");

		assert.ok(text.includes("No skills yet."));
		assert.ok(text.includes("/home/me/.reins/skills"));
	});

	it("MCP 页列出 server 与状态，没有配置时给出空状态", () => {
		const listed = mcpsPageLines(80, [{ name: "context7", description: "connected  2 tools: a, b" }])
			.map(plain)
			.join("\n");
		assert.ok(listed.includes("Reins — MCP servers"));
		assert.ok(listed.includes("context7"));
		assert.ok(listed.includes("2 tools"));

		const empty = mcpsPageLines(80, []).map(plain).join("\n");
		assert.ok(empty.includes("No MCP servers configured."));
		assert.ok(empty.includes("mcp_servers"));
	});

	it("MCP 页的超长 server 名不被截断，说明另起一行", () => {
		const rows = mcpsPageLines(40, [
			{ name: "my-company-internal-tools", description: "connected  2 tools: a, b" },
		]).map(plain);

		assert.ok(rows.some((line) => line.includes("my-company-internal-tools")));
		assert.equal(rows.some((line) => line.includes("…")), false);
	});

	it("视口取窗口，行数固定为 height", () => {
		const lines = helpPageLines(80, COMMANDS);
		const visible = renderPage(lines, 5, 0);

		assert.equal(visible.length, 5);
		assert.equal(plain(visible[0] ?? ""), "Reins — help");
	});

	it("滚动超出范围时收敛到两端，内容不足时停在顶部", () => {
		const lines = helpPageLines(80, COMMANDS);
		const bottom = renderPage(lines, 5, 9999);
		const top = renderPage(lines, 9999, 5);

		assert.equal(plain(bottom.at(-1) ?? ""), plain(lines.at(-1) ?? ""));
		assert.equal(plain(top[0] ?? ""), "Reins — help");
		assert.equal(top.length, 9999);
		assert.equal(renderPage(lines, 5, -3)[0], lines[0]);
	});

	it("高度为零时不返回任何行", () => {
		assert.deepEqual(renderPage(helpPageLines(80, COMMANDS), 0, 0), []);
	});
});
