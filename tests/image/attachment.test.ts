import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_COUNT,
	attachmentSetError,
	formatBytes,
	highlightImageMarkers,
	imageBlock,
	imageLimitError,
	imageMarker,
	imagesInPrompt,
	isImagePath,
	uniqueImageName,
	type ImageAttachment,
} from "../../src/image/attachment.ts";

function image(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
	return {
		name: "screenshot.png",
		mimeType: "image/png",
		data: "aGVsbG8=",
		bytes: 842 * 1024,
		...overrides,
	};
}

describe("图片附件", () => {
	it("大小按 B / KB / MB 显示", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(842 * 1024), "842 KB");
		assert.equal(formatBytes(2.5 * 1024 * 1024), "2.5 MB");
	});

	it("数量、单张与总量上限都会拒绝", () => {
		const full = Array.from({ length: MAX_IMAGE_COUNT }, (_, index) =>
			image({ name: `a${index}.png`, bytes: 1024 }),
		);
		assert.match(imageLimitError(full, image()) ?? "", /At most 4 images/);
		assert.match(imageLimitError([], image({ bytes: MAX_IMAGE_BYTES + 1 })) ?? "", /limit is 8 MB/);
		assert.match(
			imageLimitError(
				Array.from({ length: 3 }, (_, index) => image({ name: `b${index}.png`, bytes: 7 * 1024 * 1024 })),
				image({ bytes: 1 }),
			) ?? "",
			/total 21 MB/,
		);
		assert.equal(attachmentSetError([image()]), undefined);
	});

	it("发给模型的块保留文件名", () => {
		assert.deepEqual(imageBlock(image()), {
			type: "image",
			data: "aGVsbG8=",
			mimeType: "image/png",
			name: "screenshot.png",
		});
	});

	it("正文标记使用文件名，控制字符被清理", () => {
		assert.equal(imageMarker("screenshot.png"), "[image: screenshot.png]");
		assert.equal(imageMarker(), "[image: image]");
		assert.equal(imageMarker("a\nb.png"), "[image: a b.png]");
	});

	it("高亮只包住标记，结束后恢复调用方的前景色", () => {
		assert.equal(
			highlightImageMarkers("看 [image: a.png] 这里", "<blue>", "<text>"),
			"看 <blue>[image: a.png]<text> 这里",
		);
		assert.equal(highlightImageMarkers("没有标记", "<blue>", "<text>"), "没有标记");
	});

	it("同名图片加序号，避免标记对不上数据", () => {
		assert.equal(uniqueImageName("a.png", new Set()), "a.png");
		assert.equal(uniqueImageName("a.png", new Set(["a.png"])), "a-2.png");
		assert.equal(uniqueImageName("a.png", new Set(["a.png", "a-2.png"])), "a-3.png");
		assert.equal(uniqueImageName("noext", new Set(["noext"])), "noext-2");
	});

	it("按正文中仍存在的标记挑图，删除标记即取消", () => {
		const one = image({ name: "one.png" });
		const two = image({ name: "two.png" });
		const pending = [
			{ token: imageMarker("one.png"), image: one },
			{ token: imageMarker("two.png"), image: two },
		];

		assert.deepEqual(imagesInPrompt("look [image: one.png] here", pending), [one]);
		// 顺序按正文出现位置，不按附件加入顺序；重复标记只送一次
		assert.deepEqual(
			imagesInPrompt("[image: two.png] then [image: one.png] and [image: two.png]", pending),
			[two, one],
		);
		assert.deepEqual(imagesInPrompt("no markers", pending), []);
	});

	it("图片扩展名判断不区分大小写", () => {
		assert.equal(isImagePath("a.PNG"), true);
		assert.equal(isImagePath("dir/b.webp"), true);
		assert.equal(isImagePath("notes.txt"), false);
	});
});
