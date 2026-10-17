import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { ResultSpiller } from "../../src/tools/spill.ts";

describe("结果落盘", () => {
	const directory = join(tmpdir(), `reins-spill-${Date.now()}`);
	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	it("未超阈值原样返回，不写文件", () => {
		const spiller = new ResultSpiller(100, directory);
		assert.equal(spiller.spill("probe", "short"), "short");
	});

	it("阈值为 0 即关闭", () => {
		const spiller = new ResultSpiller(0, directory);
		assert.equal(spiller.spill("probe", "x".repeat(500)), "x".repeat(500));
	});

	it("超阈值:写盘并在内容里给出路径与总量，头尾各留一半", () => {
		const spiller = new ResultSpiller(20, directory);
		const content = `${"a".repeat(50)}middle${"z".repeat(50)}`;
		const result = spiller.spill("probe", content);
		assert.match(result, /the full result is 106 characters; written to /);
		assert.ok(result.includes("aaaaaaaaaa"), "head retained");
		assert.ok(result.includes("\n\n… (86 characters omitted in the middle) …\n\n"), "middle omitted note");
		assert.ok(result.includes("zzzzzzzzzz"), "tail retained");
		const match = /written to ([^,]+), read it back/.exec(result);
		assert.ok(match);
		const written = readFileSync(match[1]!, "utf8");
		assert.equal(written, content);
	});

	it("两次落盘文件名不冲突", () => {
		const spiller = new ResultSpiller(5, directory);
		spiller.spill("probe", "xxxxxxx1");
		spiller.spill("probe", "xxxxxxx2");
		assert.equal(readdirSync(directory).length, 2);
	});

	it("工具名里不合法的字符折成下划线", () => {
		const spiller = new ResultSpiller(5, directory);
		const result = spiller.spill("mcp:tool/x", "yyyyyyy");
		assert.match(result, /reins-mcp_tool_x-/);
	});
});
