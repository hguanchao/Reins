import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * 工作根。
 *
 * 取进程启动时的当前目录：工具收到的相对路径都按它解析，配置目录与会话记录也以它为准。
 * 工作根只决定「相对路径从哪里算起」，不决定「能访问到哪里」——后者是沙箱的职责。
 */
export function resolveWorkRoot(cwd: string = process.cwd()): string {
	return resolve(cwd);
}

/** 展开开头的 ~，其余原样返回。 */
export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(homedir(), input.slice(2));
	return input;
}

/**
 * 把工具传来的路径解析成绝对路径。
 *
 * 相对路径按工作根解析，`..` 与符号链接不在这里处理：前者由 resolve 归一化，后者需要真正
 * 触碰文件系统，留到实际读写时由操作系统判定。
 */
export function toAbsolutePath(input: string, root: string): string {
	const expanded = expandHome(input);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
}
