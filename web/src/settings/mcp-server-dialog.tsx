import { useEffect, useState, type KeyboardEvent, type ReactElement } from "react";

import { api } from "../api.ts";
import { Dialog, toast } from "../components/ui/index.ts";
import type { McpServerInput, McpServerType } from "../protocol.ts";
import { parseArgumentLines, parseKeyValueLines } from "./settings-model.ts";

/** KEY=VALUE 对象还原成表单里的逐行文本。 */
function formatPairs(pairs: Readonly<Record<string, string>> | undefined): string {
	return Object.entries(pairs ?? {})
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

/** 添加或编辑 MCP server：stdio 填命令，http/sse 填地址；请求头与环境变量按 KEY=VALUE 行输入。 */
export function McpServerDialog({
	open,
	server,
	onClose,
	onCreated,
}: {
	readonly open: boolean;
	/** 编辑目标；缺省时是新增 */
	readonly server?: McpServerInput;
	onClose(): void;
	onCreated(): void;
}): ReactElement {
	const editing = server !== undefined;
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
		setName(server?.name ?? "");
		setType(server?.type ?? "stdio");
		setCommand(server?.type === "stdio" ? (server.command ?? "") : "");
		setArgs(server?.type === "stdio" ? (server.args ?? []).join("\n") : "");
		setEnv(server?.type === "stdio" ? formatPairs(server.env) : "");
		setUrl(server !== undefined && server.type !== "stdio" ? (server.url ?? "") : "");
		setHeaders(server !== undefined && server.type !== "stdio" ? formatPairs(server.headers) : "");
		setSaving(false);
		setError(undefined);
	}, [open, server]);

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
		const request = editing ? api.updateMcpServer(input) : api.addMcpServer(input);
		void request
			.then(() => {
				toast(editing ? "MCP 服务器已保存，正在重新连接" : "MCP 服务器已添加，正在后台连接");
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
			title={editing ? "编辑 MCP 服务器" : "添加 MCP 服务器"}
			footer={
				<>
					<button type="button" className="b b-line" disabled={saving} onClick={onClose}>
						取消
					</button>
					<button type="button" className="b b-solid" disabled={saving} onClick={submit}>
						{saving ? (editing ? "保存中…" : "添加中…") : editing ? "保存" : "添加"}
					</button>
				</>
			}
		>
			<label>
				<span className="form-label">名称</span>
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={submitOnEnter}
					placeholder="docs"
					aria-label="MCP 服务器名称"
					disabled={editing}
					autoFocus={!editing}
					className="form-input"
				/>
				<span className="form-hint">
					{editing ? "编辑时名称不可修改。" : "用于工具名前缀，仅支持字母、数字、- 和 _。"}
				</span>
			</label>

			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
				<span className="form-label" style={{ margin: 0 }}>
					传输方式
				</span>
				<div className="seg">
					{(["stdio", "http", "sse"] as const).map((option) => (
						<button key={option} type="button" aria-pressed={option === type} onClick={() => setType(option)}>
							{option}
						</button>
					))}
				</div>
			</div>
			<p className="form-hint">
				{type === "stdio" ? "在本地启动进程；参数每行一个。" : "连接远程端点；请求头按 KEY=VALUE 每行一个。"}
			</p>

			{type === "stdio" ? (
				<>
					<label>
						<span className="form-label">命令</span>
						<input
							value={command}
							onChange={(event) => setCommand(event.target.value)}
							onKeyDown={submitOnEnter}
							placeholder="npx"
							aria-label="启动命令"
							className="form-input"
						/>
					</label>
					<label>
						<span className="form-label">参数</span>
						<textarea
							value={args}
							onChange={(event) => setArgs(event.target.value)}
							placeholder={"-y\n@modelcontextprotocol/server-filesystem\nE:/work"}
							aria-label="启动参数"
							className="form-area"
							style={{ minHeight: 76 }}
						/>
					</label>
					<label>
						<span className="form-label">环境变量（可选）</span>
						<textarea
							value={env}
							onChange={(event) => setEnv(event.target.value)}
							placeholder={"DEBUG=1\nTOKEN=..."}
							aria-label="环境变量"
							className="form-area"
							style={{ minHeight: 64 }}
						/>
					</label>
				</>
			) : (
				<>
					<label>
						<span className="form-label">地址</span>
						<input
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							onKeyDown={submitOnEnter}
							placeholder="https://example.com/mcp"
							aria-label="MCP 服务器地址"
							className="form-input"
						/>
					</label>
					<label>
						<span className="form-label">请求头（可选）</span>
						<textarea
							value={headers}
							onChange={(event) => setHeaders(event.target.value)}
							placeholder={"Authorization=Bearer ...\nX-Project=reins"}
							aria-label="请求头"
							className="form-area"
							style={{ minHeight: 64 }}
						/>
					</label>
				</>
			)}

			{error === undefined ? null : <p className="form-error">{error}</p>}
		</Dialog>
	);
}
