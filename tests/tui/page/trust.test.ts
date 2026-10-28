import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { trustActionLines, trustPageLines, type TrustPageInput } from "../../../src/tui/page/trust.ts";
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
		...overrides,
	};
}

describe("工作区信任页", () => {
	it("逐条列出会生效的文件与技能目录，路径按工作区相对位置显示", () => {
		const lines = trustPageLines(input(), 80);
		const text = lines.map(plain).join("\n");

		assert.equal(plain(lines[0] ?? "").trimEnd(), "Reins — workspace trust");
		assert.match(text, /Files read under this trust/);
		assert.match(text, /\.reins\/config\.toml|\.reins\\config\.toml/);
		assert.match(text, /AGENTS\.md/);
		assert.match(text, /Skill directories scanned under this trust/);
		assert.match(text, /\.reins\/skills|\.reins\\skills/);
		assert.match(text, /Trusting lets those files take effect\./);
		assert.match(text, /Skipping keeps the default/);
		// 相对路径就不该再出现工作区根，否则一眼看不出是哪一个文件
		assert.equal(text.includes("/work/project/.reins"), false);
		for (const line of lines) assert.ok(displayWidth(plain(line)) <= 80);
	});

	it("没有某一类资源时不画空分节", () => {
		const onlyFiles = trustPageLines(input({ skillDirectories: [] }), 80).map(plain).join("\n");
		assert.equal(onlyFiles.includes("Skill directories"), false);

		const onlySkills = trustPageLines(input({ files: [] }), 80).map(plain).join("\n");
		assert.equal(onlySkills.includes("Files read"), false);
	});

	it("工作区外的路径保持绝对路径，不显示成一串上级目录", () => {
		const lines = trustPageLines(input({ files: ["/elsewhere/shared.toml"] }), 80).map(plain);
		assert.ok(lines.some((line) => line.includes("/elsewhere/shared.toml")));
	});

	it("动作行高亮选中项，切换后标记跟着走", () => {
		const trust = trustActionLines(80, "trust", false).map(plain).join("\n");
		assert.match(trust, /› \[y\] trust this workspace/);
		assert.match(trust, /\[n\] not now/);

		const skip = trustActionLines(80, "skip", false).map(plain).join("\n");
		assert.match(skip, /\[y\] trust this workspace/);
		assert.match(skip, /› \[n\] not now/);
	});

	it("记录结论期间只显示进行中的说明，不再给出可执行的动作", () => {
		const text = trustActionLines(80, "trust", true).map(plain).join("\n");
		assert.match(text, /Recording the decision\.\.\./);
		assert.equal(text.includes("[y]"), false);
	});

	it("窄终端下动作行按整行截断，不会溢出", () => {
		const lines = trustActionLines(20, "trust", false);
		for (const line of lines) assert.ok(displayWidth(plain(line)) <= 20);
	});
});
