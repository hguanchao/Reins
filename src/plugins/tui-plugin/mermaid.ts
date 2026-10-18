import {
	displayWidth,
	lineOfCells,
	plain,
	segmentGraphemes,
	styled,
	type Cell,
	type Line,
	type Style,
} from "../../tui/index.ts";
import { ACCENT, DIM, EDGE, FAINT, TEXT } from "./theme.ts";

/**
 * 终端原生 Mermaid 预览。
 *
 * 只覆盖编码场景里最常见的一类图：自上而下的 flowchart（`graph TD/TB` 或
 * `flowchart TD/TB`），节点用方框、边用折线与箭头。分支会画在同一层，跨层边、环、
 * 子图、样式与左右布局都退回源码块——画错一张图比显示源码更糟。
 */

const TOKEN = /([A-Za-z_][A-Za-z0-9_]*)(\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?|(-->|---|-\.->|==>)|(\|[^|]*\|)/g;

interface Edge {
	readonly from: string;
	readonly to: string;
	readonly label: string | undefined;
}

interface Graph {
	readonly nodes: readonly string[];
	readonly labels: ReadonlyMap<string, string>;
	readonly edges: readonly Edge[];
}

interface Box {
	readonly row: number;
	readonly center: number;
	readonly width: number;
}

export function renderMermaid(source: string, width: number): readonly Line[] | undefined {
	if (width < 20) return undefined;
	const graph = parse(source);
	if (graph === undefined) return undefined;
	return layout(graph, width);
}

function parse(source: string): Graph | undefined {
	const lines = source
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("%%"));
	if (lines.length === 0) return undefined;

	const header = /^(?:graph|flowchart)\s+(TD|TB)\s*;?$/i.exec(lines[0] ?? "");
	if (header === null) return undefined;

	const nodes: string[] = [];
	const labels = new Map<string, string>();
	const edges: Edge[] = [];

	for (const line of lines.slice(1)) {
		// 子图与方向覆盖改变了布局语义，当前子集不画
		if (/^(subgraph|end|direction)\b/i.test(line)) return undefined;
		// 样式与点击只影响外观，跳过
		if (/^(classDef|class\s|style\s|linkStyle|click\s)/i.test(line)) continue;

		for (const statement of line.split(";")) {
			if (statement.trim().length === 0) continue;
			if (statement.includes("&")) return undefined;

			let last: string | undefined;
			let pending: { readonly from: string; label: string | undefined } | undefined;
			let matched = false;

			for (const match of statement.matchAll(TOKEN)) {
				matched = true;
				const id = match[1];
				const shape = match[2];
				const operator = match[3];
				const label = match[4];

				if (id !== undefined) {
					const text = shapeLabel(shape) ?? id;
					if (!labels.has(id)) nodes.push(id);
					// 先出现的是裸 id、后出现带标签时补上；反过来不覆盖已有标签
					if (!labels.has(id) || shape !== undefined) labels.set(id, text);
					if (pending !== undefined) {
						edges.push({ from: pending.from, to: id, label: pending.label });
						pending = undefined;
					}
					last = id;
					continue;
				}
				if (operator !== undefined) {
					if (last === undefined) return undefined;
					pending = { from: last, label: undefined };
					continue;
				}
				if (label !== undefined) {
					if (pending === undefined) return undefined;
					const text = label.slice(1, -1).trim();
					pending = { from: pending.from, label: text.length === 0 ? undefined : text };
				}
			}

			if (!matched) return undefined;
			if (pending !== undefined) return undefined;
			if (statement.replace(TOKEN, "").replace(/[;\s]/gu, "").length > 0) return undefined;
		}
	}

	if (nodes.length === 0) return undefined;
	return { nodes, labels, edges };
}

