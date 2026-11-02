import { Check, Copy, FileCode2, Loader2 } from "lucide-react";
import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { IconButton } from "../components/ui/button.tsx";
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

/** 只读代码查看器；大文件截断，二进制只显示说明。 */
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
		const lines = file.text.split("\n");
		const visible = lines.slice(0, MAX_RENDER_LINES);
		return visible.map((line) => (language === undefined ? escapeHtml(line) : highlightLine(line, language)));
	}, [file, language]);

	const copyPath = (): void => {
		void navigator.clipboard.writeText(path).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
		});
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/50 px-3">
				<FileCode2 className="size-4 shrink-0 text-foreground-subtle" />
				<span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle">{path}</span>
				<IconButton label={copied ? "已复制" : "复制路径"} size="icon-sm" onClick={copyPath}>
					{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
				</IconButton>
			</div>

			{file?.truncated === true ? (
				<div className="border-b border-warning/20 bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground">
					文件超过 512KB，只显示前 512KB。
				</div>
			) : null}
			{file?.lossy === true ? (
				<div className="border-b border-warning/20 bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground">
					文件不是 UTF-8 编码，显示内容可能包含替换字符。
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-auto">
				{loading ? (
					<div className="flex items-center gap-2 px-4 py-3 text-ui-sm text-foreground-subtle">
						<Loader2 className="size-4 animate-spin" />
						加载中
					</div>
				) : error !== undefined ? (
					<div className="px-4 py-3 text-ui-sm text-destructive">{error}</div>
				) : file === undefined ? null : file.binary ? (
					<div className="px-4 py-3 text-ui-sm text-foreground-subtle">二进制文件，无法以文本显示。</div>
				) : (
					<div className="min-w-max py-2 font-mono text-[13px] leading-6">
						{rendered.map((html, index) => (
							<div key={index} className="flex">
								<span className="sticky left-0 w-12 shrink-0 select-none bg-background pr-3 text-right text-foreground-subtlest">
									{index + 1}
								</span>
								<code
									className="hljs min-w-0 whitespace-pre pr-6"
									dangerouslySetInnerHTML={{ __html: html.length === 0 ? " " : html }}
								/>
							</div>
						))}
						{file.text.split("\n").length > MAX_RENDER_LINES ? (
							<div className="px-12 py-2 text-ui-sm text-foreground-subtlest">
								文件过长，只渲染前 {MAX_RENDER_LINES} 行。
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
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
