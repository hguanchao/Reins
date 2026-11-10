import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKSPACE_NAME_LIMIT } from "#src/workspace/name.ts";

describe("工作区显示名限制", () => {
	it("长度上限为 60 个字符", () => {
		assert.equal(WORKSPACE_NAME_LIMIT, 60);
	});
});
