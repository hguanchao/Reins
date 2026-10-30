import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { quoteForShell } from "#src/sandbox/shell-quote.ts";

describe("shell 引用", () => {
	it("普通文本用单引号包起来", () => {
		assert.equal(quoteForShell("hello"), "'hello'");
	});

	it("含空格的路径整体保持一个词", () => {
		assert.equal(quoteForShell("/home/u/my proj"), "'/home/u/my proj'");
	});

	it("内部单引号先闭合再转义", () => {
		assert.equal(quoteForShell("it's"), "'it'\\''s'");
	});

	it("命令替换与变量展开不会被单引号里的内容触发", () => {
		// 双引号引用在 bash 里挡不住 $(...) 与反引号；单引号是唯一可靠的形式
		const quoted = quoteForShell("$(rm -rf /) `id` $HOME");
		assert.equal(quoted, "'$(rm -rf /) `id` $HOME'");
	});
});
