import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { displayWidth } from "../../../src/tui/render/text.ts";
import { THEME } from "../../../src/tui/render/theme.ts";
import { attachToolResult, renderTranscript, toolHeaderAtRow } from "../../../src/tui/transcript.ts";
import type { TranscriptLine, TranscriptTool, TranscriptTurn } from "../../../src/tui/transcript.ts";


function plain(line: string): string {
	return line
		// 下划线样式带子参数，形如 \x1b[4:5m，所以要允许冒号
		.replace(/\x1b\[[0-9;:]*m/g, "")
		.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
}

describe("工具调用行", () => {
	it("Bash 命令折叠态与普通参数同色，展开后才换成琥珀色", () => {
		const collapsed: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			result: "ok",
		};
		const collapsedLine =
			renderTranscript(60, 10, [{ prompt: "hi", response: [collapsed] }], 0).find((line) =>
				plain(line).includes("› Bash"),
			) ?? "";
		// 折叠态与其它工具的参数一致：弱化色 + 一条实线下划线
		assert.ok(collapsedLine.includes(THEME.textSubtle));
		assert.equal(collapsedLine.includes(THEME.warning), false);
		assert.ok(collapsedLine.includes("\x1b[4m"));

		const expanded: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			fullDetail: "npm test -- --watch",
			detailKind: "text",
			detailExpanded: true,
		};
		const expandHead =
			renderTranscript(60, 12, [{ prompt: "hi", response: [expanded] }], 0).find((line) =>
				plain(line).includes("◆ Bash"),
			) ?? "";
		assert.ok(expandHead.includes(THEME.warning));
		assert.ok(expandHead.includes("\x1b[4m"));
	});

	it("没有链接的参数也画同一种实线下划线", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Grep", detail: "TODO", result: "a.ts:1" }],
		};
		const line = renderTranscript(40, 8, [turn], 0).find((item) => plain(item).includes("› Grep")) ?? "";

		// 可展开就该有「可以展开」的暗示，不能只有命令和文件路径有
		assert.ok(line.includes("\x1b[4m"));
		// 没有 linkTarget 时不该挂 OSC 8 链接
		assert.equal(line.includes("\x1b]8;;"), false);
		// 折叠态仍用弱化色，琥珀色留给展开后的命令
		assert.equal(line.includes(THEME.warning), false);
	});

	it("既不可点也不可展开的行不加下划线，也不带行首标记", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Grep", detail: "TODO", result: "" }],
		};
		const line = renderTranscript(40, 8, [turn], 0).find((item) => plain(item).includes("Grep")) ?? "";

		assert.equal(line.includes("\x1b[4m"), false);
		assert.equal(line.includes("\x1b[4:4m"), false);
		assert.equal(line.includes("\x1b]8;;"), false);
		// 没有可点的东西就不该挂一个暗示「能点」的箭头
		assert.equal(plain(line).includes("›"), false);
	});

	it("运行中的工具仍带行首标记，标记不会在完成时才冒出来", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Grep", detail: "TODO" }],
		};
		const line = renderTranscript(40, 8, [turn], 0).find((item) => plain(item).includes("Grep")) ?? "";

		assert.equal(plain(line).includes("› Grep"), true);
	});

	it("展开的结果与展开的命令用同一条色带", () => {
		const expanded: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "ls -la",
			result: "total 8\ndrwxr-xr-x 1 Chao .",
			resultExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [expanded] }], 0).filter((line) =>
			plain(line).includes("total 8"),
		);

		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.includes(THEME.detailBg));
	});

	it("展开态一律实线下划线并带上参数色", () => {
		const expanded: TranscriptTool = {
			kind: "tool",
			name: "Grep",
			detail: "TODO",
			fullDetail: "TODO in src",
			detailKind: "text",
			detailExpanded: true,
		};
		const head =
			renderTranscript(60, 10, [{ prompt: "hi", response: [expanded] }], 0).find((line) =>
				plain(line).includes("◆ Grep"),
			) ?? "";

		assert.ok(head.includes("\x1b[4m"));
		assert.ok(head.includes(THEME.path));
	});

	it("一行放得下时显示名称与参数，两者同色", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Read", detail: "README.md" }],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const line = lines.find((item) => plain(item).includes("› Read"));
		assert.ok(line);
		assert.ok(plain(line).startsWith("  › Read  README.md"));
		// 参数不再是正文的白色，而是与工具名同一档
		assert.ok(line.includes(THEME.textSubtle));
		assert.equal(line.includes(THEME.textPrimary), false);
	});

	it("参数放不下时保持一行，末尾省略", () => {
		const command =
			'cd /e/Projects/Reins2API && find . -not -path "*/node_modules/*" -type f | head -100';
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Bash", detail: command }],
		};
		const lines = renderTranscript(40, 10, [turn], 0).map(plain);

		const index = lines.findIndex((line) => line.includes("› Bash"));
		const line = lines[index] ?? "";
		assert.ok(line.startsWith("  › Bash  cd /e/Projects"));
		assert.ok(line.includes("…"));
		assert.equal(line.length, 40);
		// 折行会让下一条调用被推开，这里确认没有第二行
		assert.equal(lines[index + 1]?.includes("node_modules"), false);
	});

	it("失败行用 ×、错误色并带耗时", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [
				{ kind: "tool", name: "Bash", detail: "exit 1", isError: true, durationMs: 98 },
			],
		};
		const lines = renderTranscript(40, 8, [turn], 0);

		const failed = lines.find((line) => plain(line).includes("× Bash"));
		assert.ok(failed);
		assert.ok(plain(failed).startsWith("  × Bash  exit 1 (0.1s)"));
		assert.ok(failed.includes(THEME.error));
		assert.equal(failed.includes(THEME.textPrimary), false);
		assert.equal(failed.includes(THEME.textSubtle), false);
	});

	it("失败原因过长时续行，每一行都保持错误色", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Bash", detail: "x".repeat(100), isError: true, durationMs: 5 }],
		};
		const lines = renderTranscript(30, 10, [turn], 0);

		const failed = lines.filter((line) => plain(line).includes("x"));
		assert.ok(failed.length > 1);
		assert.ok(failed.every((line) => line.includes(THEME.error)));
	});

	it("展开成功工具时在调用行下方显示结果", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			group: undefined,
			result: "all tests passed\nsecond line",
			resultExpanded: true,
		};
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("all tests passed"));
		assert.ok(text.includes("second line"));
	});

	it("没有参数时只显示工具名", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Ls", detail: "" }],
		};
		const line = renderTranscript(40, 8, [turn], 0).find((item) => plain(item).includes("› Ls"));

		assert.ok(line);
		assert.equal(plain(line).trimEnd().endsWith("  › Ls"), true);
	});

	it("展开时保留目标并在名称下方显示完整命令", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			fullDetail: "cd /work && npm test | tail -5",
			detailExpanded: true,
		};
		const text = renderTranscript(60, 10, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("◆ Bash  npm test"));
		assert.ok(text.includes("cd /work && npm test | tail -5"));
	});

	it("没有完整命令时双击不给命中区", () => {
		const tool: TranscriptTool = { kind: "tool", name: "Bash", detail: "npm test" };
		const turn: TranscriptTurn = { prompt: "hi", response: [tool] };
		const row = renderTranscript(60, 10, [turn], 0).map(plain).findIndex((line) => line.includes("› Bash")) + 1;

		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, row), undefined);
	});

	it("有完整命令时标题行可命中，展开后的续行不可命中", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			fullDetail: "cd /work && npm test | tail -5",
		};
		const turn: TranscriptTurn = { prompt: "hi", response: [tool] };
		const row = renderTranscript(60, 10, [turn], 0).map(plain).findIndex((line) => line.includes("› Bash")) + 1;

		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, row), tool);

		tool.detailExpanded = true;
		const rows = renderTranscript(60, 10, [turn], 0).map(plain);
		const expandedRow = rows.findIndex((line) => line.includes("◆ Bash")) + 1;
		const bodyRow = rows.findIndex((line) => line.includes("cd /work")) + 1;

		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, expandedRow), tool);
		assert.equal(toolHeaderAtRow(60, 10, [turn], 0, bodyRow), undefined);
	});

	it("bash 后台结果在折叠行标出 job 编号", () => {
		const tool: TranscriptTool = { kind: "tool", name: "Bash", detail: "npm run dev", callId: "c1" };
		attachToolResult(tool, "bash", "Started background job j1", undefined, {
			jobId: "j1",
			background: true,
		});
		const line = renderTranscript(80, 12, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.find((candidate) => candidate.includes("Bash"));

		assert.equal(tool.metric, "background j1");
		assert.ok(line?.includes("(background j1)"));
	});

	it("结果指标显示在折叠行末尾，没有参数时跟在名称后面", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [
				{ kind: "tool", name: "Read", detail: "a.ts", metric: "100 lines" },
				{ kind: "tool", name: "List", detail: "", metric: "2 entries" },
			],
		};
		const text = renderTranscript(60, 10, [turn], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  › Read  a.ts (100 lines)"));
		assert.ok(text.includes("  › List (2 entries)"));
	});

	it("指标放不下时省略，不挤掉参数", () => {
		const turn: TranscriptTurn = {
			prompt: "hi",
			response: [{ kind: "tool", name: "Read", detail: "a.ts", metric: "100 lines" }],
		};
		const line = renderTranscript(24, 10, [turn], 0)
			.map(plain)
			.find((item) => item.includes("› Read"));

		assert.ok(line);
		assert.equal(line.includes("100 lines"), false);
		assert.ok(line.includes("a.ts"));
	});

	it("多行完整参数逐行展开", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "auth.ts",
			fullDetail: "path: src/auth.ts\nedit 1: old -> new",
			detailExpanded: true,
		};
		const text = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("  ◆ Edit  auth.ts"));
		assert.ok(text.includes("    path: src/auth.ts"));
		assert.ok(text.includes("    edit 1: old -> new"));
	});

	it("展开详情超过上限时只渲染前面一段并给出剩余行数", () => {
		const rows = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
		const tool: TranscriptTool = {
			kind: "tool",
			name: "List",
			detail: ".",
			fullDetail: rows.join("\n"),
			detailExpanded: true,
		};
		const text = renderTranscript(60, 300, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.join("\n");

		assert.ok(text.includes("line 60"));
		assert.equal(text.includes("line 61"), false);
		assert.ok(text.includes("… (140 more lines)"));
	});

	it("只读工具展开后显示结果内容，而不是参数清单", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			metric: "2 lines",
			fullDetail: "1  line 1\n2  line 2",
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("  ◆ Read  a.ts"));
		assert.equal(text.includes("(2 lines)"), false);
		// 2 列标题缩进 + 2 列带外留白 + 1 列带内缩进
		assert.ok(text.includes("     1  line 1"));
		assert.ok(text.includes("     2  line 2"));
		assert.equal(text.includes("path:"), false);
		assert.ok(lines.some((line) => line.includes(THEME.detailBg)));

		// 标题行不铺色带；色带外留四列，带内再留一列内边距
		const head = lines.find((line) => plain(line).includes("◆ Read"));
		const body = lines.find((line) => plain(line).includes("1  line 1"));
		assert.ok(plain(head ?? "").startsWith("  "));
		assert.equal(head?.includes(THEME.detailBg), false);
		assert.ok(body?.startsWith(`    ${THEME.detailBg}`));
	});

	it("文件详情按扩展名着色，键名、字符串与数字分开", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.json",
			fullDetail: '1  {\n2    "name": "reins",\n3    "count": 2\n4  }',
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const key = lines.find((line) => plain(line).includes('"name"'));
		const value = lines.find((line) => plain(line).includes('"reins"'));
		const count = lines.find((line) => plain(line).includes('"count"'));

		assert.ok(key?.includes(THEME.syntaxType));
		assert.ok(value?.includes(THEME.syntaxString));
		assert.ok(count?.includes(THEME.syntaxNumber));
	});

	it("详情里的制表符展开成空格，缩进处不留黑洞", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.json",
			fullDetail: '1  \t"name": "reins"',
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(40, 12, [{ prompt: "hi", response: [tool] }], 0);
		const body = lines.find((line) => plain(line).includes('"name"'));

		assert.ok(body);
		assert.equal(plain(body).includes("\t"), false);
		// 行号后原来的制表位按 4 列展开，缩进仍然落在内容列
		assert.ok(plain(body).includes('1   "name"'));
		assert.ok(body.includes(THEME.detailBg));
	});

	it("详情里的 ANSI 序列被剥掉，不留下颜色残渣", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "app.log",
			fullDetail: "1  \x1b[31mERROR\x1b[0m boom",
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(50, 12, [{ prompt: "hi", response: [tool] }], 0);
		const text = lines.map(plain).join("\n");

		assert.ok(text.includes("ERROR boom"));
		assert.equal(text.includes("[31m"), false);
		assert.equal(text.includes("[0m"), false);
	});

	it("详情里的回车被清掉，色带不会被打回终端底色", () => {
		// Windows 命令输出与错误正文常带 CRLF：CR 被终端当成回车执行，其后的补齐空格
		// 从行首重写，整条色带断开，这一行内容也会被覆盖成空白
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "cmd",
			fullDetail: "cmd /c foo\n\nError: line one\r\nError: line two\r",
			detailKind: "text",
			detailExpanded: true,
		};
		const lines = renderTranscript(50, 16, [{ prompt: "hi", response: [tool] }], 0);
		const body = lines.find((line) => plain(line).includes("Error: line one"));

		assert.ok(body);
		assert.equal(plain(body).includes("\r"), false);
		// 内容与行宽都要按去掉 CR 之后算，否则补齐少一列、色带右缘缺一格
		assert.equal(plain(body).includes("Error: line one  "), true);
		assert.equal(displayWidth(plain(body)), 50);
	});

	it("思考正文里的回车同样清掉，色带保持完整", () => {
		const block: TranscriptLine = {
			kind: "thinkingBlock",
			header: "Thought for 1.0s",
			body: ["先读文件\r"],
			partial: "",
			running: false,
			expanded: true,
		};
		const lines = renderTranscript(40, 16, [{ prompt: "hi", response: [block] }], 0);
		const body = lines.find((line) => plain(line).includes("先读文件"));

		assert.ok(body);
		assert.equal(plain(body).includes("\r"), false);
		assert.equal(displayWidth(plain(body)), 40);
	});

	it("展开标题与 Thought 同色，文件路径用实线下划线", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			linkTarget: "file:///work/a.ts",
			fullDetail: "1  line 1",
			detailKind: "file",
			detailExpanded: true,
		};
		const head =
			renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0).find((line) =>
				plain(line).includes("◆ Read"),
			) ?? "";

		assert.ok(head.includes(THEME.textPrimary));
		assert.equal(head.includes(THEME.accent), false);
		assert.ok(head.includes(THEME.path));
		assert.ok(head.includes("\x1b[4m"));
		assert.equal(head.includes("\x1b]8;;"), false);
	});

	it("展开详情上下各留一行色带", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			fullDetail: "1  line 1",
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(40, 12, [{ prompt: "hi", response: [tool] }], 0);
		const headRow = lines.findIndex((line) => plain(line).includes("◆ Read"));
		assert.ok(headRow >= 0);

		const top = lines[headRow + 1] ?? "";
		const content = lines[headRow + 2] ?? "";
		const bottom = lines[headRow + 3] ?? "";

		assert.ok(top.includes(THEME.detailBg));
		assert.equal(plain(top).trim(), "");
		assert.ok(content.includes(THEME.detailBg));
		assert.ok(plain(content).includes("1  line 1"));
		assert.ok(bottom.includes(THEME.detailBg));
		assert.equal(plain(bottom).trim(), "");
	});

	it("纯文本详情在带内留一列，不与色带左缘贴在一起", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "git log",
			fullDetail: "git log --oneline -20; echo done",
			detailKind: "text",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const body = lines.find((line) => plain(line).includes("git log --oneline"));
		assert.ok(body);

		// 2 列标题缩进 + 2 列带外留白 + 1 列带内留白
		assert.ok(plain(body).startsWith("     git log --oneline"));
		assert.equal(body.indexOf(THEME.detailBg), 4);
	});

	it("结果末尾的换行不再多占一行，下边距只有一行", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "List",
			detail: ".",
			fullDetail: "./\n└── a.md\n",
			detailKind: "text",
			detailExpanded: true,
		};
		const lines = renderTranscript(40, 12, [{ prompt: "hi", response: [tool] }], 0);
		const headRow = lines.findIndex((line) => plain(line).includes("◆ List"));
		assert.ok(headRow >= 0);

		// 上边距、两行内容、下边距
		assert.equal(plain(lines[headRow + 1] ?? "").trim(), "");
		assert.ok(plain(lines[headRow + 2] ?? "").includes("./"));
		assert.ok(plain(lines[headRow + 3] ?? "").includes("a.md"));
		assert.equal(plain(lines[headRow + 4] ?? "").trim(), "");
		assert.equal(plain(lines[headRow + 5] ?? "").trim(), "");
	});

	it("文件详情换行时悬挂缩进到内容列", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			fullDetail: `1  ${"x".repeat(100)}`,
			detailKind: "file",
			detailExpanded: true,
		};
		const lines = renderTranscript(40, 20, [{ prompt: "hi", response: [tool] }], 0)
			.map(plain)
			.filter((line) => line.includes("x"));

		assert.ok(lines.length > 1);
		// 2 列标题缩进 + 2 列带外留白 + 1 列带内缩进 + 行号与分隔（3 列）
		assert.ok(lines[1]?.startsWith("        "));
		assert.equal(lines[1]?.startsWith("   1"), false);
	});

	it("四种详情与思考块的色带都起于同一列，且每行宽度精确等于终端宽度", () => {
		const cases: readonly (readonly [string, TranscriptLine])[] = [
			[
				"Bash",
				{ kind: "tool", name: "Bash", detail: "x", fullDetail: "git log --oneline", detailKind: "text", detailExpanded: true },
			],
			[
				"Read",
				{ kind: "tool", name: "Read", detail: "a.ts", fullDetail: "12  const a = 1;", detailKind: "file", detailExpanded: true },
			],
			[
				"Edit",
				{ kind: "tool", name: "Edit", detail: "a.ts", fullDetail: "1 - old\n1 + new", detailKind: "diff", detailExpanded: true },
			],
			[
				"Thought",
				{
					kind: "thinkingBlock",
					header: "Thinking…",
					body: ["先读文件"],
					partial: "",
					running: true,
					expanded: true,
				},
			],
		];

		for (const [label, item] of cases) {
			for (const width of [40, 60, 88]) {
				const lines = renderTranscript(width, 12, [{ prompt: "hi", response: [item] }], 0);
				let bands = 0;
				for (const line of lines) {
					assert.equal(displayWidth(plain(line)), width, `${label}@${width} 行宽不精确`);

					const at = line.search(/\x1b\[48;[25];/);
					// 用户提示块也从第 1 列铺底色，只统计它之后的详情色带
					if (at <= 0) continue;
					// 详情色带外留四列（2 列标题缩进 + 2 列留白），右缘铺到面板边缘
					assert.equal(displayWidth(plain(line.slice(0, at))), 4, `${label}@${width} 色带起点不对`);
					bands += 1;
				}
				assert.ok(bands > 0, `${label}@${width} 没有色带`);
			}
		}
	});

	it("窄终端下正文至少留一列，不被行号与标记挤没", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "a.ts",
			fullDetail: "1 + const a = 1;",
			detailKind: "diff",
			detailExpanded: true,
		};

		for (const width of [10, 12, 16, 20]) {
			const lines = renderTranscript(width, 16, [{ prompt: "hi", response: [tool] }], 0);
			for (const line of lines) {
				assert.equal(displayWidth(plain(line)), width, `宽度 ${width} 下行宽不精确`);
			}
			// 正文必须有可见字符，不能被前缀整段吃掉
			const body = lines.map(plain).filter((line) => /const|a = 1|1;/.test(line));
			assert.ok(body.length > 0, `宽度 ${width} 下正文消失`);
		}
	});

	it("diff 详情按增删着色，省略行弱化", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "a.ts",
			fullDetail: "1 - old\n1 + new\n2   keep\n   … 7 unchanged lines",
			detailKind: "diff",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const removed = lines.find((line) => plain(line).includes("1 - old"));
		const added = lines.find((line) => plain(line).includes("1 + new"));
		const gap = lines.find((line) => plain(line).includes("unchanged lines"));

		// 增删改为整行底色，标记本身仍用成功/失败色
		assert.ok(removed?.includes(THEME.diffDeleteBg));
		assert.ok(removed?.includes(THEME.error));
		assert.ok(added?.includes(THEME.diffInsertBg));
		assert.ok(added?.includes(THEME.success));
		// hunk 之间的省略行是刻度而非内容，压到最弱一档
		assert.ok(gap?.includes(THEME.textSubtle));
	});

	it("diff 的代码按语法着色，行尾填充回到底色不拖彩色", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "retry.ts",
			fullDetail: '1 + const backoff = Math.min(250, 5_000);\n2   // 注释',
			detailKind: "diff",
			detailExpanded: true,
		};
		const lines = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0);
		const added = lines.find((line) => plain(line).includes("const backoff"));
		const commented = lines.find((line) => plain(line).includes("// 注释"));

		assert.ok(added?.includes(THEME.syntaxKeyword));
		assert.ok(added?.includes(THEME.syntaxNumber));
		assert.ok(commented?.includes(THEME.syntaxComment));
		// 上下文行没有增删色，仍用详情底色铺满
		assert.ok(commented?.includes(THEME.detailBg));
	});

	it("认不出语言时 diff 不着色，但增删底色仍在", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "notes",
			fullDetail: "1 + const a = 1;",
			detailKind: "diff",
			detailExpanded: true,
		};
		const line = renderTranscript(60, 12, [{ prompt: "hi", response: [tool] }], 0).find((item) =>
			plain(item).includes("const a = 1;"),
		);

		assert.ok(line?.includes(THEME.diffInsertBg));
		assert.equal(line?.includes(THEME.syntaxKeyword), false);
	});

	it("diff 每行宽度精确等于终端宽度，底色铺满整行", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Edit",
			detail: "a.ts",
			fullDetail: "1 - old = 1;\n1 + const n = 2;\n2   // 注释",
			detailKind: "diff",
			detailExpanded: true,
		};
		const lines = renderTranscript(50, 12, [{ prompt: "hi", response: [tool] }], 0);
		const body = lines.filter((line) => /^\s+\d+ /.test(plain(line)));

		assert.equal(body.length, 3);
		for (const line of body) {
			assert.equal(displayWidth(plain(line)), 50);
		}
	});

	it("折叠路径带 OSC 8 链接，宽度仍按纯文本计算", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			linkTarget: "file:///work/src/a.ts",
		};
		const line = renderTranscript(40, 8, [{ prompt: "hi", response: [tool] }], 0).find((item) =>
			item.includes("Read"),
		);

		assert.ok(line?.includes("\x1b]8;;file:///work/src/a.ts\x1b\\a.ts\x1b]8;;\x1b\\"));
		assert.ok(plain(line ?? "").startsWith("  › Read  a.ts"));
		assert.equal(plain(line ?? "").length, 40);
	});

	it("运行中的工具行按整秒显示耗时，结果回来后被真实耗时覆盖", () => {
		const tool: TranscriptTool = {
			kind: "tool",
			name: "Bash",
			detail: "npm test",
			group: "command",
			// 3.2 秒：离整秒边界足够远，断言不会被调度抖动翻过去
			startedAt: Date.now() - 3200,
		};
		const lineOf = (): string =>
			renderTranscript(50, 8, [{ prompt: "hi", response: [tool] }], 0)
				.map(plain)
				.find((item) => item.includes("Bash")) ?? "";

		// 截到整秒：数字每秒才变一次，否则每帧都会因为新字符串重排整份对话流
		assert.ok(lineOf().includes("(3.0s)"));

		// 结果回来时按真实耗时定格，实时值不再参与
		attachToolResult(tool, "bash", "ok", 1200);
		assert.ok(lineOf().includes("(1.2s)"));
		assert.equal(lineOf().includes("(3.0s)"), false);
	});

	it("历史回填的工具行没有起点，不显示运行耗时", () => {
		const historical: TranscriptTool = {
			kind: "tool",
			name: "Read",
			detail: "a.ts",
			group: "read",
			result: "x",
		};
		const line =
			renderTranscript(50, 8, [{ prompt: "hi", response: [historical] }], 0)
				.map(plain)
				.find((item) => item.includes("Read")) ?? "";

		assert.equal(/\d+\.\d+s/.test(line), false);
	});
});
