import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs } from "../../src/cli/args.ts";

describe("parseArgs 命令", () => {
	it("帮助文本说明了用法", () => {
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

	it("config check 的合法形式与错处", () => {
		assert.equal(parseArgs(["config", "check"]).command, "config-check");
		assert.throws(() => parseArgs(["config"]), /config only supports the check subcommand/);
		assert.throws(() => parseArgs(["config", "check", "x"]), /takes no extra arguments: x/);
	});

	it("识别 sessions 子命令", () => {
		assert.equal(parseArgs(["sessions", "list"]).sessionsAction, "list");
		assert.equal(parseArgs(["sessions", "list"]).sessionRef, undefined);

		const show = parseArgs(["sessions", "show", "abc"]);
		assert.equal(show.sessionsAction, "show");
		assert.equal(show.sessionRef, "abc");

		const exportOptions = parseArgs(["sessions", "export", "abc"]);
		assert.equal(exportOptions.sessionsAction, "export");
	});

	it("sessions 的动作名与参数个数报错", () => {
		assert.throws(() => parseArgs(["sessions"]), /three subcommands/);
		assert.throws(() => parseArgs(["sessions", "bogus"]), /three subcommands/);
		assert.throws(() => parseArgs(["sessions", "show"]), /requires a session id/);
		assert.throws(() => parseArgs(["sessions", "list", "extra"]), /takes no extra arguments: extra/);
	});
});

describe("parseArgs 的会话选项", () => {
	it("--resume 给出接续目标", () => {
		assert.equal(parseArgs(["--resume", "abc"]).resume, "abc");
		assert.equal(parseArgs(["--resume=abc"]).resume, "abc");
		assert.equal(parseArgs(["--resume", "abc", "--fork"]).fork, true);
		assert.equal(parseArgs(["--resume=abc", "--fork", "--at", "e1"]).forkAt, "e1");
	});

	it("--continue 与 --fork 的组合约束", () => {
		assert.throws(() => parseArgs(["--fork"]), /--fork requires --resume/);
		assert.throws(() => parseArgs(["--at", "e1"]), /--at only works together with --fork/);
		assert.throws(() => parseArgs(["-c", "--resume", "a"]), /use either --continue or --resume/);
	});

	it("--resume 缺值报错", () => {
		assert.throws(() => parseArgs(["--resume"]), /requires an id/);
		assert.throws(() => parseArgs(["--resume", "-p"]), /requires an id/);
		assert.throws(() => parseArgs(["--resume="]), /requires an id/);
	});
});

describe("parseArgs 拒绝非法输入", () => {
	it("未知选项直接报错", () => {
		assert.throws(() => parseArgs(["--bogus"]), /unknown option --bogus/);
	});

	it("--username 与 --resume 之外的分隔也接受", () => {
		assert.equal(parseArgs(["--config=path.toml", "-p", "x"]).configPath, "path.toml");
		assert.equal(parseArgs(["--config", "path.toml", "-p", "x"]).configPath, "path.toml");
	});

	it("config 与 providers 路径", () => {
		const options = parseArgs(["--providers=providers.json", "-p", "x"]);
		assert.equal(options.providersPath, "providers.json");
	})

	it("缺路径值报错", () => {
		assert.throws(() => parseArgs(["--config"]), /--config requires a path/);
	});

	it("布尔开关", () => {
		assert.equal(parseArgs(["-y"]).assumeYes, true);
		assert.equal(parseArgs(["--trust"]).trust, true);
		assert.equal(parseArgs(["--no-trust"]).trust, false);
	});

	it("-- 之后的一切进 prompt", () => {
		const options = parseArgs(["--", "--resume", "-p"]);
		assert.equal(options.prompt, "--resume -p");
		assert.equal(options.resume, undefined);
	});

	it("空输入展示帮助", () => {
		assert.equal(parseArgs([]).command, "help");
	});
});
