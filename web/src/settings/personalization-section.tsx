import { Info, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, toast } from "../components/ui/index.ts";
import { cn } from "../components/ui/cn.ts";
import type { PersonalizationSnapshot } from "../protocol.ts";
import { SettingsHeader } from "./controls.tsx";
import { formatKb, personalizationBytes } from "./settings-model.ts";

/**
 * 个性化：编辑用户级规则文件。
 *
 * 内容写回本机，不随项目走；每回合读取一次，因此保存后从下一次请求开始生效。
 */
export function PersonalizationSection(): ReactElement {
	const [snapshot, setSnapshot] = useState<PersonalizationSnapshot | undefined>(undefined);
	const [text, setText] = useState("");
	const [savedText, setSavedText] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const load = useCallback((): void => {
		setLoading(true);
		setError(undefined);
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

	useEffect(() => {
		load();
	}, [load]);

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
				toast("个性化指令已保存");
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	return (
		<div className="flex flex-col gap-7">
			<SettingsHeader
				title="个性化"
				description="添加自定义指令来个性化 Agent 的回复。指令会应用到本机 Agent 的后续回合，所有项目共用。"
			/>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">自定义指令</h2>
				<div className="rounded-[16px] border-[0.5px] border-border bg-card p-3 transition-colors focus-within:border-input-border-focused">
					<textarea
						value={text}
						onChange={(event) => setText(event.target.value)}
						placeholder={loading ? "正在读取…" : "添加自定义指令…"}
						aria-label="个性化指令"
						disabled={loading || snapshot === undefined}
						spellCheck={false}
						className="block min-h-[240px] w-full resize-y rounded-[12px] bg-transparent px-2 py-1.5 text-[14px] leading-[24px] text-foreground outline-none placeholder:text-foreground-subtlest disabled:opacity-60"
					/>
					<div className="mt-1 flex flex-wrap items-center justify-between gap-3 border-t-[0.5px] border-border px-1 pt-2.5">
						<span className="min-w-0 break-all font-mono text-[11px] leading-4 text-foreground-subtlest">
							{snapshot?.path ?? "—"}
						</span>
						<span
							className={cn(
								"shrink-0 font-mono text-[11px] leading-4 tabular-nums",
								overLimit ? "text-destructive" : "text-foreground-subtlest",
							)}
						>
							{formatKb(bytes)} / {snapshot === undefined ? "—" : formatKb(limit)}
						</span>
					</div>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="m-0 max-w-[520px] text-[11px] leading-4 text-foreground-subtlest">
						保存后从下一回合开始生效；这是用户级规则，不会写入任何项目。
					</p>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={!dirty || saving}
							onClick={() => {
								setText(savedText);
								setError(undefined);
							}}
						>
							取消
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={!dirty || saving || overLimit || snapshot === undefined}
							onClick={save}
						>
							{saving ? "保存中…" : "保存"}
						</Button>
					</div>
				</div>

				{overLimit ? (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">
						已超过 {formatKb(limit)} 上限，请精简后再保存。
					</p>
				) : null}
				{error === undefined ? null : (
					<div className="flex flex-wrap items-center gap-2 text-[12px] leading-[18px] text-destructive">
						<span>{error}</span>
						<button
							type="button"
							onClick={load}
							className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-surface-hover"
						>
							<RotateCw className="size-3" />
							重试
						</button>
					</div>
				)}
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="m-0 px-1 text-[13px] leading-5 font-medium">生效方式</h2>
				<div className="flex items-start gap-3 rounded-[16px] border-[0.5px] border-border bg-card px-4 py-3.5">
					<Info className="mt-0.5 size-4 shrink-0 text-foreground-subtlest" />
					<div className="flex flex-col gap-1.5 text-[12px] leading-[18px] text-foreground-subtle">
						<span>用户级规则对这台机器上的所有项目生效，项目级 AGENTS.md 仍然优先。</span>
						<span>同目录存在 AGENTS.override.md 时会覆盖 AGENTS.md，这里编辑的是当前生效的那一份。</span>
						<span>规则文件与项目规则共享 32 KB 的提示词预算，超出部分会被截断。</span>
					</div>
				</div>
			</section>
		</div>
	);
}
