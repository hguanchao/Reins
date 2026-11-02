/**
 * 助手回答的 markdown 渲染管线:marked 解析 → highlight.js 高亮 → DOMPurify 消毒。
 *
 * 模型输出是不可信内容:marked 产出的 HTML 必须过消毒才能进页面,这一步不能用自写
 * 的正则过滤替代。流式期间未闭合的代码围栏先补齐再解析,避免后半屏被吞进代码块。
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

marked.use({
	gfm: true,
	breaks: false,
	renderer: {
		code(token: { text: string; lang?: string }): string {
			const lang = (token.lang ?? "").trim().split(/\s+/)[0];
			const highlighted =
				lang !== "" && hljs.getLanguage(lang) !== undefined
					? hljs.highlight(token.text, { language: lang }).value
					: escapeHtml(token.text);
			const label = lang === "" ? "text" : lang;
			return (
				`<div class="code-block"><div class="code-block-head">` +
				`<span class="code-lang">${escapeHtml(label)}</span>` +
				`<button type="button" class="code-copy" data-copy>复制</button>` +
				`</div><pre><code class="hljs">${highlighted}</code></pre></div>`
			);
		},
	},
});

/** 流式解析前把未闭合的 ``` 围栏补齐;成对时原样返回。 */
function closeFences(markdown: string): string {
	const fences = markdown.match(/```/g) ?? [];
	return fences.length % 2 === 1 ? `${markdown}\n\`\`\`` : markdown;
}

export function renderMarkdown(markdown: string, streaming: boolean): string {
	const source = streaming ? closeFences(markdown) : markdown;
	const html = marked.parse(source, { async: false });
	return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** 会话流里复制按钮的统一事件委托;返回 true 表示点中的是复制钮。 */
export function handleCopyClick(event: Event): boolean {
	const button = (event.target as HTMLElement | null)?.closest("[data-copy]");
	if (button === null || !(button instanceof HTMLButtonElement)) return false;
	const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
	void navigator.clipboard.writeText(code);
	button.textContent = "已复制";
	window.setTimeout(() => {
		button.textContent = "复制";
	}, 1200);
	return true;
}
