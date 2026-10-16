import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readTool } from "../../../src/tools/builtin/read.ts";
import { createTestWorkspace, expectFailure, expectSuccess, type TestWorkspace } from "../helpers.ts";

const workspace: TestWorkspace = createTestWorkspace();

after(() => {
	workspace.remove();
});

describe("read 工具", () => {
	it("读取整个文件", async () => {
		workspace.writeFile("a.txt", "第一行\n第二行\n");
		const result = await readTool.execute(workspace.context({ path: "a.txt" }));
		expectSuccess(result);
		assert.equal(result.content, "第一行\n第二行");
	});

	it("按 offset 与 limit 取一段，并说明还有内容", async () => {
		workspace.writeFile(
			"long.txt",
			Array.from({ length: 10 }, (_item, index) => `第${index + 1}行`).join("\n"),
		);
		const result = await readTool.execute(workspace.context({ path: "long.txt", offset: 3, limit: 2 }));
		assert.ok(result.content.startsWith("第3行\n第4行"));
		assert.ok(result.content.includes("[显示第 3-4 行，共 10 行；用 offset=5 继续]"));
	});

	it("读到末段时不再提示继续", async () => {
		workspace.writeFile("tail.txt", "甲\n乙");
		const result = await readTool.execute(workspace.context({ path: "tail.txt", offset: 2 }));
		assert.equal(result.content, "乙");
	});

	it("offset 超出范围时明确报错", async () => {
		workspace.writeFile("short.txt", "甲");
		const result = await readTool.execute(workspace.context({ path: "short.txt", offset: 5 }));
		expectFailure(result, "offset=5 超出了范围");
	});

	it("空文件单独说明", async () => {
		workspace.writeFile("empty.txt", "");
		const result = await readTool.execute(workspace.context({ path: "empty.txt" }));
		assert.equal(result.content, "empty.txt 是空文件");
	});

	it("文件不存在时报错", async () => {
		const result = await readTool.execute(workspace.context({ path: "missing.txt" }));
		expectFailure(result, "读取 missing.txt 失败");
	});

	it("目录不当作文件读", async () => {
		mkdirSync(join(workspace.root, "subdir"), { recursive: true });
		const result = await readTool.execute(workspace.context({ path: "subdir" }));
		expectFailure(result, "是一个目录");
	});

	it("二进制文件不按文本返回", async () => {
		workspace.writeBytes("bin.dat", Buffer.from([0x01, 0x00, 0x02, 0x03]));
		const result = await readTool.execute(workspace.context({ path: "bin.dat" }));
		expectFailure(result, "看起来是二进制文件");
	});

	it("CRLF 文件按 LF 呈现，便于后续用同一套片段匹配", async () => {
		workspace.writeBytes("crlf.txt", Buffer.from("甲\r\n乙\r\n", "utf8"));
		const result = await readTool.execute(workspace.context({ path: "crlf.txt" }));
		assert.equal(result.content, "甲\n乙");
	});

	it("识别带字节顺序标记的 UTF-16 文件并注明编码", async () => {
		const body = Buffer.from("甲乙", "utf16le");
		workspace.writeBytes("utf16.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
		const result = await readTool.execute(workspace.context({ path: "utf16.txt" }));
		assert.ok(result.content.startsWith("甲乙"));
		assert.ok(result.content.includes("[文件编码为 utf16le]"));
	});

	it("给出结构化结果供界面使用", async () => {
		workspace.writeFile("detail.txt", "甲\n乙");
		const result = await readTool.execute(workspace.context({ path: "detail.txt" }));
		assert.deepEqual(result.details, {
			path: "detail.txt",
			startLine: 1,
			endLine: 2,
			totalLines: 2,
			encoding: "utf8",
		});
	});

	it("绝对路径落在工作根之外时按原样显示", async () => {
		workspace.writeFile("in.txt", "x");
		const outside = join(workspace.root, "..", "outside.txt");
		workspace.writeFile("../outside.txt", "y");
		const result = await readTool.execute(workspace.context({ path: outside }));
		expectSuccess(result);
		assert.ok(String(result.details && (result.details as { path: string }).path).includes("outside.txt"));
	});

	it("沙箱拒绝读取时把理由带出来", async () => {
		// 工具只管抛错，归一成错误结果是调用管线（注册表）的职责
		await assert.rejects(
			() =>
				readTool.execute({
					...workspace.context({ path: "guarded.txt" }),
					sandbox: {
						assertPathAllowed: () => {
							throw new Error("该路径被策略禁止读取");
						},
						wrapCommand: (command: string) => command,
					},
				}),
			/该路径被策略禁止读取/,
		);
	});
});
