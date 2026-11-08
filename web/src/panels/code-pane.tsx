import { Check, Copy, LoaderCircle } from "lucide-react";
import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import type { FileContent } from "../protocol.ts";

const MAX_RENDER_LINES = 5000;

const LANGUAGES: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	css: "css",
	scss: "scss",
	html: "xml",
	xml: "xml",
	svg: "xml",
	md: "markdown",
	py: "python",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	ps1: "powershell",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	sql: "sql",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	rb: "ruby",
};

/** 只读代码查看器：行号单列、高亮走灰阶映射，大文件截断，二进制只显示说明。 */
export function CodePane({ path }: { readonly path: string }): ReactElement {
	const [file, setFile] = useState<FileContent | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		void api
			.fileRead(path)
			.then((content) => {
				if (!cancelled) setFile(content);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	const language = languageOf(path);
	const rendered = useMemo(() => {
		if (file === undefined || file.binary) return [];
		return file.text
			.split("\n")
			.slice(0, MAX_RENDER_LINES)
			.map((line) => (language === undefined ? escapeHtml(line) : highlightLine(line, language)));
	}, [file, language]);

	const copyPath = (): void => {
		void navigator.clipboard.writeText(path).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	};

	return (
		<>
			<div
				className="flex items-center gap-2"
				style={{ height: 34, padding: "0 12px", borderBottom: "1px solid var(--rule)" }}
			>
				<span
					className="min-w-0 flex-1 truncate text-[var(--fs-11)]"
					style={{ color: "var(--ink-3)", fontFamily: "var(--mono)" }}
				>
					{path}
				</span>
				<button
					type="button"
					aria-label={copied ? "已复制" : "复制路径"}
					title={copied ? "已复制" : "复制路径"}
					onClick={copyPath}
					style={{ color: "var(--ink-3)" }}
				>
					{copied ? <Check className="ic-12" /> : <Copy className="ic-12" />}
				</button>
			</div>

			{file?.truncated === true ? (
				<div
					style={{
						padding: "6px 12px",
						borderBottom: "1px solid var(--rule)",
						background: "var(--hatch-soft)",
						fontSize: "var(--fs-11)",
						color: "var(--ink)",
					}}
				>
					文件超过 512KB，只显示前 512KB。
				</div>
			) : null}
			{file?.lossy === true ? (
				<div
					style={{
						padding: "6px 12px",
						borderBottom: "1px solid var(--rule)",
						background: "var(--hatch-soft)",
						fontSize: "var(--fs-11)",
						color: "var(--ink)",
					}}
				>
					文件不是 UTF-8 编码，显示内容可能包含替换字符。
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-auto">
				{loading ? (
					<div className="flex items-center gap-2 px-3 py-3 text-[var(--fs-11)]" style={{ color: "var(--ink-3)" }}>
						<LoaderCircle className="ic-12 spin" />
						加载中
					</div>
				) : error !== undefined ? (
					<div className="px-3 py-3 text-[var(--fs-11)]" style={{ color: "var(--danger)" }}>
						{error}
					</div>
				) : file === undefined ? null : file.binary ? (
					<div className="px-3 py-3 text-[var(--fs-11)]" style={{ color: "var(--ink-3)" }}>
						二进制文件，无法以文本显示。
					</div>
				) : (
					<div
						className="min-w-max py-2"
						style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-11)", lineHeight: 1.72 }}
					>
						{rendered.map((html, index) => (
							<div key={index} className="flex">
								<span
									className="sticky left-0 w-10 shrink-0 select-none pr-3 text-right"
									style={{ background: "var(--sheet)", color: "var(--ink-4)", fontSize: "var(--fs-10)" }}
								>
									{index + 1}
								</span>
								<code
									className="hljs min-w-0 whitespace-pre pr-6"
									dangerouslySetInnerHTML={{ __html: html.length === 0 ? " " : html }}
								/>
							</div>
						))}
						{file.text.split("\n").length > MAX_RENDER_LINES ? (
							<div className="px-12 py-2 text-[var(--fs-11)]" style={{ color: "var(--ink-4)" }}>
								文件过长，只渲染前 {MAX_RENDER_LINES} 行。
							</div>
						) : null}
					</div>
				)}
			</div>
		</>
	);
}

function languageOf(path: string): string | undefined {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const language = LANGUAGES[extension];
	return language !== undefined && hljs.getLanguage(language) !== undefined ? language : undefined;
}

function highlightLine(line: string, language: string): string {
	try {
		return hljs.highlight(line, { language, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(line);
	}
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
