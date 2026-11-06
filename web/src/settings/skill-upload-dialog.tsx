import { Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";
import { formatKb } from "./settings-model.ts";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 上传技能压缩包：包内需包含一个 SKILL.md，同目录的其他文件会一起安装。 */
export function SkillUploadDialog({
	open,
	onClose,
	onCreated,
}: {
	readonly open: boolean;
	onClose(): void;
	onCreated(): void;
}): ReactElement {
	const [file, setFile] = useState<File | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const input = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!open) return;
		setFile(undefined);
		setSaving(false);
		setError(undefined);
		if (input.current !== null) input.current.value = "";
	}, [open]);

	const pick = (selected: File | undefined): void => {
		if (selected === undefined) return;
		if (!selected.name.toLowerCase().endsWith(".zip")) {
			setFile(undefined);
			setError("请选择 .zip 压缩包");
			return;
		}
		if (selected.size > MAX_UPLOAD_BYTES) {
			setFile(undefined);
			setError(`压缩包超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
			return;
		}
		setError(undefined);
		setFile(selected);
	};

	const submit = (): void => {
		if (saving) return;
		if (file === undefined) {
			setError("请先选择一个技能压缩包");
			return;
		}
		setSaving(true);
		setError(undefined);
		void api
			.uploadSkillArchive(file)
			.then(() => {
				toast("技能已上传");
				onCreated();
				onClose();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title="上传技能压缩包"
			footer={
				<>
					<Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" disabled={saving} onClick={submit}>
						{saving ? "上传中…" : "上传"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<label className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-[0.5px] border-dashed border-border bg-surface px-4 py-7 text-center transition-colors hover:bg-surface-hover">
					<Upload className="size-5 text-foreground-subtlest" />
					<span className="text-[13px] leading-5">{file?.name ?? "选择一个技能压缩包（.zip）"}</span>
					<span className="text-[11px] leading-4 text-foreground-subtlest">
						{file === undefined
							? "压缩包内需包含一个 SKILL.md"
							: `${formatKb(file.size)} · 点击重新选择`}
					</span>
					<input
						ref={input}
						type="file"
						accept=".zip,application/zip,application/x-zip-compressed"
						aria-label="选择技能压缩包"
						className="sr-only"
						onChange={(event) => pick(event.target.files?.[0])}
					/>
				</label>
				<p className="m-0 text-[11px] leading-4 text-foreground-subtlest">
					压缩包内需包含一个 SKILL.md，目录中的其他文件会一起安装；同名技能会被拒绝，不会覆盖现有内容。
				</p>
				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}
