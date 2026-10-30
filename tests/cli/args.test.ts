import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs } from "../../src/cli/args.ts";

describe("parseArgs 命令", () => {
	it("帮助与版本", () => {
		assert.equal(parseArgs(["--help"]).command, "help");
		assert.equal(parseArgs(["-v"]).command, "version");
	});

	it("句子模式:位置参数都是 prompt", () => {
		const options = parseArgs(["hello", "world"]);
		assert.equal(options.command, "print");
		assert.equal(options.prompt, "hello world");
	});

	it("-p 显式非交互", () => {
		assert.equal(parseArgs(["-p", "fix bug"]).command, "print");
		assert.equal(parseArgs(["-p", "fix bug"]).prompt, "fix bug");
	});

	it("-p 缺句子报错", () => {
		assert.throws(() => parseArgs(["-p"]), /-p requires a prompt/);
	});

	it("空输入启动全屏界面", () => {
		assert.equal(parseArgs([]).command, "tui");
	});
});

describe("parseArgs 的配置选项", () => {
	it("config 与 providers 路径", () => {
		assert.equal(parseArgs(["--config=path.toml", "-p", "x"]).configPath, "path.toml");
		assert.equal(parseArgs(["--config", "path.toml", "-p", "x"]).configPath, "path.toml");
		assert.equal(parseArgs(["--providers=providers.json", "-p", "x"]).providersPath, "providers.json");
	});

	it("缺路径值报错", () => {
		assert.throws(() => parseArgs(["--config"]), /--config requires a path/);
		assert.throws(() => parseArgs(["--providers"]), /--providers requires a path/);
	});

	it("布尔开关", () => {
		assert.equal(parseArgs(["--trust"]).trust, true);
		assert.equal(parseArgs(["--no-trust"]).trust, false);
	});

	it("--resume 指定接续会话", () => {
		const options = parseArgs(["--resume", "abc"]);
		assert.equal(options.command, "tui");
		assert.equal(options.resume, "abc");
		assert.equal(parseArgs(["--resume=abc"]).resume, "abc");
	});

	it("--resume 缺 id 报错", () => {
		assert.throws(() => parseArgs(["--resume"]), /--resume requires an id/);
		assert.throws(() => parseArgs(["--resume="]), /--resume requires an id/);
	});
});

describe("parseArgs 拒绝非法输入", () => {
	it("未知选项直接报错", () => {
		assert.throws(() => parseArgs(["--bogus"]), /unknown option --bogus/);
		assert.throws(() => parseArgs(["--yes"]), /unknown option --yes/);
		assert.throws(() => parseArgs(["-y"]), /unknown option -y/);
	});

	it("-- 之后的一切进 prompt", () => {
		const options = parseArgs(["--", "--resume", "-p"]);
		assert.equal(options.prompt, "--resume -p");
		assert.equal(options.command, "print");
	});

	it("--resume 不能和一次性提问一起用", () => {
		assert.throws(
			() => parseArgs(["--resume", "abc", "-p", "x"]),
			/--resume only works with the full-screen interface/,
		);
		assert.throws(
			() => parseArgs(["--resume", "abc", "x"]),
			/--resume only works with the full-screen interface/,
		);
	});
});

describe("parseArgs 的 --json", () => {
	it("与一次性提问一起用时开启事件流", () => {
		const options = parseArgs(["-p", "--json", "做点事"]);
		assert.equal(options.command, "print");
		assert.equal(options.json, true);
		assert.equal(options.prompt, "做点事");
		// 位置参数本身就等价于 -p，--json 也一样成立
		assert.equal(parseArgs(["--json", "做点事"]).json, true);
	});

	it("默认关闭", () => {
		assert.equal(parseArgs(["-p", "x"]).json, false);
		assert.equal(parseArgs([]).json, false);
	});

	it("单独使用时直接报错：全屏界面没有事件流可写", () => {
		assert.throws(() => parseArgs(["--json"]), /--json only works together with -p/);
		assert.throws(
			() => parseArgs(["--json", "--resume", "abc"]),
			/--json only works together with -p/,
		);
	});
});

describe("parseArgs 的插件子命令", () => {
	it("plugin add 解析出动作与来源，来源可以含空格", () => {
		const options = parseArgs(["plugin", "add", "@scope/some-pkg"]);
		assert.equal(options.command, "plugin");
		assert.equal(options.pluginAction, "add");
		assert.equal(options.pluginSource, "@scope/some-pkg");
	});

	it("plugin list 不带参数", () => {
		const options = parseArgs(["plugin", "list"]);
		assert.equal(options.command, "plugin");
		assert.equal(options.pluginAction, "list");
		assert.equal(options.pluginSource, undefined);
	});

	it("动作缺失或未知时报错", () => {
		assert.throws(() => parseArgs(["plugin"]), /add <source> or list/);
		assert.throws(() => parseArgs(["plugin", "remove"]), /add <source> or list/);
	});

	it("add 缺来源报错", () => {
		assert.throws(() => parseArgs(["plugin", "add"]), /requires a source/);
	});
});
