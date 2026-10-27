import readline from "node:readline";

const MAX_TEXT_LENGTH = 32_000;
const server = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function result(id, value) { send({ jsonrpc: "2.0", id, result: value }); }
function rpcError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function requireText(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`${field} exceeds the 32,000 character limit.`);
  return value;
}

server.on("line", (line) => {
  if (!line.trim() || Buffer.byteLength(line) > 64_000) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request?.id === undefined) return;
  const id = request.id;
  const params = request.params ?? {};

  if (request.method === "initialize") {
    result(id, {
      protocolVersion: params.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "pi-apex-local-dev-helper", version: "1.0.0" },
      instructions: "Local deterministic text and JSON utilities. No network, filesystem, or credential access."
    });
    return;
  }
  if (request.method === "ping") { result(id, {}); return; }
  if (request.method === "tools/list") {
    result(id, { tools: [
      {
        name: "text_metrics",
        description: "Count characters, words, non-empty lines, and paragraphs in supplied text. Read-only and deterministic.",
        inputSchema: { type: "object", properties: { text: { type: "string", maxLength: MAX_TEXT_LENGTH } }, required: ["text"], additionalProperties: false }
      },
      {
        name: "format_json",
        description: "Validate and pretty-print a supplied JSON string. Does not read or write files.",
        inputSchema: { type: "object", properties: { json: { type: "string", maxLength: MAX_TEXT_LENGTH } }, required: ["json"], additionalProperties: false }
      }
    ] });
    return;
  }
  if (request.method === "tools/call") {
    const name = params.name;
    const args = params.arguments ?? {};
    try {
      if (name === "text_metrics") {
        const text = requireText(args.text, "text");
        const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
        const nonEmptyLines = text ? text.split(/\r?\n/u).filter((value) => value.trim()).length : 0;
        const paragraphs = text.trim() ? text.trim().split(/\n\s*\n/u).length : 0;
        const metrics = { characters: Array.from(text).length, words, nonEmptyLines, paragraphs };
        result(id, { content: [{ type: "text", text: JSON.stringify(metrics) }], structuredContent: metrics });
        return;
      }
      if (name === "format_json") {
        const input = requireText(args.json, "json");
        let value;
        try { value = JSON.parse(input); } catch { throw new Error("Input is not valid JSON."); }
        const formatted = JSON.stringify(value, null, 2);
        if (formatted.length > MAX_TEXT_LENGTH) throw new Error("Formatted JSON exceeds the 32,000 character limit.");
        result(id, { content: [{ type: "text", text: formatted }], structuredContent: { formatted } });
        return;
      }
      rpcError(id, -32601, "Unknown tool.");
    } catch (error) {
      result(id, { isError: true, content: [{ type: "text", text: String(error?.message ?? "Invalid tool input.").slice(0, 300) }] });
    }
    return;
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  rpcError(id, -32601, "Method not found.");
});
