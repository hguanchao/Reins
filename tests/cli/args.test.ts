import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs, UsageError, HELP_TEXT } from "../../src/cli/args.ts";

describe("parseArgs 命令", () => {
	it("没有参数时显示帮助", () => {
		assert.equal(parseArgs([]).command, "help");
	});

	it("识别 config check", () => {
		const options = parseArgs(["config", "check"]);
		assert.equal(options.command, "config-check");
	});

	it("帮助与版本优先于其他参数", () => {
		assert.equal(parseArgs(["--help"]).command, "help");
		assert.equal(parseArgs(["-h"]).command, "help");
		assert.equal(parseArgs(["--version"]).command, "version");
		assert.equal(parseArgs(["-v"]).command, "version");
		assert.equal(parseArgs(["config", "check", "--help"]).command, "help");
	});

	it("帮助文本说明了用法", () => {
		assert.ok(HELP_TEXT.includes("reins config check"));
	});
});

describe("parseArgs 路径覆盖", () => {
	it("接受 --config 与 --models 的两种写法", () => {
		assert.equal(parseArgs(["--config", "/a.toml"]).configPath, "/a.toml");
		assert.equal(parseArgs(["--config=/a.toml"]).configPath, "/a.toml");
		assert.equal(parseArgs(["--models", "/b.json"]).modelsPath, "/b.json");
		assert.equal(parseArgs(["--models=/b.json"]).modelsPath, "/b.json");
	});

	it("可以与子命令同时使用", () => {
		const options = parseArgs(["config", "check", "--config", "/a.toml", "--models=/b.json"]);
		assert.equal(options.command, "config-check");
		assert.equal(options.configPath, "/a.toml");
		assert.equal(options.modelsPath, "/b.json");
	});

	it("缺少路径时按用法错误处理", () => {
		assert.throws(() => parseArgs(["--config"]), UsageError);
		assert.throws(() => parseArgs(["--config", "--models"]), UsageError);
		assert.throws(() => parseArgs(["--config="]), UsageError);
	});
});

describe("parseArgs 的句子模式", () => {
	it("位置参数拼成要执行的句子", () => {
		const options = parseArgs(["看看", "这个项目"]);
		assert.equal(options.command, "print");
		assert.equal(options.prompt, "看看 这个项目");
	});

	it("-p 与直接给句子等价", () => {
		assert.equal(parseArgs(["-p", "做事"]).prompt, "做事");
		assert.equal(parseArgs(["--print", "做事"]).prompt, "做事");
		assert.equal(parseArgs(["做事"]).prompt, "做事");
	});

	it("-p 后面没有句子时报用法错误", () => {
		assert.throws(() => parseArgs(["-p"]), /需要给出要执行的句子/);
	});

	it("-- 之后的短横线开头内容当作句子", () => {
		const options = parseArgs(["--", "--help"]);
		assert.equal(options.command, "print");
		assert.equal(options.prompt, "--help");
	});

	it("显式给出的选项不会混进句子", () => {
		const options = parseArgs(["做事", "--config", "/a.toml"]);
		assert.equal(options.prompt, "做事");
		assert.equal(options.configPath, "/a.toml");
	});
});

describe("parseArgs 拒绝非法输入", () => {
	it("拒绝无法识别的选项", () => {
		assert.throws(() => parseArgs(["--nope"]), UsageError);
		assert.throws(() => parseArgs(["-x"]), UsageError);
	});

	it("config 子命令的形式写错时报错", () => {
		assert.throws(() => parseArgs(["config"]), /只支持 check/);
		assert.throws(() => parseArgs(["config", "list"]), /只支持 check/);
		assert.throws(() => parseArgs(["config", "check", "多余"]), /不接受额外参数/);
	});
});
