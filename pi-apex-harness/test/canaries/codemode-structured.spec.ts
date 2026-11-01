import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRing0Harness, createSharedModelRuntime } from "../../src/core/ring0-session.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-structured-tool-"));
execFileSync("git", ["init", "-q"], { cwd: ws });
const faux = fauxProvider();
const runtime = await createSharedModelRuntime(path.join(ws, ".harness", "agent"));
runtime.registerNativeProvider(faux.provider);
await runtime.setRuntimeApiKey(faux.provider.id, "faux-key");
const h = await createRing0Harness({
  workspaceRoot: ws,
  surfacesDir: path.resolve("surfaces"),
  agentDir: path.join(ws, ".harness", "agent"),
  modelRuntime: runtime,
  model: faux.getModel(),
  sandboxMode: "workspace-write",
  allowUnsandboxedDev: true
});
try {
  const bash = h.session.agent.state.tools.find((tool) => tool.name === "bash");
  const read = h.session.agent.state.tools.find((tool) => tool.name === "read");
  assert.ok(bash && read);
  const syntheticSecret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV";
  const command = `printf x >> effect-count; printf '%s\\n' '${syntheticSecret}'`;
  const executeBash = () => bash.execute("structured-bash", { command }, new AbortController().signal, () => {});
  const first = await executeBash();
  const structured = (first as any).structuredContent;
  assert.equal(typeof structured, "object", "The live bash tool must provide codemode's structured output");
  assert.equal(structured.exit_code, 0);
  assert.equal(typeof structured.wall_time_seconds, "number");
  assert.equal(typeof structured.truncated, "boolean");
  assert.match(structured.output, /\[REDACTED:OPENAI_KEY\]/);
  assert.ok(!JSON.stringify(first).includes(syntheticSecret), "Structured output must not bypass secret scrubbing");
  const replay = await executeBash();
  assert.deepEqual((replay as any).structuredContent, structured, "Cached replay must preserve structured fields");
  assert.equal(fs.readFileSync(path.join(ws, "effect-count"), "utf8"), "x", "Replay must not repeat the effect");

  fs.writeFileSync(path.join(ws, "document.txt"), `document ${syntheticSecret}\n`);
  const readResult = await read.execute("structured-read", { path: "document.txt" }, new AbortController().signal, () => {});
  assert.equal(typeof (readResult as any).structuredContent, "string", "The live read tool must provide codemode's text output");
  assert.match((readResult as any).structuredContent, /\[REDACTED:OPENAI_KEY\]/);
  assert.ok(!JSON.stringify(readResult).includes(syntheticSecret));
  fs.writeFileSync(path.join(ws, ".env"), "SYNTHETIC=private\n");
  await assert.rejects(
    () => read.execute("structured-secret", { path: ".env" }, new AbortController().signal, () => {}),
    /secret file access denied/,
    "Image detection must not bypass the confined reader"
  );

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  fs.writeFileSync(path.join(ws, "image.png"), Buffer.from(png, "base64"));
  const imageResult = await read.execute("structured-image", { path: "image.png" }, new AbortController().signal, () => {});
  assert.equal((imageResult as any).structuredContent?.type, "image");
  assert.equal((imageResult as any).structuredContent?.data, png);
  assert.equal((imageResult as any).structuredContent?.mimeType, "image/png");

  const large = await bash.execute("structured-large", { command: "python3 -c 'print(\"x\" * 50000)'" }, new AbortController().signal, () => {});
  const largeStructured = (large as any).structuredContent;
  assert.equal(largeStructured.truncated, true, "WAL output limits must be reflected in structured results");
  assert.ok(Buffer.byteLength(largeStructured.output, "utf8") < 8192, "Structured output must not bypass the WAL budget");
  assert.match(largeStructured.output, /OUTPUT SPILLED TO DISK|OUTPUT_STREAM_OVERFLOW/, "Any omitted output must be explicit");

  const failure = await bash.execute("structured-nonzero", { command: "printf nonzero; exit 7" }, new AbortController().signal, () => {});
  assert.equal((failure as any).structuredContent?.exit_code, 7, "Non-zero bash exits must retain their structured status");
  assert.equal(failure.isError, true);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code: "const b = await tools.bash({command: 'printf codemode_ok'}); const r = await tools.read({path: 'document.txt'}); return { output: b.output, exit_code: b.exit_code, read: r };" }, { id: "codemode_structured" })]),
    fauxAssistantMessage("done")
  ]);
  await h.session.prompt("Exercise structured codemode outputs");
  const codemodeResult = h.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "codemode_structured");
  const codemodeText = JSON.stringify(codemodeResult);
  assert.match(codemodeText, /codemode_ok/);
  assert.match(codemodeText, /REDACTED:OPENAI_KEY/);
  assert.ok(!codemodeText.includes(syntheticSecret));
  console.log("Codemode structured tool results, replay and redaction: PASS");
} finally {
  h.dispose();
  fs.rmSync(ws, { recursive: true, force: true });
}
