import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	isSafePluginFileName,
	nonEmptyString,
	parseNotification,
	parsePluginToggle,
	parseSessionTarget,
	parseTheme,
	parseWorkspaceName,
	pluginFailure,
	resolveFilePickStart,
} from "#desktop/contracts.ts";

describe("IPC 输入契约", () => {
	it("主题只接受两套实际配色", () => {
		assert.equal(parseTheme("zai-dark"), "zai-dark");
		assert.equal(parseTheme("zai-light"), "zai-light");
		assert.equal(parseTheme("system"), undefined);
		assert.equal(parseTheme(1), undefined);
		assert.equal(parseTheme(undefined), undefined);
	});

	it("文本收窄去空白、拒空串并统一截断", () => {
		assert.equal(nonEmptyString("  路径  ", 20), "路径");
		assert.equal(nonEmptyString("   ", 20), undefined);
		assert.equal(nonEmptyString(42, 20), undefined);
		assert.equal(nonEmptyString("abcdef", 3), "abc");
	});

	it("通知必须标题与正文齐备，长度各自受限", () => {
		assert.deepEqual(parseNotification({ title: " 完成 ", body: " 已提交 " }), {
			title: "完成",
			body: "已提交",
		});
		assert.equal(parseNotification({ title: "完成" }), undefined);
		assert.equal(parseNotification({ title: " ", body: "已提交" }), undefined);
		assert.equal(parseNotification(null), undefined);
		assert.equal(parseNotification("文本"), undefined);
		assert.equal(parseNotification({ title: "x".repeat(200), body: "b" })?.title.length, 80);
	});

	it("会话目标允许工作区路径缺省，但 cwd 与 id 必填", () => {
		assert.deepEqual(parseSessionTarget(null, "/repo", "s-1"), {
			workspacePath: undefined,
			cwd: "/repo",
			id: "s-1",
		});
		assert.deepEqual(parseSessionTarget("/repo", "/repo", "s-1"), {
			workspacePath: "/repo",
			cwd: "/repo",
			id: "s-1",
		});
		assert.equal(parseSessionTarget(null, "", "s-1"), undefined);
		assert.equal(parseSessionTarget(null, "/repo", "  "), undefined);
	});

	it("插件启停要求名字与布尔态同时有效", () => {
		assert.deepEqual(parsePluginToggle(" demo ", false), { name: "demo", disabled: false });
		assert.equal(parsePluginToggle("", true), undefined);
		assert.equal(parsePluginToggle("demo", "true"), undefined);
	});

	it("代码型插件文件名不接受路径分隔符与点号开头", () => {
		assert.equal(isSafePluginFileName("demo-plugin.v1"), true);
		assert.equal(isSafePluginFileName("../escape"), false);
		assert.equal(isSafePluginFileName(".hidden"), false);
		assert.equal(isSafePluginFileName("a/b"), false);
	});

	it("新建工作空间名称可含中文，但不得越出目录名的边界", () => {
		assert.equal(parseWorkspaceName("  我的项目  "), "我的项目");
		assert.equal(parseWorkspaceName("项目 "), "项目");
		assert.equal(parseWorkspaceName("demo v2"), "demo v2");
		for (const bad of [
			"", "   ", 42, undefined, ".", "..", "项目.",
			"a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\u0001b",
			"x".repeat(61),
		]) {
			assert.equal(parseWorkspaceName(bad), undefined, String(bad));
		}
	});

	it("异常转成界面可显示的结果，不泄露堆栈", () => {
		assert.deepEqual(pluginFailure(new Error("写盘失败")), { ok: false, error: "写盘失败" });
		assert.deepEqual(pluginFailure("字符串错误"), { ok: false, error: "字符串错误" });
	});
});

describe("文件选择起始目录", () => {
	const desktop = "C:/Users/Chao/Desktop";
	const existing = (root: string): boolean => root === "E:/work/reins";

	it("有项目且目录仍在时从项目根开始", () => {
		assert.equal(resolveFilePickStart("E:/work/reins", desktop, existing), "E:/work/reins");
	});

	it("没有项目时从桌面开始", () => {
		assert.equal(resolveFilePickStart("", desktop, existing), desktop);
		assert.equal(resolveFilePickStart(undefined, desktop, existing), desktop);
	});

	it("项目根已失效或非字符串时退回桌面", () => {
		assert.equal(resolveFilePickStart("E:/gone", desktop, existing), desktop);
		assert.equal(resolveFilePickStart(42, desktop, existing), desktop);
	});

	it("超长路径直接拒绝，避免把畸形值交给对话框", () => {
		assert.equal(resolveFilePickStart("E:/" + "x".repeat(5000), desktop, () => true), desktop);
	});
});
