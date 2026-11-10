/**
 * 桌面壳与页面之间的输入契约。
 *
 * IPC 参数来自页面，一律先当作 unknown 收窄再使用；校验规则只在这里实现一份，
 * handler 不再各自手写 typeof 判断，避免同一条边界出现多套宽严不一的实现。
 */

export type ResolvedTheme = "zai-dark" | "zai-light";

export interface PluginResult {
	readonly ok: boolean;
	readonly name?: string;
	readonly error?: string;
}

/** 新建工作空间的结果：失败原因要给到弹窗，不能只回一个布尔值让界面猜。 */
export interface WorkspaceCreationResult {
	readonly ok: boolean;
	readonly error?: string;
}

export interface NotificationPayload {
	readonly title: string;
	readonly body: string;
}

export interface SessionTarget {
	/** 未登记的工作区路径；undefined 表示按会话自身的 cwd 定位。 */
	readonly workspacePath: string | undefined;
	readonly cwd: string;
	readonly id: string;
}

export interface PluginToggle {
	readonly name: string;
	readonly disabled: boolean;
}

const NOTIFICATION_TITLE_MAX = 80;
const NOTIFICATION_BODY_MAX = 200;
const TEXT_MAX = 256;
/** 文件系统路径比显示名长得多，单独给一档上限 */
const FILE_PICK_PATH_MAX = 4096;
const PLUGIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 与显示名上限一致；超长直接拒绝，不截断，免得建出一个和输入不同的目录。 */
const WORKSPACE_NAME_MAX = 60;
/** 名称要当目录名用：路径分隔符、控制字符与 Windows 保留的非法字符一律挡住。 */
const WORKSPACE_NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/;

/** 收成去空白后的非空字符串，并统一截断长度；空串与纯空白视为无效。 */
export function nonEmptyString(value: unknown, maxLength: number = TEXT_MAX): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed.slice(0, maxLength);
}

/**
 * 新建工作空间的名称：中文可用，但会落到文件系统上当目录名，所以越界字符必须在
 * IPC 入口就收窄；首尾空格先规范化，结尾的点在 Windows 上会被系统悄悄抹掉，单独拒绝。
 */
export function parseWorkspaceName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	if (name.length === 0 || name.length > WORKSPACE_NAME_MAX) return undefined;
	if (WORKSPACE_NAME_FORBIDDEN.test(name)) return undefined;
	if (name === "." || name === ".." || name.endsWith(".")) return undefined;
	return name;
}

export function parseTheme(value: unknown): ResolvedTheme | undefined {
	return value === "zai-dark" || value === "zai-light" ? value : undefined;
}

export function parseNotification(value: unknown): NotificationPayload | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as { readonly title?: unknown; readonly body?: unknown };
	const title = nonEmptyString(record.title, NOTIFICATION_TITLE_MAX);
	const body = nonEmptyString(record.body, NOTIFICATION_BODY_MAX);
	return title === undefined || body === undefined ? undefined : { title, body };
}

export function parseSessionTarget(
	path: unknown,
	cwd: unknown,
	id: unknown,
): SessionTarget | undefined {
	const workingDirectory = nonEmptyString(cwd);
	const sessionId = nonEmptyString(id);
	if (workingDirectory === undefined || sessionId === undefined) return undefined;
	const workspacePath = typeof path === "string" && path.length > 0 ? path : undefined;
	return { workspacePath, cwd: workingDirectory, id: sessionId };
}

export function parsePluginToggle(name: unknown, disabled: unknown): PluginToggle | undefined {
	const parsed = nonEmptyString(name);
	return parsed === undefined || typeof disabled !== "boolean" ? undefined : { name: parsed, disabled };
}

/** 代码型插件用单文件承载，名字必须能安全拼进路径，不接受分隔符与点号开头。 */
export function isSafePluginFileName(name: string): boolean {
	return PLUGIN_FILE_NAME.test(name);
}

/** 异常统一转成界面可显示的结果；不把堆栈泄到渲染层。 */
export function pluginFailure(error: unknown): PluginResult {
	return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/**
 * 文件选择对话框的起始目录：页面传来的项目根必须真实存在，否则退回桌面。
 * 路径不能像显示名那样截断，截短后会指向另一个目录，宁可直接退回桌面。
 * 目录判定由调用方注入，契约层不碰文件系统，便于独立验证这几种分支。
 */
export function resolveFilePickStart(
	requested: unknown,
	desktop: string,
	isDirectory: (value: string) => boolean,
): string {
	if (typeof requested !== "string") return desktop;
	const root = requested.trim();
	if (root.length === 0 || root.length > FILE_PICK_PATH_MAX) return desktop;
	return isDirectory(root) ? root : desktop;
}
