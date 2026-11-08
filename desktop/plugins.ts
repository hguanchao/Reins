import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { dialog, ipcMain, type BrowserWindow } from "electron";

import { configFilePath, pluginsDir } from "#src/config/paths.ts";
import { updateUserConfigValue } from "#src/config/write-back.ts";
import { scanDeclarativePlugins } from "#src/plugins/declarative.ts";
import { withPluginDisabled } from "#src/plugins/disabled.ts";
import {
	isSafePluginFileName,
	nonEmptyString,
	parsePluginToggle,
	pluginFailure,
	type PluginResult,
} from "#desktop/contracts.ts";
/**
 * 本地插件的安装、启停与卸载。
 *
 * 写盘之后统一走控制器的延后重启，让插件宿主重新装载；这里不自己拉服务进程，
 * 也不自己决定何时重载页面。安装失败必须把已经复制进去的目录清掉，不留半成品。
 */

export interface PluginIpcContext {
	readonly window: BrowserWindow;
	readonly restartSoon: (failureTitle: string) => void;
}

function findPlugin(root: string) {
	return scanDeclarativePlugins(root).plugins;
}

function setPluginDisabled(name: string, disabled: boolean): void {
	updateUserConfigValue(
		["plugins", "disabled"],
		(current) => {
			const list = Array.isArray(current)
				? current.filter((item): item is string => typeof item === "string")
				: [];
			return [...withPluginDisabled(list, name, disabled)];
		},
		configFilePath(),
	);
}

/** 复制时排除依赖与版本库，只带插件自身的清单与源码。 */
function copyPlugin(source: string, target: string): void {
	cpSync(source, target, {
		recursive: true,
		filter: (path) => {
			const name = basename(path);
			return name !== "node_modules" && name !== ".git";
		},
	});
}

export function registerPluginIpc(context: PluginIpcContext): void {
	const { window, restartSoon } = context;

	ipcMain.handle("plugins:install", async (): Promise<PluginResult> => {
		const picked = await dialog.showOpenDialog(window, {
			title: "安装本地插件",
			properties: ["openDirectory"],
			buttonLabel: "安装",
		});
		const source = picked.filePaths[0];
		if (picked.canceled || source === undefined) return { ok: false, error: "已取消" };
		const entry = basename(source);
		if (entry.length === 0) return { ok: false, error: "请选择插件目录" };

		const root = pluginsDir();
		const target = join(root, entry);
		if (existsSync(target)) return { ok: false, error: "同名插件目录已存在" };
		try {
			mkdirSync(root, { recursive: true });
			copyPlugin(source, target);
			const plugin = findPlugin(root).find((item) => item.root === target);
			if (plugin === undefined) {
				rmSync(target, { recursive: true, force: true });
				return { ok: false, error: "这个目录不是有效的声明式插件（缺少 plugin.json 等清单）" };
			}
			restartSoon("安装插件后重启失败");
			return { ok: true, name: plugin.name };
		} catch (error) {
			rmSync(target, { recursive: true, force: true });
			return pluginFailure(error);
		}
	});

	ipcMain.handle("plugins:toggle", (_event, name: unknown, disabled: unknown): PluginResult => {
		const toggle = parsePluginToggle(name, disabled);
		if (toggle === undefined) return { ok: false, error: "参数无效" };
		if (!findPlugin(pluginsDir()).some((plugin) => plugin.name === toggle.name)) {
			return { ok: false, error: "插件不存在" };
		}
		try {
			setPluginDisabled(toggle.name, toggle.disabled);
			restartSoon("更新插件状态后重启失败");
			return { ok: true };
		} catch (error) {
			return pluginFailure(error);
		}
	});

	ipcMain.handle("plugins:uninstall", (_event, name: unknown): PluginResult => {
		const pluginName = nonEmptyString(name);
		if (pluginName === undefined) return { ok: false, error: "参数无效" };
		const root = pluginsDir();
		const plugin = findPlugin(root).find((item) => item.name === pluginName);
		const codeFile = join(root, `${pluginName}.ts`);
		const hasCodeFile = isSafePluginFileName(pluginName) && existsSync(codeFile);
		if (plugin === undefined && !hasCodeFile) return { ok: false, error: "插件不存在" };
		try {
			if (plugin !== undefined) rmSync(plugin.root, { recursive: true, force: true });
			else rmSync(codeFile, { force: true });
			setPluginDisabled(pluginName, false);
			restartSoon("卸载插件后重启失败");
			return { ok: true };
		} catch (error) {
			return pluginFailure(error);
		}
	});
}
