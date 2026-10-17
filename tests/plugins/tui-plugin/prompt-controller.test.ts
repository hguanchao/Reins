import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { plain, type ClipboardPort, type KeyEvent } from "../../../src/tui/index.ts";
import { PromptController } from "../../../src/plugins/tui-plugin/prompt-controller.ts";
import { PASTE_BG } from "../../../src/plugins/tui-plugin/theme.ts";
import { cleanupTempDirs, workspaceFixture } from "./frontend-harness.ts";

/**
 * 输入区控制器的单元测试。
 *
 * 一直接驱动 PromptController：粘贴分流与 chip 的展开、斜杠与文件下拉的选择/补全/收起，
 * 以及渲染后 chip 的命中测试。跨界面整体按键流转由 frontend 系列的集成测试覆盖。
 */

/** 构造下拉按键所用的 key 事件。 */
function key(name: Extract<KeyEvent, { type: "key" }>["name"]): Extract<KeyEvent, { type: "key" }> {
	return { type: "key", name };
}

function controller(): PromptController {
	return new PromptController({ commands: () => [], onChange: () => undefined });
}

/** 等条件成立（文件索引是异步建立的）；最多半秒。 */
async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	cleanupTempDirs();
});

describe("粘贴分流", () => {
	it("多行内容折成 chip；再次粘贴同一段则展开", () => {
		const prompt = controller();
		const content = "one\ntwo\nthree\nfour";

		prompt.insertPaste(content, false);
		assert.ok(prompt.displayText.includes("[Pasted: 4 lines]"), "multi-line paste becomes a chip");
		assert.ok(!prompt.displayText.includes("one"), "chip hides the body");

		prompt.insertPaste(content, false);
		assert.ok(!prompt.displayText.includes("[Pasted:"), "repaste expands the chip");
		assert.ok(prompt.displayText.includes("one") && prompt.displayText.includes("four"));
	});

	it("内联粘贴不折 chip；空剪贴板返回失败", () => {
		const prompt = controller();

		prompt.insertPaste("just a line", true);
		assert.equal(prompt.displayText, "just a line");

		prompt.editor.clear();
		const empty: ClipboardPort = { copy: () => ({ delivery: "confirmed", message: "" }), readText: () => undefined };
		assert.equal(prompt.pasteFromClipboard(empty, false), false);
		const blank: ClipboardPort = { copy: () => ({ delivery: "confirmed", message: "" }), readText: () => "   " };
		assert.equal(prompt.pasteFromClipboard(blank, false), false);
		const filled: ClipboardPort = { copy: () => ({ delivery: "confirmed", message: "" }), readText: () => "hi" };
		assert.equal(prompt.pasteFromClipboard(filled, false), true);
		assert.equal(prompt.displayText, "hi");
	});

	it("渲染后双击 chip 把它摊开", () => {
		const prompt = controller();
		prompt.insertPaste("one\ntwo\nthree\nfour", false);

		const rendered = prompt.render(60, 8, PASTE_BG, plain("❯ "));
		const chip = rendered.elements[0];
		assert.ok(chip, "chip element is rendered");

		prompt.clickEditor(chip.row, chip.col);
		assert.ok(prompt.displayText.includes("[Pasted:"), "single click only selects");
		prompt.clickEditor(chip.row, chip.col);
		assert.ok(!prompt.displayText.includes("[Pasted:"), "double click expands the chip");
		assert.ok(prompt.displayText.includes("three"));
	});
});

describe("斜杠下拉", () => {
	it("方向键移动选择，Tab 接受当前项", () => {
		const prompt = controller();
		prompt.insertText("/");
		assert.equal(prompt.menuKind(), "slash");
		assert.ok(prompt.menuRows(80, 24).length > 0, "candidates are listed");

		prompt.handleMenuKey(key("down"));
		prompt.handleMenuKey(key("tab"));
		assert.equal(prompt.editor.text, "/exit");
		assert.equal(prompt.menuKind(), undefined, "dropdown closes after completion");
	});

	it("滚轮移动选择并夹在两端", () => {
		const prompt = controller();
		prompt.insertText("/");
		prompt.menuRows(80, 24);

		prompt.scrollMenu(99);
		prompt.handleMenuKey(key("tab"));
		assert.equal(prompt.editor.text, "/trust ", "scroll clamps to the last item (带参数的命令补上空格)");

		assert.equal(prompt.menuKind(), undefined);
		prompt.scrollMenu(1); // 下拉已收起：不抛错即可
	});

	it("Enter 在命令未打全时补全，打全时放行给发送方", () => {
		const prompt = controller();

		prompt.insertText("/he");
		assert.ok(prompt.handleMenuKey(key("enter")), "partial input is consumed");
		assert.equal(prompt.editor.text, "/help", "Enter completes, not runs");

		prompt.editor.clear();
		prompt.insertText("/notify");
		assert.equal(prompt.menuKind(), "slash");
		assert.equal(prompt.handleMenuKey(key("enter")), false, "exact input passes through");
	});

	it("Esc 只收起下拉，继续输入会重新打开", () => {
		const prompt = controller();

		prompt.insertText("/he");
		assert.ok(prompt.handleMenuKey(key("escape")));
		assert.equal(prompt.menuKind(), undefined);
		assert.equal(prompt.displayText, "/he", "draft is kept");

		prompt.insertText("l");
		assert.equal(prompt.menuKind(), "slash", "typing reopens the dropdown");
	});
});

describe("文件下拉", () => {
	it("Tab 插入文件引用；右方向键钻进目录后 Tab 插入子文件", async () => {
		const prompt = controller();
		prompt.loadFileIndex(workspaceFixture());

		prompt.insertText("open @app");
		await until(() => prompt.menuKind() !== undefined);
		assert.equal(prompt.menuKind(), "file");
		assert.ok(prompt.handleMenuKey(key("tab")));
		assert.equal(prompt.displayText, "open @src/app.ts ", "Tab inserts a file ref");
		assert.equal(prompt.menuKind(), undefined, "dropdown closes after insert");

		prompt.editor.clear();
		prompt.insertText("@sr");
		await until(() => prompt.menuKind() === "file");
		assert.ok(prompt.handleMenuKey(key("right")), "Right drills into the folder");
		assert.equal(prompt.displayText, "@src/", "query becomes the directory token");
		assert.equal(prompt.menuKind(), "file", "dropdown stays open inside the directory");

		prompt.handleMenuKey(key("tab"));
		assert.match(prompt.displayText, /app\.ts/, "child file is inserted");
	});
});
