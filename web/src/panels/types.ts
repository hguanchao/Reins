/** 侧面板里的一个页签；路径类页签按文件路径去重。 */
export type SideTab =
	| { readonly id: string; readonly kind: "files"; readonly title: string }
	| { readonly id: string; readonly kind: "code"; readonly title: string; readonly path: string }
	| { readonly id: string; readonly kind: "git"; readonly title: string }
	| { readonly id: string; readonly kind: "skills"; readonly title: string }
	| { readonly id: string; readonly kind: "plugins"; readonly title: string };
