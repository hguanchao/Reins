import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	filterSkills,
	findSkillToken,
	renderSkillMenu,
	skillMenuHeight,
	type SkillMenuItem,
} from "#src/tui/panel/skill-menu.ts";

const SKILLS: readonly SkillMenuItem[] = [
	{ name: "deploy-docs", description: "部署文档站点", scope: "project" },
	{ name: "review-pr", description: "审查当前改动", scope: "user" },
	{ name: "release", description: "", scope: "user" },
];

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("$ 技能片段", () => {
	it("识别行首与空白后的 $，并给出光标前的过滤词", () => {
		assert.deepEqual(findSkillToken("$dep", 4), { start: 0, end: 4, query: "dep" });
		assert.deepEqual(findSkillToken("我想 $dep", 7), { start: 3, end: 7, query: "dep" });
		// 光标可以停在片段中间，插入时整段替换
		assert.deepEqual(findSkillToken("$dep 文档", 3), { start: 0, end: 4, query: "de" });
		// 刚敲下 $ 本身就是引用：空过滤词，面板列全部技能
		assert.deepEqual(findSkillToken("$", 1), { start: 0, end: 1, query: "" });
	});

	it("普通文本里的 $ 不算引用", () => {
		// 前面不是空白：价格、标识符里夹着 $ 都不弹
		assert.equal(findSkillToken("花了$5", 5), undefined);
		assert.equal(findSkillToken("a$b", 3), undefined);
		// $ 与光标之间出现名字之外的字符：不是技能引用
		assert.equal(findSkillToken("$a.b", 4), undefined);
		assert.equal(findSkillToken("${x}", 4), undefined);
		// 合法的名字字符不是障碍：$PATH 是一个完整片段
		assert.deepEqual(findSkillToken("用 $PATH", 7), { start: 2, end: 7, query: "PATH" });
		// 紧跟在空白之后的 $ 即使还没打字也是引用：空过滤词
		assert.deepEqual(findSkillToken("x $", 3), { start: 2, end: 3, query: "" });
		assert.equal(findSkillToken("", 0), undefined);
	});
});

describe("技能过滤", () => {
	it("空查询按原序返回全部", () => {
		assert.deepEqual(filterSkills(SKILLS, "").map((skill) => skill.name), [
			"deploy-docs",
			"review-pr",
			"release",
		]);
	});

	it("名称前缀优先于包含，描述命中兜底", () => {
		const skills: readonly SkillMenuItem[] = [
			{ name: "deploy", description: "", scope: "user" },
			{ name: "redeploy", description: "", scope: "user" },
			{ name: "other", description: "用于 deploy 流程", scope: "user" },
		];
		assert.deepEqual(filterSkills(skills, "dep").map((skill) => skill.name), [
			"deploy",
			"redeploy",
			"other",
		]);
		// 描述里也没有就整体不出现
		assert.deepEqual(filterSkills(skills, "zzz"), []);
	});

	it("大小写不敏感", () => {
		assert.equal(filterSkills(SKILLS, "DEP").length, 1);
	});
});

describe("技能面板渲染", () => {
	it("行内包含名称、来源徽标与描述", () => {
		const state = {
			items: SKILLS,
			token: findSkillToken("$", 1)!,
			cursor: 0,
			scrollTop: 0,
		};
		const lines = renderSkillMenu(60, state).map(plain);
		assert.ok(lines.some((line) => line.includes("deploy-docs")));
		assert.ok(lines.some((line) => line.includes("project")));
		assert.ok(lines.some((line) => line.includes("部署文档站点")));
	});

	it("名称列取最宽名字封顶，徽标列与描述列逐行对齐", () => {
		const state = {
			items: SKILLS,
			token: findSkillToken("$", 1)!,
			cursor: 0,
			scrollTop: 0,
		};
		const lines = renderSkillMenu(80, state).map(plain).filter((line) => line.trim().length > 0);
		// 徽标列在每一行的同一列开始（user 补空格与 project 对齐）
		const badgeColumns = lines
			.filter((line) => /user|project/.test(line.slice(3)))
			.map((line) => line.slice(3).indexOf("user") >= 0 ? line.slice(3).indexOf("user") : line.slice(3).indexOf("project"));
		assert.ok(badgeColumns.length >= 3);
		assert.ok(badgeColumns.every((column) => column === badgeColumns[0]));
		// 描述列同样对齐
		const descriptionColumns = lines
			.filter((line) => line.includes("部署文档站点") || line.includes("审查当前改动"))
			.map((line) =>
				line.includes("部署文档站点") ? line.indexOf("部署文档站点") : line.indexOf("审查当前改动"),
			);
		assert.equal(descriptionColumns.length, 2);
		assert.ok(descriptionColumns.every((column) => column === descriptionColumns[0]));
	});

	it("清单为空时显示空态句", () => {
		const state = {
			items: [],
			token: findSkillToken("$zz", 3)!,
			cursor: 0,
			scrollTop: 0,
		};
		const lines = renderSkillMenu(40, state).map(plain);
		assert.ok(lines.some((line) => line.includes("No matching skills.")));
		// 空态行也占一行：高度至少为边框加空态
		assert.ok(skillMenuHeight(0) >= 3);
	});
});
