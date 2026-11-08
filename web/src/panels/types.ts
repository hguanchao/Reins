/** 侧面板里的一个页签；六类页签与设计稿一致，路径类页签按文件路径去重。 */
export type SideTab =
	| { readonly id: string; readonly kind: "files"; readonly title: string }
	| { readonly id: string; readonly kind: "git"; readonly title: string }
	| { readonly id: string; readonly kind: "skills"; readonly title: string }
	| { readonly id: string; readonly kind: "plugins"; readonly title: string }
	| { readonly id: string; readonly kind: "browser"; readonly title: string }
	| { readonly id: string; readonly kind: "terminal"; readonly title: string };

/** 新增页签菜单可选的类型。 */
export type SideTabKind = "files" | "git" | "skills" | "plugins" | "browser" | "terminal";

/** 占据整个主列的全局页面标识。 */
export type GlobalPanelId = "schedules";
