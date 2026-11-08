import { Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { api } from "../api.ts";
import { Dialog, toast } from "../components/ui/index.ts";
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
					<button type="button" className="b b-line" disabled={saving} onClick={onClose}>
						取消
					</button>
					<button type="button" className="b b-solid" disabled={saving} onClick={submit}>
						{saving ? "上传中…" : "上传"}
					</button>
				</>
			}
		>
			<label
				style={{
					display: "flex",
					cursor: "pointer",
					flexDirection: "column",
					alignItems: "center",
					gap: 5,
					padding: "22px 16px",
					border: "1px dashed var(--rule-2)",
					borderRadius: "var(--r-3)",
					textAlign: "center",
				}}
			>
				<Upload className="ic ic-18" style={{ color: "var(--ink-3)" }} />
				<span style={{ fontSize: "var(--fs-12)", fontWeight: 500 }}>
					{file?.name ?? "选择一个技能压缩包（.zip）"}
				</span>
				<span style={{ fontSize: "var(--fs-10)", color: "var(--ink-4)" }}>
					{file === undefined ? "压缩包内需包含一个 SKILL.md" : `${formatKb(file.size)} · 点击重新选择`}
				</span>
				<input
					ref={input}
					type="file"
					accept=".zip,application/zip,application/x-zip-compressed"
					aria-label="选择技能压缩包"
					style={{ display: "none" }}
					onChange={(event) => pick(event.target.files?.[0])}
				/>
			</label>
			<p className="form-hint">
				压缩包内需包含一个 SKILL.md，目录中的其他文件会一起安装；同名技能会被拒绝，不会覆盖现有内容。
			</p>
			{error === undefined ? null : <p className="form-error">{error}</p>}
		</Dialog>
	);
}
