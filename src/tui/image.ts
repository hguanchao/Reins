import { extname } from "node:path";

import type { LlmImageBlock } from "#src/llm/messages.ts";
import { formatBytes } from "#src/shared/format.ts";
import { imageTooLarge, imagesTooLarge, tooManyImages } from "#src/tui/copy.ts";

/**
 * 输入框里的图片附件。
 *
 * 图片以 `[image: 文件名]` 标记的形式待在正文里，和文字一起编辑、一起发送；真正的二进制
 * 数据留在内存里随消息发出，不另建附件目录。标记被删掉，那张图就不会进入这一轮。
 */

export interface ImageAttachment {
	/** 文件名，既用于标记也用于历史显示 */
	readonly name: string;
	readonly mimeType: string;
	/** 不带 data URL 前缀的 base64 */
	readonly data: string;
	readonly bytes: number;
}

/** 一条已经读进来、等待发送的图片及其正文标记。 */
export interface PendingImage {
	readonly token: string;
	readonly image: ImageAttachment;
}

/** 界面需要的图片读取入口；由装配处提供，界面不直接碰文件系统与剪贴板命令。 */
export interface ImageSource {
	/** 读取指定路径；失败时抛错 */
	readonly read: (path: string) => Promise<ImageAttachment>;
	/** 整段文本像一个图片路径且文件存在时返回绝对路径 */
	readonly detect: (text: string) => string | undefined;
	/** 读取系统剪贴板里的图片；失败时抛错 */
	readonly clipboard: () => Promise<ImageAttachment>;
	/** 读取系统剪贴板里的文本；剪贴板里没有文本时返回空串，读不了时抛错 */
	readonly clipboardText: () => Promise<string>;
}

/** 一次最多附几张图。 */
export const MAX_IMAGE_COUNT = 4;
/** 单张上限；与常见视觉模型的请求体限制保持同一量级。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 一次发送的图片总量上限。 */
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** 扩展名是否属于支持的图片格式；内容是否真是图片由读取器再核对文件头。 */
export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** 新附件与已有附件一起是否超限；超限时返回给使用者看的原因。 */
export function imageLimitError(
	existing: readonly ImageAttachment[],
	next: ImageAttachment,
): string | undefined {
	return attachmentSetError([...existing, next]);
}

/** 一组附件是否超限；合并两批附件时也要走这里，不能只检查新增的那张。 */
export function attachmentSetError(images: readonly ImageAttachment[]): string | undefined {
	if (images.length > MAX_IMAGE_COUNT) {
		return tooManyImages(MAX_IMAGE_COUNT);
	}
	const oversized = images.find((image) => image.bytes > MAX_IMAGE_BYTES);
	if (oversized !== undefined) {
		return imageTooLarge(oversized.name, formatBytes(oversized.bytes), formatBytes(MAX_IMAGE_BYTES));
	}
	const total = images.reduce((sum, image) => sum + image.bytes, 0);
	if (total > MAX_TOTAL_IMAGE_BYTES) {
		return imagesTooLarge(formatBytes(total), formatBytes(MAX_TOTAL_IMAGE_BYTES));
	}
	return undefined;
}

/** 发给模型时的块；name 只用于界面与历史显示。 */
export function imageBlock(image: ImageAttachment): LlmImageBlock {
	return {
		type: "image",
		data: image.data,
		mimeType: image.mimeType,
		name: image.name,
	};
}

/** 正文里的图片标记。 */
export function imageMarker(name?: string): string {
	return `[image: ${sanitizeName(name ?? "image")}]`;
}

const IMAGE_MARKER_PATTERN = /\[image:[^\]\r\n]*\]/g;

/**
 * 给正文里的图片标记换色。
 *
 * 标记结束后恢复到调用方指定的前景色，而不是直接 RESET：用户消息块有背景色，RESET 会把
 * 后半行和补齐空格打回终端底色。
 */
export function highlightImageMarkers(
	text: string,
	markerColor: string,
	restoreColor: string,
): string {
	return text.replace(IMAGE_MARKER_PATTERN, (marker) => `${markerColor}${marker}${restoreColor}`);
}

/** 同名图片加序号，保证正文里的标记能唯一对应一张图。 */
export function uniqueImageName(name: string, used: ReadonlySet<string>): string {
	const base = sanitizeName(name);
	if (!used.has(base)) return base;

	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const extension = dot > 0 ? base.slice(dot) : "";
	for (let index = 2; ; index += 1) {
		const candidate = `${stem}-${index}${extension}`;
		if (!used.has(candidate)) return candidate;
	}
}

/**
 * 按正文里还存在的标记挑出这一轮要发送的图片。
 *
 * 标记被删掉就表示使用者不要这张图；顺序按标记在正文里第一次出现的位置，重复标记只送一次。
 */
export function imagesInPrompt(
	text: string,
	pending: readonly PendingImage[],
): readonly ImageAttachment[] {
	const found = pending
		.map((item) => ({ item, index: text.indexOf(item.token) }))
		.filter((entry) => entry.index >= 0)
		.sort((left, right) => left.index - right.index);
	const seen = new Set<string>();
	const images: ImageAttachment[] = [];
	for (const { item } of found) {
		if (seen.has(item.token)) continue;
		seen.add(item.token);
		images.push(item.image);
	}
	return images;
}

export { formatBytes };

/** 文件名可能来自剪贴板或别的系统；控制字符会把标记撑乱。 */
function sanitizeName(name: string): string {
	const clean = name.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return clean.length === 0 ? "image" : clean;
}
