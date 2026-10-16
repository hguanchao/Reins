import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NotifyMode } from "../../../src/config/config-file.ts";
import { isBuiltinCommand, runBuiltin, type BuiltinContext } from "../../../src/plugins/tui-plugin/commands.ts";
import {
	decideNotify,
	desktopNotificationsSupported,
	notificationSequence,
} from "../../../src/plugins/tui-plugin/notify.ts";
import { makeRuntime } from "./helpers.ts";

describe("完成提醒", () => {
	it("关掉时从不提醒", () => {
		for (const focused of [true, false, undefined]) {
			assert.equal(decideNotify({ mode: "off", focused, desktopSupported: true }), "none");
		}
	});

	it("人还在看着就不打扰", () => {
		assert.equal(decideNotify({ mode: "bell", focused: true, desktopSupported: true }), "none");
		// 终端不上报焦点时也按「还在看着」处理，免得每轮结束都响一声
		assert.equal(decideNotify({ mode: "bell", focused: undefined, desktopSupported: true }), "none");
	});

	it("人不在时按设置的方式提醒", () => {
		assert.equal(decideNotify({ mode: "bell", focused: false, desktopSupported: false }), "bell");
		assert.equal(decideNotify({ mode: "desktop", focused: false, desktopSupported: false }), "desktop");
	});

	it("auto 在支持桌面通知的终端上弹通知，否则响一声", () => {
		assert.equal(decideNotify({ mode: "auto", focused: false, desktopSupported: true }), "desktop");
		assert.equal(decideNotify({ mode: "auto", focused: false, desktopSupported: false }), "bell");
	});

	it("提醒就是一段控制序列", () => {
		assert.equal(notificationSequence("bell", "做完了"), "\x07");
		assert.equal(notificationSequence("desktop", "做完了"), "\x1b]9;做完了\x07");
		assert.equal(notificationSequence("none", "做完了"), "");
	});

	it("只认确定支持的终端", () => {
		assert.equal(desktopNotificationsSupported({ WT_SESSION: "x" }), true);
		assert.equal(desktopNotificationsSupported({ TERM_PROGRAM: "iTerm.app" }), true);
		assert.equal(desktopNotificationsSupported({ TERM_PROGRAM: "WezTerm" }), true);
		assert.equal(desktopNotificationsSupported({ TERM_PROGRAM: "Apple_Terminal" }), false);
		assert.equal(desktopNotificationsSupported({}), false);
	});
});



describe("自带命令", () => {
	function builtinContext(options: { readonly notify?: NotifyMode } = {}): {
		readonly context: BuiltinContext;
		readonly notifyCalls: NotifyMode[];
		readonly trustCalls: boolean[];
	} {
		const fake = makeRuntime({
			trust: { trusted: false, root: "/work", files: ["/work/.reins/config.toml"] },
		});
		const notifyCalls: NotifyMode[] = [];
		return {
			notifyCalls,
			trustCalls: fake.trustCalls,
			context: {
				runtime: fake.runtime,
				notify: () => options.notify ?? "auto",
				setNotify: (mode) => {
					notifyCalls.push(mode);
				},
			},
		};
	}

	function textOf(lines: readonly (readonly { readonly text: string }[])[] | undefined): string {
		return (lines ?? []).map((line) => line.map((span) => span.text).join("")).join("\n");
	}

	it("认识自己的命令，别的不认", () => {
		assert.equal(isBuiltinCommand("help"), true);
		assert.equal(isBuiltinCommand("notify"), true);
		assert.equal(isBuiltinCommand("mcp"), false);
	});

	it("/help 列出自带命令与插件命令", () => {
		const fake = makeRuntime({
			commands: [{ name: "demo", description: "示例命令", async run() {} }],
		});
		const result = runBuiltin("help", "", {
			runtime: fake.runtime,
			notify: () => "auto",
			setNotify: () => undefined,
		});
		const text = textOf(result?.lines);
		assert.ok(text.includes("/help"));
		assert.ok(text.includes("/exit"));
		assert.ok(text.includes("/demo"));
		assert.ok(text.includes("示例命令"));
	});

	it("/exit 要求退出", () => {
		const { context } = builtinContext();
		assert.equal(runBuiltin("exit", "", context)?.exit, true);
	});

	it("/notify 不带参数时报告当前取值", () => {
		const { context, notifyCalls } = builtinContext({ notify: "desktop" });
		const result = runBuiltin("notify", "", context);
		assert.ok(textOf(result?.lines).includes("desktop"));
		assert.deepEqual(notifyCalls, []);
	});

	it("/notify 设置取值", () => {
		const { context, notifyCalls } = builtinContext();
		const result = runBuiltin("notify", "bell", context);
		assert.deepEqual(notifyCalls, ["bell"]);
		assert.ok(textOf(result?.lines).includes("bell"));
	});

	it("/notify 取值写错时明确拒绝，不改任何东西", () => {
		const { context, notifyCalls } = builtinContext();
		const result = runBuiltin("notify", "大声点", context);
		assert.deepEqual(notifyCalls, []);
		assert.equal(result?.lines[0][0].style?.color, "red");
	});

	it("/trust 显示状态，/trust yes 改结论", () => {
		const { context, trustCalls } = builtinContext();
		const status = runBuiltin("trust", "", context);
		assert.ok(textOf(status?.lines).includes("/work/.reins/config.toml"));

		const changed = runBuiltin("trust", "yes", context);
		assert.deepEqual(trustCalls, [true]);
		assert.ok(textOf(changed?.lines).includes("下次启动生效"));
	});

	it("/trust 参数写错时只给用法，不改结论", () => {
		const { context, trustCalls } = builtinContext();
		const result = runBuiltin("trust", "也许", context);
		assert.deepEqual(trustCalls, []);
		assert.ok(textOf(result?.lines).includes("用法"));
	});

	it("已经信任的工作区显示成参与了本次运行", () => {
		const fake = makeRuntime({
			trust: { trusted: true, root: "/work", files: ["/work/.reins/config.toml"] },
		});
		const result = runBuiltin("trust", "", {
			runtime: fake.runtime,
			notify: () => "auto",
			setNotify: () => undefined,
		});
		assert.ok(textOf(result?.lines).includes("参与了本次运行"));
	});

	it("没有自带配置时直说没必要信任", () => {
		const fake = makeRuntime({ trust: { trusted: false, root: "/work", files: [] } });
		const result = runBuiltin("trust", "", {
			runtime: fake.runtime,
			notify: () => "auto",
			setNotify: () => undefined,
		});
		assert.ok(textOf(result?.lines).includes("没有需要信任"));
	});

	it("不是自带命令时返回 undefined，交给插件命令", () => {
		const { context } = builtinContext();
		assert.equal(runBuiltin("demo", "", context), undefined);
	});
});
