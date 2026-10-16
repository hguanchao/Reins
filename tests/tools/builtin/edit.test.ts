import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { editTool } from "../../../src/tools/builtin/edit.ts";
import { createTestWorkspace, expectFailure, expectSuccess, type TestWorkspace } from "../helpers.ts";

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

describe("edit 工具", () => {
	it("替换唯一匹配的片段并给出差异", async () => {
		workspace.writeFile("a.txt", "第一行\n第二行\n第三行\n");
		const result = await editTool.execute(
			workspace.context({ path: "a.txt", edits: [{ oldText: "第二行", newText: "改过的第二行" }] }),
		);

		expectSuccess(result);
		assert.equal(workspace.readFile("a.txt"), "第一行\n改过的第二行\n第三行\n");
		assert.ok(result.content.includes("- 第二行"));
		assert.ok(result.content.includes("+ 改过的第二行"));
		assert.ok(result.content.includes("@@ 第 2 行 @@"));
	});

	it("oldText 找不到时拒绝，并指出该用什么办法", async () => {
		workspace.writeFile("a.txt", "实际内容\n");
		const result = await editTool.execute(
			workspace.context({ path: "a.txt", edits: [{ oldText: "并不存在", newText: "x" }] }),
		);
		expectFailure(result, "在文件中找不到");
		assert.ok(result.content.includes("先用 read 确认原文"));
		assert.equal(workspace.readFile("a.txt"), "实际内容\n");
	});

	it("oldText 出现多次时拒绝，避免改错位置", async () => {
		workspace.writeFile("a.txt", "同名\n中间\n同名\n");
		const result = await editTool.execute(
			workspace.context({ path: "a.txt", edits: [{ oldText: "同名", newText: "改了" }] }),
		);
		expectFailure(result, "出现了多次");
		assert.equal(workspace.readFile("a.txt"), "同名\n中间\n同名\n");
	});

	it("oldText 为空时拒绝", async () => {
		workspace.writeFile("a.txt", "内容");
		const result = await editTool.execute(
			workspace.context({ path: "a.txt", edits: [{ oldText: "", newText: "插入" }] }),
		);
		expectFailure(result, "oldText 为空");
	});

	it("多条修改都基于同一个原文", async () => {
		workspace.writeFile("a.txt", "甲\n乙\n丙\n");
		const result = await editTool.execute(
			workspace.context({
				path: "a.txt",
				edits: [
					{ oldText: "甲", newText: "甲改" },
					{ oldText: "丙", newText: "丙改" },
				],
			}),
		);
		expectSuccess(result);
		assert.equal(workspace.readFile("a.txt"), "甲改\n乙\n丙改\n");
		assert.ok(result.content.includes("共 2 处"));
	});

	it("范围重叠时整次修改都不生效", async () => {
		workspace.writeFile("a.txt", "abcdef\n");
		const result = await editTool.execute(
			workspace.context({
				path: "a.txt",
				edits: [
					{ oldText: "abc", newText: "x" },
					{ oldText: "bcd", newText: "y" },
				],
			}),
		);
		expectFailure(result, "范围重叠");
		assert.equal(workspace.readFile("a.txt"), "abcdef\n");
	});

	it("保留 CRLF 行尾", async () => {
		workspace.writeBytes("crlf.txt", Buffer.from("甲\r\n乙\r\n", "utf8"));
		const result = await editTool.execute(
			workspace.context({ path: "crlf.txt", edits: [{ oldText: "乙", newText: "乙改" }] }),
		);
		expectSuccess(result);
		assert.equal(workspace.readFile("crlf.txt"), "甲\r\n乙改\r\n");
	});

	it("保留字节顺序标记与编码", async () => {
		const body = Buffer.from("甲乙", "utf16le");
		workspace.writeBytes("utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
		const result = await editTool.execute(
			workspace.context({ path: "utf16.txt", edits: [{ oldText: "乙", newText: "丙" }] }),
		);
		expectSuccess(result);

		// 按字节读回：UTF-16 的内容经 utf8 解码只会得到替换字符
		const written = readFileSync(join(workspace.root, "utf16.txt"));
		assert.equal(written[0], 0xff);
		assert.equal(written[1], 0xfe);
		assert.equal(written.subarray(2).toString("utf16le"), "甲丙");
	});

	it("新文本为空表示删除", async () => {
		workspace.writeFile("a.txt", "保留\n删掉\n保留2\n");
		const result = await editTool.execute(
			workspace.context({ path: "a.txt", edits: [{ oldText: "删掉\n", newText: "" }] }),
		);
		expectSuccess(result);
		assert.equal(workspace.readFile("a.txt"), "保留\n保留2\n");
	});

	it("内容没有变化时如实说", async () => {
		workspace.writeFile("a.txt", "内容");
		const result = await editTool.execute(
			workspace.context({ path: "a.txt", edits: [{ oldText: "内容", newText: "内容" }] }),
		);
		expectSuccess(result);
		assert.ok(result.content.includes("内容没有变化"));
	});
});

describe("edit 工具的参数容忍", () => {
	it("接受被写成 JSON 字符串的 edits", () => {
		const prepared = editTool.prepareArguments?.({
			path: "a.txt",
			edits: JSON.stringify([{ oldText: "甲", newText: "乙" }]),
		});
		assert.deepEqual(prepared, { path: "a.txt", edits: [{ oldText: "甲", newText: "乙" }] });
	});

	it("接受只给一条却写成对象而不是数组", () => {
		const prepared = editTool.prepareArguments?.({
			path: "a.txt",
			edits: { oldText: "甲", newText: "乙" },
		});
		assert.deepEqual(prepared, { path: "a.txt", edits: [{ oldText: "甲", newText: "乙" }] });
	});

	it("字符串解不出来时原样交给校验去报错", () => {
		const prepared = editTool.prepareArguments?.({ path: "a.txt", edits: "{不是 JSON" });
		assert.equal(prepared?.["edits"], "{不是 JSON");
	});
});
