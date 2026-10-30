import { pasteChipBytes, pasteChipLines, pasteMarker } from "#src/tui/copy.ts";
import type { PasteInsertion } from "#src/tui/input/keys.ts";

/**
 * 大段粘贴的折叠。
 *
 * 输入框里只放一个短标记，原文留在会话内的表里，发送时再换回去——这样光标移动、折行、
 * 删除都只面对一个几十字符的 token，粘进几千行也不会把输入框和每帧重排拖垮。
 *
 * 阈值与标签抄自 grok：四行或 10 KB 以上折叠，多行按行数、超大按体积。
 */

/** 达到这个行数就折叠；一两行的短粘贴保持原样更自然。 */
export const PASTE_CHIP_MIN_LINES = 4;
/** 单行也算：超过这个字节数（比如压缩过的单行 JSON）同样折叠。 */
export const PASTE_CHIP_MIN_BYTES = 10_000;

/** 会话内的粘贴原文；标记里只带 id。 */
export interface PasteStore {
	nextId: number;
	readonly entries: Map<number, string>;
}

export function createPasteStore(): PasteStore {
	return { nextId: 1, entries: new Map() };
}

/** 内容行数：末尾换行不算多出一行，`"a\n"` 是 1 行。 */
export function pasteLineCount(text: string): number {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.length === 0 ? 0 : body.split("\n").length;
}

/** 是否折叠：先看行数，再看体积。 */
export function shouldCollapsePaste(text: string): boolean {
	return pasteLineCount(text) >= PASTE_CHIP_MIN_LINES || Buffer.byteLength(text, "utf8") > PASTE_CHIP_MIN_BYTES;
}

/** 标记文字：体积大到一定规模时用大小代替行数，比「12000 lines」更好懂。 */
export function pasteMarkerOf(id: number, text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	const label = bytes > PASTE_CHIP_MIN_BYTES ? pasteChipBytes(bytes) : pasteChipLines(pasteLineCount(text));
	return pasteMarker(id, label);
}

/**
 * 决定这次粘贴插入什么。
 *
 * 同一段内容紧贴着一个已有标记再贴一次，表示「我要看原文」：把那一行标记换回正文。
 * 这是折叠唯一的展开手势——回车与双击在我们这里分别是提交和选中，不能被占用。
 */
export function pasteInsertion(store: PasteStore, text: string, before: string): PasteInsertion {
	for (const [id, entry] of store.entries) {
		const marker = pasteMarkerOf(id, entry);
		if (entry === text && before.endsWith(marker)) return { insert: text, removeBefore: marker.length };
	}
	if (!shouldCollapsePaste(text)) return { insert: text, removeBefore: 0 };

	const id = store.nextId;
	store.nextId += 1;
	store.entries.set(id, text);
	return { insert: pasteMarkerOf(id, text), removeBefore: 0 };
}

/**
 * 发送前把标记换回原文。
 *
 * 只认自己登记过的标记：手打出同样字样、或标记被改掉半截，都按普通文字原样发出去。
 */
export function expandPastes(store: PasteStore, text: string): string {
	let output = text;
	for (const [id, entry] of store.entries) {
		const marker = pasteMarkerOf(id, entry);
		if (output.includes(marker)) output = output.split(marker).join(entry);
	}
	return output;
}

/** 标记的通用形状，只用于上色；展开仍按登记过的精确文字匹配。 */
const MARKER_PATTERN = /\[Pasted #\d+: \d+(?:\.\d+)? (?:lines?|bytes|KB|MB)\]/g;

/** 给输入框里的标记上色；不改变宽度，光标列与折行不受影响。 */
export function highlightPasteMarkers(text: string, markerColor: string, restoreColor: string): string {
	return text.replace(MARKER_PATTERN, (marker) => `${markerColor}${marker}${restoreColor}`);
}
