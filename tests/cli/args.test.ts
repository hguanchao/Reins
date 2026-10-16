import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs, UsageError, HELP_TEXT } from "../../src/cli/args.ts";

describe("parseArgs 命令", () => {
	it("没有参数时进入交互模式", () => {
		assert.equal(parseArgs([]).command, "chat");
	});

	it("给了句子就是非交互模式", () => {
		assert.equal(parseArgs(["做事"]).command, "print");
		assert.equal(parseArgs(["-p", "做事"]).command, "print");
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
		assert.ok(HELP_TEXT.includes("reins                     进入交互界面"));
	});
});

describe("parseArgs 路径覆盖", () => {
	it("接受 --config 与 --providers 的两种写法", () => {
		assert.equal(parseArgs(["--config", "/a.toml"]).configPath, "/a.toml");
		assert.equal(parseArgs(["--config=/a.toml"]).configPath, "/a.toml");
		assert.equal(parseArgs(["--providers", "/b.json"]).providersPath, "/b.json");
		assert.equal(parseArgs(["--providers=/b.json"]).providersPath, "/b.json");
	});

	it("可以与子命令同时使用", () => {
		const options = parseArgs(["config", "check", "--config", "/a.toml", "--providers=/b.json"]);
		assert.equal(options.command, "config-check");
		assert.equal(options.configPath, "/a.toml");
		assert.equal(options.providersPath, "/b.json");
	});

	it("缺少路径时按用法错误处理", () => {
		assert.throws(() => parseArgs(["--config"]), UsageError);
		assert.throws(() => parseArgs(["--config", "--providers"]), UsageError);
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

describe("parseArgs 的会话选项", () => {
	it("认出 --continue 与 --resume", () => {
		assert.equal(parseArgs(["-c"]).continueSession, true);
		assert.equal(parseArgs(["--continue"]).continueSession, true);
		assert.equal(parseArgs(["--resume", "abc123"]).resume, "abc123");
		assert.equal(parseArgs(["--resume=abc123"]).resume, "abc123");
		// 非交互模式也能接续：这是脚本里最常用的一种
		const print = parseArgs(["--resume", "abc123", "-p", "接着说"]);
		assert.equal(print.command, "print");
		assert.equal(print.resume, "abc123");
	});

	it("认出 --fork 与 --at", () => {
		const options = parseArgs(["--resume", "abc123", "--fork", "--at", "e1"]);
		assert.equal(options.fork, true);
		assert.equal(options.forkAt, "e1");
	});

	it("组合不完整时报用法错误", () => {
		// 单独一个 --fork 说明不了从哪儿分叉
		assert.throws(() => parseArgs(["--fork"]), /要配 --resume/);
		assert.throws(() => parseArgs(["--at", "e1"]), /只和 --fork 一起用/);
		assert.throws(() => parseArgs(["-c", "--resume", "abc123"]), /只能用其中一个/);
		assert.throws(() => parseArgs(["--resume"]), /需要一个标识/);
	});

	it("识别 sessions 子命令", () => {
		const list = parseArgs(["sessions", "list"]);
		assert.equal(list.command, "sessions");
		assert.equal(list.sessionsAction, "list");
		assert.equal(list.sessionRef, undefined);

		const show = parseArgs(["sessions", "show", "abc123"]);
		assert.equal(show.sessionsAction, "show");
		assert.equal(show.sessionRef, "abc123");

		const exported = parseArgs(["sessions", "export", "abc123"]);
		assert.equal(exported.sessionsAction, "export");
		assert.equal(exported.sessionRef, "abc123");

		assert.throws(() => parseArgs(["sessions"]), /支持 list、show、export/);
		assert.throws(() => parseArgs(["sessions", "rm", "abc"]), /支持 list、show、export/);
		assert.throws(() => parseArgs(["sessions", "show"]), /需要一个会话标识/);
		assert.throws(() => parseArgs(["sessions", "export"]), /需要一个会话标识/);
		assert.throws(() => parseArgs(["sessions", "list", "多余"]), /不接受额外参数/);
		assert.throws(() => parseArgs(["sessions", "export", "abc", "多余"]), /不接受额外参数/);
	});

	it("帮助文本写明了会话相关的用法", () => {
		assert.ok(HELP_TEXT.includes("reins sessions list"));
		assert.ok(HELP_TEXT.includes("--continue"));
		assert.ok(HELP_TEXT.includes("--fork"));
	});
});
