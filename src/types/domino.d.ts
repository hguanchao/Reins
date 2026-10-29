/**
 * domino 的最小类型替身。
 *
 * 该包自带的类型入口引用 DOMImplementation、Document 等浏览器全局类型，会把整个工程拖进
 * DOM lib（与 highlight.js 相同的问题）。本项目只用「解析 HTML + 建文本节点」这一小块能力，
 * 因此在这里给出最小声明，并在 tsconfig 的 paths 里把 domino 的类型解析指过来。
 */

declare module "domino" {
	/** 遍历与改写所需的最小节点形状；字段名与 DOM 保持一致，调用处不再重复取名。 */
	export interface DominoNode {
		readonly nodeType: number;
		/** 元素节点为大写标签名（如 "DIV"） */
		readonly nodeName: string;
		readonly parentNode: DominoNode | null;
		readonly childNodes: { readonly length: number; readonly [index: number]: DominoNode };
		readonly textContent: string;
		removeChild(child: DominoNode): DominoNode;
		replaceChild(newChild: DominoNode, oldChild: DominoNode): DominoNode;
	}

	export interface DominoDocument extends DominoNode {
		readonly body: DominoNode | null;
		createTextNode(text: string): DominoNode;
	}

	export function createDocument(html?: string): DominoDocument;
}
