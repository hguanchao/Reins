import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSkillDraft } from "#src/skills/draft.ts";

describe("技能表单校验", () => {
	it("接受合法的名称、单行描述与正文", () => {
		const result = parseSkillDraft({
			name: "release-notes",
			description: "按提交记录整理发布说明",
			content: "# 步骤\n\n1. 读取提交\n2. 归纳变更",
		});
		assert.equal(result.ok, true);
		assert.deepEqual(result.draft, {
			name: "release-notes",
			description: "按提交记录整理发布说明",
			content: "# 步骤\n\n1. 读取提交\n2. 归纳变更",
		});
	});

	it("拒绝非法名称、多行描述与空正文", () => {
		assert.equal(parseSkillDraft({ name: "../escape", description: "d", content: "c" }).ok, false);
		assert.equal(parseSkillDraft({ name: "Bad Name", description: "d", content: "c" }).ok, false);
		assert.equal(parseSkillDraft({ name: "ok", description: "a\nb", content: "c" }).ok, false);
		assert.equal(parseSkillDraft({ name: "ok", description: "d", content: "  " }).ok, false);
	});
});
