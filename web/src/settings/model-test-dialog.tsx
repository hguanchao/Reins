import { CircleAlert, CircleCheck } from "lucide-react";
import type { ReactElement } from "react";

import { Dialog } from "../components/ui/index.ts";
import type { ProviderTestResult } from "../protocol.ts";

/** 一次测试的状态：请求进行中，或已经拿到结果。 */
export interface ModelTestState {
	readonly status: "running" | "done";
	readonly result?: ProviderTestResult;
}

/**
 * 测试模型。
 *
 * 只负责把结果摆出来：发出请求的是服务端，用的是表单里当前填的值——不必先保存再验证。
 */
export function ModelTestDialog({
	name,
	state,
	onClose,
	onRetry,
}: {
	readonly name: string;
	readonly state: ModelTestState;
	onClose(): void;
	onRetry(): void;
}): ReactElement {
	const running = state.status === "running";
	const result = state.result;
	const ok = result?.ok === true;
	return (
		<Dialog
			open
			onClose={onClose}
			title="测试模型"
			footer={
				<>
					<button type="button" className="b b-line" onClick={onClose}>
						关闭
					</button>
					<button type="button" className="b b-solid" disabled={running} onClick={onRetry}>
						{running ? "测试中…" : "重新测试"}
					</button>
				</>
			}
		>
			<div className="mt-row">
				<span className="k">模型</span>
				<span className="v mono">{name}</span>
			</div>
			{running ? (
				<p className="form-hint">正在发送一次最小请求，最多等 20 秒。</p>
			) : (
				<>
					<div className="mt-result" data-ok={ok}>
						{ok ? <CircleCheck className="ic ic-14" /> : <CircleAlert className="ic ic-14" />}
						<span>{ok ? "连接正常" : "测试失败"}</span>
						{result?.ms === undefined ? null : <span className="ms">{result.ms} ms</span>}
					</div>
					{ok ? (
						<p className="form-hint">
							应答模型：{result?.model ?? "—"}
							{result?.text === undefined || result.text.length === 0 ? "" : ` · 回复：${result.text.slice(0, 80)}`}
						</p>
					) : (
						<p className="form-error">{result?.error ?? "没有拿到结果"}</p>
					)}
				</>
			)}
		</Dialog>
	);
}
