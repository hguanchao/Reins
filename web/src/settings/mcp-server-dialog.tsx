import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { api } from "../api.ts";
import { Button, Dialog, toast } from "../components/ui/index.ts";
import type { McpServerInput, McpServerType } from "../protocol.ts";
import { ChoiceGroup } from "./controls.tsx";
import { parseArgumentLines, parseKeyValueLines } from "./settings-model.ts";

const FIELD =
	"h-9 w-full rounded-md border-[0.5px] border-input-border bg-input px-3 text-[13px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";
const AREA =
	"w-full resize-y rounded-md border-[0.5px] border-input-border bg-input px-3 py-2 font-mono text-[12px] leading-5 outline-none transition-colors placeholder:text-foreground-subtlest focus:border-input-border-focused";

/** 添加 MCP server：stdio 填命令，http/sse 填地址；请求头与环境变量按 KEY=VALUE 行输入。 */
export function McpServerDialog({
	open,
	onClose,
	onCreated,
}: {
	readonly open: boolean;
	onClose(): void;
	onCreated(): void;
}): ReactElement {
	const [name, setName] = useState("");
	const [type, setType] = useState<McpServerType>("stdio");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [env, setEnv] = useState("");
	const [url, setUrl] = useState("");
	const [headers, setHeaders] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!open) return;
		setName("");
		setType("stdio");
		setCommand("");
		setArgs("");
		setEnv("");
		setUrl("");
		setHeaders("");
		setSaving(false);
		setError(undefined);
	}, [open]);

	const submit = (): void => {
		if (saving) return;
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			setError("请填写名称");
			return;
		}
		if (type === "stdio" && command.trim().length === 0) {
			setError("stdio 需要填写启动命令");
			return;
		}
		if (type !== "stdio" && url.trim().length === 0) {
			setError("http 与 sse 需要填写地址");
			return;
		}
		const pairs = parseKeyValueLines(type === "stdio" ? env : headers);
		if (!pairs.ok) {
			setError(`${type === "stdio" ? "环境变量" : "请求头"}：${pairs.error}`);
			return;
		}

		const input: McpServerInput =
			type === "stdio"
				? {
						name: trimmedName,
						type,
						command: command.trim(),
						args: parseArgumentLines(args),
						env: pairs.value,
					}
				: {
						name: trimmedName,
						type,
						url: url.trim(),
						headers: pairs.value,
					};

		setSaving(true);
		setError(undefined);
		void api
			.addMcpServer(input)
			.then(() => {
				toast("MCP 服务器已添加，正在后台连接");
				onCreated();
				onClose();
			})
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
			.finally(() => setSaving(false));
	};

	const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		submit();
	};

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title="添加 MCP 服务器"
			footer={
				<>
					<Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" disabled={saving} onClick={submit}>
						{saving ? "添加中…" : "添加"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">名称</span>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={submitOnEnter}
						placeholder="docs"
						aria-label="MCP 服务器名称"
						autoFocus
						className={FIELD}
					/>
					<span className="text-[11px] leading-4 text-foreground-subtlest">
						用于工具名前缀，仅支持字母、数字、- 和 _。
					</span>
				</label>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-[12px] leading-[18px] text-foreground-subtle">传输方式</span>
					<ChoiceGroup
						options={[
							{ key: "stdio", label: "stdio" },
							{ key: "http", label: "http" },
							{ key: "sse", label: "sse" },
						]}
						selected={type}
						onSelect={(next) => setType(next)}
					/>
				</div>
				<p className="m-0 text-[11px] leading-4 text-foreground-subtlest">
					{type === "stdio"
						? "在本地启动进程；参数每行一个。"
						: "连接远程端点；请求头按 KEY=VALUE 每行一个。"}
				</p>

				{type === "stdio" ? (
					<>
						<label className="flex flex-col gap-1">
							<span className="text-[12px] leading-[18px] text-foreground-subtle">命令</span>
							<input
								value={command}
								onChange={(event) => setCommand(event.target.value)}
								onKeyDown={submitOnEnter}
								placeholder="npx"
								aria-label="启动命令"
								className={FIELD}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-[12px] leading-[18px] text-foreground-subtle">参数</span>
							<textarea
								value={args}
								onChange={(event) => setArgs(event.target.value)}
								placeholder={"-y\n@modelcontextprotocol/server-filesystem\nE:/work"}
								aria-label="启动参数"
								className={`${AREA} min-h-[76px]`}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-[12px] leading-[18px] text-foreground-subtle">
								环境变量 <span className="text-foreground-subtlest">（可选）</span>
							</span>
							<textarea
								value={env}
								onChange={(event) => setEnv(event.target.value)}
								placeholder={"DEBUG=1\nTOKEN=..."}
								aria-label="环境变量"
								className={`${AREA} min-h-[64px]`}
							/>
						</label>
					</>
				) : (
					<>
						<label className="flex flex-col gap-1">
							<span className="text-[12px] leading-[18px] text-foreground-subtle">地址</span>
							<input
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								onKeyDown={submitOnEnter}
								placeholder="https://example.com/mcp"
								aria-label="MCP 服务器地址"
								className={FIELD}
							/>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-[12px] leading-[18px] text-foreground-subtle">
								请求头 <span className="text-foreground-subtlest">（可选）</span>
							</span>
							<textarea
								value={headers}
								onChange={(event) => setHeaders(event.target.value)}
								placeholder={"Authorization=Bearer ...\nX-Project=reins"}
								aria-label="请求头"
								className={`${AREA} min-h-[64px]`}
							/>
						</label>
					</>
				)}

				{error === undefined ? null : (
					<p className="m-0 text-[12px] leading-[18px] text-destructive">{error}</p>
				)}
			</div>
		</Dialog>
	);
}
