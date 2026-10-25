import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
	MAX_IMAGE_BYTES,
	formatBytes,
	isImagePath,
	type ImageAttachment,
	type ImageSource,
} from "../tui/image-attachments.ts";

/**
 * 读取图片附件。
 *
 * 格式按文件头判断而不是扩展名：扩展名可以随便改，真正决定请求体合法性的是内容。自动识别
 * 拖入路径时仍先看扩展名，避免把任意粘贴进来的文本都拿去读文件。
 *
 * 剪贴板没有跨平台的统一接口，只能按系统调用现成的命令。读不到就明确报错，不拿空图或
 * 截图占位符冒充成功。
 */

const CLIPBOARD_TIMEOUT_MS = 15_000;
const MAX_CLIPBOARD_BUFFER = 32 * 1024 * 1024;

export function createImageSource(workRoot: string): ImageSource {
	return {
		read: (path) => readImageFile(workRoot, path),
		detect: (text) => detectImagePath(workRoot, text),
		clipboard: readClipboardImage,
	};
}

/** 读一个本地图片文件；路径相对于工作区解析。 */
export async function readImageFile(workRoot: string, input: string): Promise<ImageAttachment> {
	const path = resolveImagePath(workRoot, input);
	let size: number;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) throw new Error(`${path} is not a file`);
		size = stat.size;
	} catch (error) {
		if (error instanceof Error && error.message === `${path} is not a file`) throw error;
		throw new Error(`Could not read image ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (size === 0) throw new Error(`Image ${path} is empty`);
	if (size > MAX_IMAGE_BYTES) {
		throw new Error(`Image ${path} is ${formatBytes(size)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}`);
	}

	const bytes = await readFile(path);
	if (bytes.length === 0) throw new Error(`Image ${path} is empty`);
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new Error(`Image ${path} is ${formatBytes(bytes.length)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}`);
	}
	const mimeType = detectImageMime(bytes);
	if (mimeType === undefined) {
		throw new Error(`${path} is not a PNG, JPEG, GIF, or WebP image`);
	}
	return {
		name: basename(path),
		mimeType,
		data: bytes.toString("base64"),
		bytes: bytes.length,
	};
}

/**
 * 自动识别拖入终端的路径。
 *
 * 只有「整段文本就是一个带图片扩展名的现有文件」才算；多个路径、夹着说明文字或读完不是
 * 图片格式时都返回 undefined，交回普通输入处理。
 */
export function detectImagePath(workRoot: string, text: string): string | undefined {
	const candidate = stripQuotes(text);
	if (candidate.length === 0 || candidate.includes("\n")) return undefined;
	if (!isImagePath(candidate)) return undefined;
	const path = resolveImagePath(workRoot, candidate);
	try {
		if (!statSync(path).isFile()) return undefined;
		return detectImageMime(readHeader(path)) === undefined ? undefined : path;
	} catch {
		return undefined;
	}
}

/** 只读文件头，避免为了识别格式把一个大文件整个读进来。 */
function readHeader(path: string): Buffer {
	const buffer = Buffer.alloc(16);
	const handle = openSync(path, "r");
	try {
		const read = readSync(handle, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(handle);
	}
}

/** 按文件头判断格式；不认识的返回 undefined。 */
export function detectImageMime(bytes: Uint8Array): string | undefined {
	if (bytes.length >= 8 && matches(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (bytes.length >= 3 && matches(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (bytes.length >= 6) {
		const head = String.fromCharCode(...bytes.subarray(0, 6));
		if (head === "GIF87a" || head === "GIF89a") return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

/** 把使用者输入的路径解析成绝对路径；支持 `~` 与成对引号。 */
export function resolveImagePath(workRoot: string, input: string): string {
	const raw = stripQuotes(input.trim());
	if (raw === "~") return homedir();
	if (raw.startsWith("~/") || raw.startsWith("~\\")) {
		return resolve(homedir(), raw.slice(2));
	}
	return isAbsolute(raw) ? raw : resolve(workRoot, raw);
}

/** 读系统剪贴板里的图片。 */
export async function readClipboardImage(): Promise<ImageAttachment> {
	if (process.platform === "win32") return readWindowsClipboard();
	if (process.platform === "darwin") return readDarwinClipboard();
	return readLinuxClipboard();
}

function readWindowsClipboard(): ImageAttachment {
	const file = join(tmpdir(), `reins-clipboard-${randomBytes(6).toString("hex")}.png`);
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"$image = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($null -eq $image) { exit 2 }",
		`$image.Save('${escapePowerShell(file)}', [System.Drawing.Imaging.ImageFormat]::Png)`,
	].join("; ");
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
		{ timeout: CLIPBOARD_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
	);
	try {
		if (result.error !== undefined) {
			throw new Error(`Could not run PowerShell to read the clipboard: ${result.error.message}`);
		}
		if (result.status !== 0 || !existsSync(file)) {
			throw new Error("Clipboard does not contain an image");
		}
		const bytes = readFileSync(file);
		return clipboardAttachment(bytes);
	} finally {
		rmSync(file, { force: true });
	}
}

function readDarwinClipboard(): ImageAttachment {
	const result = spawnSync("pngpaste", ["-"], {
		timeout: CLIPBOARD_TIMEOUT_MS,
		maxBuffer: MAX_CLIPBOARD_BUFFER,
	});
	if (result.error !== undefined) {
		throw new Error("Reading clipboard images on macOS needs pngpaste on PATH");
	}
	if (result.status !== 0 || result.stdout.length === 0) {
		throw new Error("Clipboard does not contain an image");
	}
	return clipboardAttachment(result.stdout);
}

function readLinuxClipboard(): ImageAttachment {
	const attempts: readonly (readonly [string, readonly string[]])[] = [
		["wl-paste", ["--no-newline", "--type", "image/png"]],
		["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
	];
	let foundCommand = false;
	for (const [command, args] of attempts) {
		const result = spawnSync(command, args, {
			timeout: CLIPBOARD_TIMEOUT_MS,
			maxBuffer: MAX_CLIPBOARD_BUFFER,
		});
		if (result.error !== undefined) continue;
		foundCommand = true;
		if (result.status === 0 && result.stdout.length > 0) {
			return clipboardAttachment(result.stdout);
		}
	}
	throw new Error(
		foundCommand
			? "Clipboard does not contain an image"
			: "Reading clipboard images on Linux needs wl-paste or xclip on PATH",
	);
}

function clipboardAttachment(bytes: Buffer): ImageAttachment {
	if (bytes.length === 0) throw new Error("Clipboard image is empty");
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new Error(`Clipboard image is ${formatBytes(bytes.length)}; the limit is ${formatBytes(MAX_IMAGE_BYTES)}`);
	}
	const mimeType = detectImageMime(bytes);
	if (mimeType === undefined) throw new Error("Clipboard data is not a PNG, JPEG, GIF, or WebP image");
	return {
		name: `clipboard.${extensionOf(mimeType)}`,
		mimeType,
		data: bytes.toString("base64"),
		bytes: bytes.length,
	};
}

function extensionOf(mimeType: string): string {
	if (mimeType === "image/jpeg") return "jpg";
	return mimeType.slice("image/".length);
}

function stripQuotes(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1).trim();
		}
	}
	return trimmed;
}

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
	if (bytes.length < offset + expected.length) return false;
	return expected.every((value, index) => bytes[offset + index] === value);
}

function escapePowerShell(path: string): string {
	return path.replaceAll("'", "''");
}
