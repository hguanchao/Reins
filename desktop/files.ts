import { app, dialog, ipcMain, type BrowserWindow } from "electron";

/**
 * 「添加文件」直接唤起系统文件选择器。
 *
 * 起始目录固定为桌面：要添加的文件通常散落在桌面、下载这类个人目录，
 * 工作区往往只是一块空的数据目录，从那里起步反而让用户多走一层。
 */
export function registerFileIpc(context: { readonly window: BrowserWindow }): void {
	ipcMain.handle("files:pick", async (): Promise<string | undefined> => {
		const picked = await dialog.showOpenDialog(context.window, {
			title: "添加文件",
			defaultPath: app.getPath("desktop"),
			properties: ["openFile"],
			buttonLabel: "添加",
		});
		return picked.canceled ? undefined : picked.filePaths[0];
	});
}
