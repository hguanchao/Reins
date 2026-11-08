import { useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import type { PersonalizationSnapshot } from "../protocol.ts";
import { Section, SettingsPane } from "./controls.tsx";
import { formatKb, personalizationBytes } from "./settings-model.ts";

const SNIPPETS: readonly string[] = ["用简体中文回答", "改代码前先读文件", "提交信息用祈使句"];

/**
 * 个性化。
 *
 * 用户级规则文件，每回合读取一次：保存后从下一回合生效。这是唯一保留「取消 / 保存」的
 * 设置页——它有真实草稿态，其余页面都是即时生效。
 */
export function PersonalizationSection(): ReactElement {
	const [snapshot, setSnapshot] = useState<PersonalizationSnapshot | undefined>(undefined);
	const [text, setText] = useState("");
	const [savedText, setSavedText] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		setLoading(true);
		void api
			.personalization()
			.then((next) => {
				setSnapshot(next);
				setText(next.text);
				setSavedText(next.text);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setLoading(false));
	}, []);

	const bytes = personalizationBytes(text);
	const limit = snapshot?.maxBytes ?? 0;
	const overLimit = snapshot !== undefined && bytes > limit;
	const dirty = text !== savedText;

	const save = (): void => {
		if (snapshot === undefined || saving || overLimit) return;
		setSaving(true);
		setError(undefined);
		void api
			.savePersonalization(text)
			.then((next) => {
				setSnapshot(next);
				setSavedText(next.text);
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	const append = (snippet: string): void => {
		setText((current) =>
			current.trim().length === 0 ? `- ${snippet}` : `${current.replace(/\s*$/, "")}\n- ${snippet}`,
		);
	};

	return (
		<SettingsPane
			eyebrow="SETTINGS / PERSONALIZATION"
			title="个性化"
			description="添加自定义指令来约束 Agent 的回复。指令对这台机器上的所有项目生效。"
		>
			<Section name="自定义指令" hint="每回合读取一次">
				<div className="snips">
					{SNIPPETS.map((snippet) => (
						<button key={snippet} type="button" className="snip" onClick={() => append(snippet)}>
							+ {snippet}
						</button>
					))}
				</div>
				<div className="rules">
					<textarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder={loading ? "正在读取…" : "添加自定义指令…"}
						aria-label="个性化指令"
						disabled={loading || snapshot === undefined}
						spellCheck={false}
					/>
					<div className="ft">
						<span className="sp" title={snapshot?.path}>
							{snapshot?.path ?? "—"}
						</span>
						<span style={{ color: overLimit ? "var(--danger)" : undefined }}>
							{formatKb(bytes)} / {snapshot === undefined ? "—" : formatKb(limit)}
						</span>
					</div>
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
					<p className="set-note" style={{ margin: 0, flex: 1 }}>
						保存后从下一回合开始生效；这是用户级规则，不会写入任何项目。
					</p>
					<button
						type="button"
						className="b b-line b-sm"
						disabled={!dirty || saving}
						onClick={() => {
							setText(savedText);
							setError(undefined);
						}}
					>
						取消
					</button>
					<button
						type="button"
						className="b b-solid b-sm"
						disabled={!dirty || saving || overLimit}
						onClick={save}
					>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
				{error === undefined ? null : (
					<p className="set-note" style={{ color: "var(--danger)" }}>
						{error}
					</p>
				)}
			</Section>

			<Section name="生效方式">
				<div className="set-card">
					<div className="set-row">
						<span className="v mono" style={{ color: "var(--ink-4)" }}>
							01
						</span>
						<div className="txt">
							<div className="t">先于项目规则注入</div>
							<div className="d">用户级规则对所有项目生效；项目里的 AGENTS.md 仍然优先。</div>
						</div>
					</div>
					<div className="set-row">
						<span className="v mono" style={{ color: "var(--ink-4)" }}>
							02
						</span>
						<div className="txt">
							<div className="t">同目录 override 优先生效</div>
							<div className="d">存在 AGENTS.override.md 时覆盖 AGENTS.md，这里编辑的是当前生效的那一份。</div>
						</div>
					</div>
					<div className="set-row">
						<span className="v mono" style={{ color: "var(--ink-4)" }}>
							03
						</span>
						<div className="txt">
							<div className="t">共享 32 KB 预算</div>
							<div className="d">用户规则与项目规则合计 32 KB，超出部分会被截断。</div>
						</div>
					</div>
				</div>
			</Section>
		</SettingsPane>
	);
}
