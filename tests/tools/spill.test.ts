import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

import { ResultSpiller } from "../../src/tools/spill.ts";

const directory = mkdtempSync(join(tmpdir(), "reins-spill-"));

after(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("大结果落盘", () => {
	it("未超过阈值时原样返回", () => {
		const spiller = new ResultSpiller(100, directory);
		assert.equal(spiller.spill("read", "短内容"), "短内容");
	});

	it("阈值为 0 时关闭该行为", () => {
		const spiller = new ResultSpiller(0, directory);
		const content = "x".repeat(1000);
		assert.equal(spiller.spill("read", content), content);
	});

	it("超过阈值时落盘，正文里给出头尾预览与文件路径", () => {
		const spiller = new ResultSpiller(100, directory);
		const content = `${"头".repeat(50)}${"中".repeat(200)}${"尾".repeat(50)}`;
		const result = spiller.spill("bash", content);

		assert.ok(result.startsWith("头".repeat(50)));
		assert.ok(result.includes("中间 200 个字符已省略"));
		assert.ok(result.includes("尾".repeat(50)));
		assert.ok(result.includes("已写入"));

		const match = /已写入 (.+?)，可按行读取/.exec(result);
		assert.ok(match !== null, `预览里应当给出文件路径：${result.slice(-120)}`);
		const path = match[1];
		assert.ok(existsSync(path));
		assert.equal(readFileSync(path, "utf8"), content);
	});

	it("工具名里的特殊字符不会跑进文件名", () => {
		const spiller = new ResultSpiller(10, directory);
		const result = spiller.spill("mcp:docs/read", "y".repeat(100));
		const match = /已写入 (.+?)，可按行读取/.exec(result);
		assert.ok(match !== null);
		const fileName = basename(match[1]);
		assert.ok(!fileName.includes(":"), fileName);
		assert.ok(!fileName.includes("/"), fileName);
	});

	it("落盘失败时明确说出来，而不是只给一段被截断的内容", () => {
		// 把父路径指成一个已存在的文件，建目录必然失败
		const blocker = join(directory, "blocker");
		writeFileSync(blocker, "x", "utf8");
		const spiller = new ResultSpiller(10, join(blocker, "sub"));

		const result = spiller.spill("read", "z".repeat(100));
		assert.ok(result.includes("写入临时文件失败"));
		assert.ok(result.includes("超出部分无法获取"));
	});
});
