import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { trustPageLines, type TrustPageInput } from "../../../src/tui/page/trust.ts";
import { displayWidth } from "../../../src/tui/render/text.ts";

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function input(overrides: Partial<TrustPageInput> = {}): TrustPageInput {
	return {
		root: "/work/project",
		files: ["/work/project/.reins/config.toml", "/work/project/AGENTS.md"],
		skillDirectories: ["/work/project/.reins/skills"],
		selection: "trust",
		pending: false,
		...overrides,
	};
}

describe("工作区信任页", () => {
	it("逐条列出会生效的文件与技能目录，路径按工作区相对位置显示", () => {
		const lines = trustPageLines(input(), 80, 40);
		const text = lines.map(plain).join("\n");

		assert.match(text, /Workspace trust/);
		assert.match(text, /Files read under this trust/);
		assert.match(text, /\.reins\/config\.toml|\.reins\\config\.toml/);
		assert.match(text, /AGENTS\.md/);
		assert.match(text, /Skill directories scanned under this trust/);
		assert.match(text, /Trusting lets those files take effect\./);
		assert.match(text, /Not trusting keeps the default/);
		// 相对路径就不该再出现工作区根，否则一眼看不出是哪一个文件
		assert.equal(text.includes("/work/project/.reins"), false);
	});

	it("给出三个结论，默认高亮记住信任这一项", () => {
		const text = trustPageLines(input(), 80, 40).map(plain).join("\n");
		assert.match(text, /› Trust this workspace/);
		assert.match(text, / {2}Trust for this session only/);
		assert.match(text, / {2}Do not trust/);
	});

	it("切换选中项时标记跟着走，未选中项保持同宽占位", () => {
		const session = trustPageLines(input({ selection: "session" }), 80, 40)
			.map(plain)
			.join("\n");
		assert.match(session, / {2}Trust this workspace/);
		assert.match(session, /› Trust for this session only/);

		const skip = trustPageLines(input({ selection: "skip" }), 80, 40)
			.map(plain)
			.join("\n");
		assert.match(skip, /› Do not trust/);
	});

	it("对话框在终端里居中：左右留白相等，上下都留出空行", () => {
		const width = 100;
		const height = 40;
		const lines = trustPageLines(input(), width, height).map(plain);
		assert.equal(lines.length, height);

		const top = lines.findIndex((line) => line.trim().length > 0);
		const bottom = lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim().length > 0);
		assert.ok(top > 0, "上方应当留白");
		assert.ok(bottom < height - 1, "下方应当留白");
		// 上下留白差值不超过一行：奇数行差一属于取整
		assert.ok(Math.abs(top - (height - 1 - bottom)) <= 1);

		const first = lines[top] ?? "";
		const left = first.length - first.trimStart().length;
		assert.equal(left, Math.floor((width - 76) / 2));
	});

	it("没有某一类资源时不画空分节", () => {
		const onlyFiles = trustPageLines(input({ skillDirectories: [] }), 80, 40)
			.map(plain)
			.join("\n");
		assert.equal(onlyFiles.includes("Skill directories"), false);

		const onlySkills = trustPageLines(input({ files: [] }), 80, 40)
			.map(plain)
			.join("\n");
		assert.equal(onlySkills.includes("Files read"), false);
	});

	it("工作区外的路径保持绝对路径，不显示成一串上级目录", () => {
		const lines = trustPageLines(input({ files: ["/elsewhere/shared.toml"] }), 80, 40).map(plain);
		assert.ok(lines.some((line) => line.includes("/elsewhere/shared.toml")));
	});

	it("记录结论期间只显示进行中的说明，不再给出可执行的动作", () => {
		const text = trustPageLines(input({ pending: true }), 80, 40).map(plain).join("\n");
		assert.match(text, /Recording the decision\.\.\./);
		assert.equal(text.includes("enter confirm"), false);
	});

	it("窄终端与矮终端下溢出内容被截断，不超出给定尺寸", () => {
		for (const [width, height] of [
			[30, 40],
			[80, 12],
			[20, 8],
		] as const) {
			const lines = trustPageLines(input(), width, height);
			assert.equal(lines.length, height);
			for (const line of lines) assert.ok(displayWidth(plain(line)) <= width);
		}
	});
});
