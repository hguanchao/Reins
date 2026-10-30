import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { ResultSpiller, stripSpillFooter } from "#src/tools/spill.ts";

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

	it("预览切点不落在代理对中间", () => {
		const spiller = new ResultSpiller(11, directory);
		const result = spiller.spill("emoji", "😀".repeat(10));
		// 按 UTF-16 码元切会把 emoji 劈开，预览里留下半个字符
		assert.equal(result.includes("\uFFFD"), false);
		for (const char of result) {
			assert.ok(char.length <= 2, `unexpected code unit length for ${char}`);
		}
	});

	it("落盘文件只有当前用户可读", { skip: process.platform === "win32" }, () => {
		const spiller = new ResultSpiller(5, directory);
		const result = spiller.spill("secret", "zzzzzzz");
		const path = /written to ([^,]+), read it back/.exec(result)?.[1];
		assert.ok(path !== undefined);
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});
});

describe("尾注剥离", () => {
	it("只在最后一段尾注处切断，正文自带的空行方括号不会被当成尾注", () => {
		const content = "see\n\n[link] and more text\n\n[the full result is 100 characters; written to /tmp/x]";
		assert.equal(stripSpillFooter(content), "see\n\n[link] and more text");
	});

	it("没有尾注时原样返回", () => {
		assert.equal(stripSpillFooter("plain text\n"), "plain text");
	});
});
