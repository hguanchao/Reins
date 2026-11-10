import { app, dialog, ipcMain, type BrowserWindow } from "electron";

import { resolveFilePickStart } from "#desktop/contracts.ts";
import { isDirectory } from "#desktop/startup-workspace.ts";

/**
 * 「添加文件」直接唤起系统文件选择器。
 *
 * 起始目录优先用页面传来的当前项目根；未绑定项目或目录已失效时退回桌面，
 * 免得把用户丢进一个不存在的位置。页面给的路径只作为对话框起点，不参与文件读写。
 */
export function registerFileIpc(context: { readonly window: BrowserWindow }): void {
	ipcMain.handle("files:pick", async (_event, defaultPath: unknown): Promise<string | undefined> => {
		const start = resolveFilePickStart(defaultPath, app.getPath("desktop"), isDirectory);
		const picked = await dialog.showOpenDialog(context.window, {
			title: "添加文件",
			defaultPath: start,
			properties: ["openFile"],
			buttonLabel: "添加",
		});
		return picked.canceled ? undefined : picked.filePaths[0];
	});
}
