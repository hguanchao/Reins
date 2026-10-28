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

function render(input: TrustPageInput, width = 80, height = 24): string[] {
	return trustPageLines(input, width, height).map(plain);
}

describe("工作区信任页", () => {
	it("标题钉在左上，逐条列出会生效的文件与技能目录", () => {
		const lines = render(input());

		assert.equal(lines[0]?.trimEnd(), "Reins — workspace trust");
		assert.ok((lines[0] ?? "").startsWith("Reins"), "标题不该居中，它就在左上角");
		const text = lines.join("\n");
		assert.match(text, /Files read under this trust/);
		assert.match(text, /\.reins\/config\.toml|\.reins\\config\.toml/);
		assert.match(text, /AGENTS\.md/);
		assert.match(text, /Skill directories scanned under this trust/);
		assert.match(text, /Trusting lets those files take effect\./);
		assert.match(text, /Not trusting keeps the default/);
		// 相对路径就不该再出现工作区根，否则一眼看不出是哪一个文件
		assert.equal(text.includes("/work/project/.reins"), false);
	});

	it("正文逐行水平居中：行首缩进等于剩余宽度的一半", () => {
		const width = 80;
		const lines = render(input(), width, 24);
		// 跳过标题行，只看中间的描述段落
		for (const keyword of ["This workspace ships files", "Trusting lets those files take effect"]) {
			const line = lines.find((candidate) => candidate.includes(keyword));
			assert.ok(line !== undefined, `缺少以 ${keyword} 开头的描述行`);
			const left = line.length - line.trimStart().length;
			const expected = Math.floor((width - displayWidth(line.trim())) / 2);
			assert.ok(left > 0, "居中就不该贴左边缘");
			assert.equal(left, expected);
		}
	});

	it("底部固定四行：分隔线、留白、三档横排、留白", () => {
		const lines = render(input(), 80, 24);
		assert.equal(lines.length, 24);
		assert.ok((lines.at(-4) ?? "").trim().startsWith("─"), "倒数第四行应是分隔线");
		assert.equal((lines.at(-3) ?? "").trim(), "", "分隔线与选项之间应留一行空白");
		const options = lines.at(-2) ?? "";
		assert.match(options, /› \[y\] Trust this workspace/);
		assert.match(options, /\[s\] Trust for this session/);
		assert.match(options, /\[n\] Do not trust/);
		assert.equal((lines.at(-1) ?? "").trim(), "", "选项与底边之间应留一行空白");
	});

	it("选项水平居中，且在底部区上下留白相等", () => {
		const width = 80;
		const lines = render(input(), width, 24);
		const options = lines.at(-2) ?? "";
		const left = options.length - options.trimStart().length;
		const expected = Math.floor((width - displayWidth(options.trim())) / 2);
		assert.ok(left > 0);
		assert.equal(left, expected);
		// 选项之上与之下各一行空白，位置才算垂直居中
		assert.equal((lines.at(-3) ?? "").trim(), "");
		assert.equal((lines.at(-1) ?? "").trim(), "");
	});

	it("正文在标题与分隔线之间垂直居中：上下留白大致相等", () => {
		const lines = render(input(), 80, 30);
		// 标题占首行，正文从其后开始；分隔线在倒数第三行
		const bodyEnd = lines.length - 4;
		const first = lines.findIndex((line, index) => index > 0 && index < bodyEnd && line.trim().length > 0);
		const last = lines.reduce(
			(found, line, index) => (index > 0 && index < bodyEnd && line.trim().length > 0 ? index : found),
			0,
		);
		assert.ok(first > 1, "标题之下应留出空白，正文才谈得上居中");
		const above = first - 1;
		const below = bodyEnd - 1 - last;
		assert.ok(Math.abs(above - below) <= 1, `上下留白应大致相等，实际 ${above} / ${below}`);
	});

	it("当前档用标记高亮，移动后标记跟着走", () => {
		const last = (selection: TrustPageInput["selection"]): string =>
			render(input({ selection }), 80, 24).at(-2) ?? "";

		assert.match(last("trust"), /› \[y\] Trust this workspace\s+\[s\] Trust for this session\s+\[n\] Do not trust/);
		assert.match(last("session"), / {2}\[y\] Trust this workspace\s+› \[s\] Trust for this session/);
		assert.match(last("skip"), /› \[n\] Do not trust/);
	});

	it("窄终端退到短标签，仍然给出三档", () => {
		const line = render(input(), 44, 24).at(-2) ?? "";
		assert.match(line, /› \[y\] Trust/);
		assert.match(line, /\[s\] Session/);
		assert.match(line, /\[n\] Skip/);
		assert.ok(displayWidth(line) <= 44);
	});

	it("没有某一类资源时不画空分节", () => {
		const onlyFiles = render(input({ skillDirectories: [] })).join("\n");
		assert.equal(onlyFiles.includes("Skill directories"), false);

		const onlySkills = render(input({ files: [] })).join("\n");
		assert.equal(onlySkills.includes("Files read"), false);
	});

	it("工作区外的路径保持绝对路径，不显示成一串上级目录", () => {
		const text = render(input({ files: ["/elsewhere/shared.toml"] })).join("\n");
		assert.ok(text.includes("/elsewhere/shared.toml"));
	});

	it("记录结论时把选项行换成进行中的说明", () => {
		const lines = render(input({ pending: true }), 80, 24);
		assert.match(lines.at(-2) ?? "", /Recording the decision\.\.\./);
		assert.equal((lines.at(-2) ?? "").includes("Trust"), false);
		// 固定区仍占四行，画面不会跟着跳
		assert.equal(lines.length, 24);
	});

	it("行数恒等于给定高度，内容每行都不超出宽度", () => {
		for (const [width, height] of [
			[30, 40],
			[80, 12],
			[20, 8],
			[120, 30],
		] as const) {
			const lines = trustPageLines(input(), width, height);
			assert.equal(lines.length, height);
			for (const line of lines) assert.ok(displayWidth(plain(line)) <= width, `${width}x${height}: ${line}`);
		}
	});
});
