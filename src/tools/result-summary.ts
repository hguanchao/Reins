import { formatBytes } from "./format.ts";

/**
 * 工具结束后的折叠行指标。
 *
 * 优先使用工具返回的结构化 details；历史回放只有结果文本，因此再提供一层保守的文本回退。
 * 解析不出来时返回 undefined，界面就不显示指标，不做猜测。
 */
export function resultMetric(tool: string, details: unknown, content: string): string | undefined {
	switch (tool) {
		case "read":
			return readMetric(details, content);
		case "write":
			return writeMetric(details, content);
		case "edit":
			return editMetric(details, content);
		case "grep":
			return countMetric(details, content, "matches", /^No matches for /);
		case "find":
			return countMetric(details, content, "files", /^No files match /);
		case "ls":
			return listMetric(details, content);
		case "subagent":
			return subagentMetric(details);
		default:
			return undefined;
	}
}

function readMetric(details: unknown, content: string): string | undefined {
	const info = record(details);
	if (numberField(info, "lines") === 0) return "empty";

	const total = numberField(info, "totalLines");
	const start = numberField(info, "startLine");
	const end = numberField(info, "endLine");
	if (start !== undefined && end !== undefined) {
		if (total === undefined) return `${start}-${end}`;
		return start === 1 && end === total ? lineLabel(total) : `${start}-${end} of ${total}`;
	}
	return readMetricFromContent(content);
}

function readMetricFromContent(content: string): string | undefined {
	const shown = /\[showing lines (\d+)-(\d+) of (\d+);/.exec(content);
	if (shown !== null) return `${shown[1]}-${shown[2]} of ${shown[3]}`;
	if (/ is empty$/.test(content)) return "empty";

	const body = (content.split("\n\n[")[0] ?? "").replace(/\n$/, "");
	if (body.length === 0) return undefined;
	return lineLabel(body.split("\n").length);
}

function lineLabel(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`;
}

function writeMetric(details: unknown, content: string): string | undefined {
	const info = record(details);
	const bytes = numberField(info, "bytes");
	const created = booleanField(info, "created");
	if (bytes !== undefined && created !== undefined) {
		return `${created ? "created" : "overwrote"}, ${formatBytes(bytes)}`;
	}

	const match = /^(Created|Overwrote) .* with (\d+) bytes/.exec(content);
	if (match === null) return undefined;
	const action = match[1] === "Created" ? "created" : "overwrote";
	return `${action}, ${formatBytes(Number(match[2]))}`;
}

function editMetric(details: unknown, content: string): string | undefined {
	const info = record(details);
	if (booleanField(info, "changed") === false) return "unchanged";

	const diff = stringField(info, "diff");
	if (diff !== undefined) {
		const metric = diffStat(diff);
		if (metric !== undefined) return metric;
	}

	const editCount = numberField(info, "editCount");
	if (editCount !== undefined) return `${editCount} ${editCount === 1 ? "edit" : "edits"}`;

	const body = content.includes("\n\n") ? content.slice(content.indexOf("\n\n") + 2) : "";
	const fromContent = diffStat(body);
	if (fromContent !== undefined) return fromContent;
	if (/ is unchanged$/.test(content)) return "unchanged";
	return undefined;
}

function diffStat(diff: string): string | undefined {
	const insertions = (diff.match(/^\+ /gm) ?? []).length;
	const deletions = (diff.match(/^- /gm) ?? []).length;
	if (insertions === 0 && deletions === 0) return undefined;
	return `+${insertions}/-${deletions}`;
}

function countMetric(
	details: unknown,
	content: string,
	noun: "matches" | "files",
	emptyPattern: RegExp,
): string | undefined {
	const matched = numberField(record(details), "matched");
	if (matched !== undefined) {
		if (matched === 0) return `no ${noun}`;
		return countLabel(matched, noun);
	}
	if (emptyPattern.test(content)) return `no ${noun}`;

	const body = content.split("\n\n[")[0] ?? "";
	const count = body.split("\n").filter((line) => line.length > 0).length;
	if (count === 0) return undefined;
	return countLabel(count, noun);
}

function countLabel(count: number, noun: "matches" | "files"): string {
	const one = noun === "matches" ? "match" : "file";
	return `${count} ${count === 1 ? one : noun}`;
}

function listMetric(details: unknown, content: string): string | undefined {
	const total = numberField(record(details), "total");
	if (total !== undefined) return entryLabel(total);
	if (/ is empty$/.test(content)) return "empty";

	const lines = content.split("\n").filter((line) => line.length > 0 && !line.startsWith("… ("));
	return lines.length === 0 ? undefined : entryLabel(lines.length);
}

function entryLabel(count: number): string {
	if (count === 0) return "empty";
	return `${count} ${count === 1 ? "entry" : "entries"}`;
}

function subagentMetric(details: unknown): string | undefined {
	const steps = numberField(record(details), "steps");
	if (steps === undefined) return undefined;
	return `${steps} ${steps === 1 ? "step" : "steps"}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberField(recorded: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = recorded?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(recorded: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = recorded?.[key];
	return typeof value === "boolean" ? value : undefined;
}

function stringField(recorded: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = recorded?.[key];
	return typeof value === "string" ? value : undefined;
}