function layout(graph: Graph, width: number): readonly Line[] | undefined {
	const outgoing = new Map<string, Edge[]>(graph.nodes.map((node) => [node, []]));
	const indegree = new Map<string, number>(graph.nodes.map((node) => [node, 0]));
	for (const edge of graph.edges) {
		outgoing.get(edge.from)?.push(edge);
		indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
	}

	const layerOf = new Map<string, number>(graph.nodes.map((node) => [node, 0]));
	const queue = graph.nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
	let processed = 0;
	while (queue.length > 0) {
		const node = queue.shift() as string;
		processed += 1;
		for (const edge of outgoing.get(node) ?? []) {
			layerOf.set(edge.to, Math.max(layerOf.get(edge.to) ?? 0, (layerOf.get(node) ?? 0) + 1));
			const remaining = (indegree.get(edge.to) ?? 0) - 1;
			indegree.set(edge.to, remaining);
			if (remaining === 0) queue.push(edge.to);
		}
	}
	if (processed !== graph.nodes.length) return undefined;

	// 跨层边需要真正的路由，本子集不画
	for (const edge of graph.edges) {
		const from = layerOf.get(edge.from) ?? 0;
		const to = layerOf.get(edge.to) ?? 0;
		if (to > from + 1) return undefined;
	}

	const layers: string[][] = [];
	for (const node of graph.nodes) {
		const layer = layerOf.get(node) ?? 0;
		(layers[layer] ??= []).push(node);
	}

	const gap = 3;
	const boxes = new Map<string, Box>();
	const boxWidth = new Map<string, number>();
	for (const node of graph.nodes) {
		boxWidth.set(node, Math.max(7, displayWidth(graph.labels.get(node) ?? node) + 4));
	}
	const layerWidths = layers.map((layer) =>
		layer.reduce((total, node) => total + (boxWidth.get(node) ?? 7), 0) + gap * Math.max(0, layer.length - 1),
	);
	if (layerWidths.some((layerWidth) => layerWidth > width)) return undefined;

	const rows = Math.max(3, layers.length * 5 - 2);
	const grid: Cell[][] = Array.from({ length: rows }, () =>
		Array.from({ length: width }, () => ({ text: " ", width: 1 })),
	);

	layers.forEach((layer, index) => {
		let column = Math.floor((width - (layerWidths[index] ?? 0)) / 2);
		const row = index * 5;
		for (const node of layer) {
			const box = boxWidth.get(node) ?? 7;
			const center = column + Math.floor(box / 2);
			boxes.set(node, { row, center, width: box });
			write(grid, row, column, `┌${"─".repeat(box - 2)}┐`, EDGE);
			write(grid, row + 1, column, "│", EDGE);
			write(grid, row + 1, column + 2, graph.labels.get(node) ?? node, TEXT);
			write(grid, row + 1, column + box - 1, "│", EDGE);
			write(grid, row + 2, column, `└${"─".repeat(box - 2)}┘`, EDGE);
			column += box + gap;
		}
	});

	for (const edge of graph.edges) {
		const from = boxes.get(edge.from);
		const to = boxes.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const stem = from.row + 3;
		const arrow = from.row + 4;
		write(grid, stem, from.center, "│", FAINT);
		if (from.center === to.center) {
			write(grid, arrow, to.center, "▼", ACCENT);
			continue;
		}
		const low = Math.min(from.center, to.center);
		const high = Math.max(from.center, to.center);
		for (let column = low; column <= high; column += 1) write(grid, arrow, column, "─", FAINT);
		write(grid, arrow, from.center, from.center < to.center ? "└" : "┘", FAINT);
		write(grid, arrow, to.center, "▼", ACCENT);
	}

	const lines = grid.map((row) => lineOfCells(row));
	const labeled = graph.edges.filter((edge) => edge.label !== undefined);
	if (labeled.length > 0) {
		lines.push(plain(""));
		for (const edge of labeled) {
			lines.push(
				styled(
					`${edge.label}: ${graph.labels.get(edge.from) ?? edge.from} → ${graph.labels.get(edge.to) ?? edge.to}`,
					DIM,
				),
			);
		}
	}
	return lines;
}

/** 往网格里写一段文字；宽字符占两格，第二格留空。 */
function write(grid: Cell[][], row: number, column: number, text: string, style: Style): void {
	const target = grid[row];
	if (target === undefined) return;
	let cursor = column;
	for (const grapheme of segmentGraphemes(text)) {
		const width = displayWidth(grapheme);
		if (cursor >= 0 && cursor < target.length) {
			target[cursor] = { text: grapheme, width: Math.max(1, width), style };
		}
		for (let index = 1; index < width; index += 1) {
			if (cursor + index < target.length) {
				target[cursor + index] = { text: "", width: 0, style };
			}
		}
		cursor += width;
	}
}

function shapeLabel(shape: string | undefined): string | undefined {
	if (shape === undefined) return undefined;
	const inner =
		shape.startsWith("((") && shape.endsWith("))")
			? shape.slice(2, -2)
			: shape.startsWith("[") || shape.startsWith("{") || shape.startsWith("(")
				? shape.slice(1, -1)
				: undefined;
	if (inner === undefined) return undefined;
	const text = inner.trim().replace(/^["']|["']$/gu, "");
	return text.length === 0 ? undefined : text;
}
