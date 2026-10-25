import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	detectImageMime,
	detectImagePath,
	readImageFile,
	resolveImagePath,
} from "../../src/image/source.ts";
import { MAX_IMAGE_BYTES } from "../../src/image/attachment.ts";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_HEADER = Buffer.from("GIF89a", "ascii");
const WEBP_HEADER = Buffer.concat([
	Buffer.from("RIFF", "ascii"),
	Buffer.from([0x10, 0x00, 0x00, 0x00]),
	Buffer.from("WEBP", "ascii"),
]);

function withDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "reins-image-"));
	return Promise.resolve(run(directory)).finally(() => {
		rmSync(directory, { recursive: true, force: true });
	});
}

function write(directory: string, name: string, bytes: Buffer): string {
	const path = join(directory, name);
	writeFileSync(path, bytes);
	return path;
}

describe("图片格式识别", () => {
	it("按文件头识别 PNG / JPEG / GIF / WebP", () => {
		assert.equal(detectImageMime(PNG_HEADER), "image/png");
		assert.equal(detectImageMime(JPEG_HEADER), "image/jpeg");
		assert.equal(detectImageMime(GIF_HEADER), "image/gif");
		assert.equal(detectImageMime(WEBP_HEADER), "image/webp");
	});

	it("不认识的内容与过短的头部返回 undefined", () => {
		assert.equal(detectImageMime(Buffer.from("hello world")), undefined);
		assert.equal(detectImageMime(Buffer.from([0x89])), undefined);
		assert.equal(detectImageMime(Buffer.alloc(0)), undefined);
	});
});

describe("图片文件读取", () => {
	it("读出名称、格式、大小与 base64", async () => {
		await withDirectory(async (directory) => {
			const bytes = Buffer.concat([PNG_HEADER, Buffer.from("pixels")]);
			write(directory, "shot.png", bytes);

			const image = await readImageFile(directory, "shot.png");
			assert.equal(image.name, "shot.png");
			assert.equal(image.mimeType, "image/png");
			assert.equal(image.bytes, bytes.length);
			assert.equal(image.data, bytes.toString("base64"));
		});
	});

	it("扩展名不可信：内容不是图片就拒绝", async () => {
		await withDirectory(async (directory) => {
			write(directory, "fake.png", Buffer.from("not really an image"));
			await assert.rejects(readImageFile(directory, "fake.png"), /not a PNG, JPEG, GIF, or WebP/);
		});
	});

	it("单张超过上限时拒绝，不读进内存", async () => {
		await withDirectory(async (directory) => {
			const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1);
			PNG_HEADER.copy(bytes);
			write(directory, "huge.png", bytes);
			await assert.rejects(readImageFile(directory, "huge.png"), /limit is 8 MB/);
		});
	});

	it("缺失路径与空文件都有明确原因", async () => {
		await withDirectory(async (directory) => {
			await assert.rejects(readImageFile(directory, "missing.png"), /Could not read image/);
			write(directory, "empty.png", Buffer.alloc(0));
			await assert.rejects(readImageFile(directory, "empty.png"), /is empty/);
		});
	});

	it("路径支持相对路径、引号与绝对路径", async () => {
		await withDirectory((directory) => {
			const absolute = join(directory, "shot.png");
			assert.equal(resolveImagePath(directory, "shot.png"), absolute);
			assert.equal(resolveImagePath(directory, '"shot.png"'), absolute);
			assert.equal(resolveImagePath(directory, absolute), absolute);
		});
	});
});

describe("拖入路径识别", () => {
	it("整段就是一个现有图片路径时返回绝对路径", async () => {
		await withDirectory((directory) => {
			const path = write(directory, "drag me.png", Buffer.concat([PNG_HEADER, Buffer.from("x")]));
			assert.equal(detectImagePath(directory, `"${path}"`), path);
			assert.equal(detectImagePath(directory, "drag me.png"), path);
		});
	});

	it("非图片扩展名、文本说明与多行粘贴都不当作图片", async () => {
		await withDirectory((directory) => {
			write(directory, "notes.txt", PNG_HEADER);
			assert.equal(detectImagePath(directory, "notes.txt"), undefined);
			assert.equal(detectImagePath(directory, "look at shot.png"), undefined);
			assert.equal(detectImagePath(directory, "shot.png\nmore text"), undefined);
		});
	});

	it("扩展名像图片但内容不对时不识别", async () => {
		await withDirectory((directory) => {
			write(directory, "fake.png", Buffer.from("nope"));
			assert.equal(detectImagePath(directory, "fake.png"), undefined);
		});
	});
});
