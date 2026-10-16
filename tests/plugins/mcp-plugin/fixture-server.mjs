// 供测试用的最小 MCP server：按行读 JSON-RPC，按行写回。
//
// 故意做两件「不老实」的事，用来钉住客户端的容忍度：
//   - 往标准错误写日志（协议要求日志走这里，客户端不该因此断开）
//   - 在回音之前往标准输出夹一行不是 JSON 的东西（客户端该跳过而不是把整条连接作废）
import { createInterface } from "node:readline";

process.stderr.write("fixture server 起来了\n");

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
	const text = line.trim();
	if (text.length === 0) return;

	let message;
	try {
		message = JSON.parse(text);
	} catch {
		return;
	}
	// 通知不回
	if (message.id === undefined) return;

	process.stdout.write("这行不是 JSON\n");
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: reply(message) })}\n`);
});

function reply(message) {
	switch (message.method) {
		case "initialize":
			return {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1" },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: "echo",
						description: "把话原样说回来",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
					{
						name: "fail",
						description: "总是失败",
						inputSchema: { type: "object", properties: {} },
					},
				],
			};
		case "tools/call":
			if (message.params.name === "fail") {
				return { content: [{ type: "text", text: "远端说做不了" }], isError: true };
			}
			return {
				content: [
					{ type: "text", text: `回声：${message.params.arguments.text}` },
					{ type: "image", data: "x", mimeType: "image/png" },
				],
			};
		default:
			return {};
	}
}
