import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { createSharedModelRuntime } from "../../src/core/ring0-session.ts";
import { createRing4Runtime } from "../../src/ring4/ring4-runtime.ts";
import { MissionControlServer } from "../../src/ring5/mission-control-server.ts";

function listSpills(spillRoot: string): string[] {
  return fs.readdirSync(spillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(spillRoot, entry.name)).map((file) => `${entry.name}/${file}`))
    .sort();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "apex-mcp-spill-session-"));
const workspaceRoot = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
fs.mkdirSync(workspaceRoot);
fs.mkdirSync(agentDir);
let runtime: Awaited<ReturnType<typeof createRing4Runtime>> | undefined;
let cockpit: MissionControlServer | undefined;
let pair: ReturnType<typeof createInMemoryTransportPair> | undefined;
let passed = false;
let cleanupError: unknown;
let releaseResponse!: () => void;
let released = false;
let pendingSend: Promise<void> | undefined;

try {
  const faux = fauxProvider();
  const modelRuntime = await createSharedModelRuntime(agentDir);
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "synthetic-mcp-key");
  runtime = await createRing4Runtime({ workspaceRoot, agentDir, surfacesDir: path.resolve("surfaces"), allowUnsandboxedDev: true, modelRuntime, model: faux.getModel() });
  const harness = runtime.getCurrentHarness();
  cockpit = new MissionControlServer({ controller: runtime, workspaceRoot, host: "127.0.0.1", port: 0, requireAuth: false });
  const info = await cockpit.start();
  pair = createInMemoryTransportPair();
  const server = pair.server;
  let observedRequest!: () => void;
  const requestObserved = new Promise<void>((resolve) => { observedRequest = resolve; });
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let sendError: unknown;
  const body = ["MCP_SPILL_BEGIN", ...Array.from({ length: 120 }, (_, i) => `line-${i}:${"x".repeat(400)}`), "sk-proj-12345678901234567890", "MCP_SPILL_END"].join("\n");
  server.onMessage((message: any) => {
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      void server.send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "spill-test", version: "1" } } });
    } else if (message.method === "tools/list") {
      void server.send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "large_output", description: "Return synthetic output", inputSchema: { type: "object" } }] } });
    } else if (message.method === "tools/call") {
      const reply = { jsonrpc: "2.0" as const, id: message.id, result: { content: [{ type: "text" as const, text: body }] } };
      if (message.params?.arguments?.delay === true) {
        pendingSend = release.then(async () => { try { await server.send(reply); } catch (error) { sendError = error; } });
        observedRequest();
      } else void server.send(reply);
    }
  });
  await server.start();
  await harness.mcpHub.connectWithTransport({ name: "spill-test", transport: pair.client, transportKind: "in-memory" });
  const sessionId = harness.session.sessionManager.getSessionId();
  const deferred = harness.session.extensionRunner?.getToolDefinition("mcp_hub");
  const read = harness.session.agent.state.tools.find((tool) => tool.name === "read");
  assert.ok(deferred && read);
  const invoke = deferred.execute as (...args: any[]) => Promise<any>;
  const result = await invoke("call-not-session-id", { action: "call_tool", serverName: "spill-test", toolName: "large_output" }, new AbortController().signal, () => {});
  const spillPath = (result.content[0]?.text as string).match(/-> (.+)\]/)?.[1];
  assert.ok(spillPath, "Oversized MCP output must produce a spill notice");
  const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  assert.ok(spillPath.includes(`/session-${hash}/`), "MCP spill must use the initiating session");
  const stored = fs.readFileSync(spillPath, "utf8");
  assert.match(stored, /MCP_SPILL_END/);
  assert.match(stored, /\[REDACTED:OPENAI_KEY\]/);
  assert.doesNotMatch(stored, /sk-proj-12345678901234567890/, "Raw spill bytes must already be scrubbed");
  const readResult = await read.execute("read-own-mcp-spill", { path: spillPath, offset: 112, limit: 20 }, new AbortController().signal, () => {});
  assert.match(JSON.stringify(readResult), /MCP_SPILL_END/);
  assert.doesNotMatch(JSON.stringify(readResult), /sk-proj-12345678901234567890/);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp_hub", limit: 3 })]),
    fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.mcp_hub({action:'call_tool',serverName:'spill-test',toolName:'large_output'});" }, { id: "mcp-through-codemode" })]),
    fauxAssistantMessage("done")
  ]);
  await harness.session.prompt("Call the synthetic MCP tool through codemode.");
  const transcript = JSON.stringify(harness.session.state.messages);
  assert.match(transcript, /OUTPUT SPILLED TO DISK/);
  assert.ok(transcript.includes(`/session-${hash}/`), "The live codemode path must retain the active-session spill");
  assert.doesNotMatch(transcript, /sk-proj-12345678901234567890/);

  const beforeUnbound = listSpills(harness.spillStore.rootDir);
  const unbound = await harness.mcpHub.callTool({ serverName: "spill-test", toolName: "large_output", toolCallId: "no-session" });
  const fallback = unbound.content[0]?.type === "text" ? unbound.content[0].text : "";
  assert.match(fallback, /spill unavailable: SESSION_IDENTITY_REQUIRED/);
  assert.ok(Buffer.byteLength(fallback) <= harness.spillStore.maxInlineBytes);
  assert.doesNotMatch(fallback, /sk-proj-12345678901234567890|\.harness[\\/]spill[\\/]session-/);
  assert.deepEqual(listSpills(harness.spillStore.rootDir), beforeUnbound, "An identity-less call must not create a spill");

  const response = await fetch(`http://127.0.0.1:${info.port}/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "call_tool", serverName: "spill-test", toolName: "large_output" }) });
  assert.equal(response.status, 200);
  const cockpitResult = await response.json() as { content: Array<{ text?: string }> };
  const cockpitPath = cockpitResult.content[0]?.text?.match(/-> (.+)\]/)?.[1];
  assert.ok(cockpitPath?.includes(`/session-${hash}/`), "Cockpit spill must use the active session");
  await read.execute("read-cockpit-spill", { path: cockpitPath, offset: 112, limit: 20 }, new AbortController().signal, () => {});

  const spillRoot = harness.spillStore.rootDir;
  const before = listSpills(spillRoot);
  const inFlight = invoke("delayed-before-switch", { action: "call_tool", serverName: "spill-test", toolName: "large_output", args: { delay: true } }, new AbortController().signal, () => {}).then((value) => ({ value }), (error) => ({ error }));
  await Promise.race([requestObserved, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MCP delayed request not observed")), 10_000).unref())]);
  await runtime.runtimeHost.newSession();
  const next = runtime.getCurrentHarness();
  assert.notEqual(next.session.sessionManager.getSessionId(), sessionId);
  releaseResponse();
  released = true;
  assert.ok(pendingSend);
  await pendingSend;
  const outcome = await inFlight;
  assert.ok("error" in outcome, "A session switch must reject the in-flight call");
  assert.equal(outcome.error?.name, "McpConnectionClosedError", "A session switch must cancel the in-flight call");
  assert.equal((sendError as Error | undefined)?.name, "McpConnectionClosedError");
  assert.deepEqual(listSpills(spillRoot), before, "A cancelled call must not create a spill in either session");
  const nextRead = next.session.agent.state.tools.find((tool) => tool.name === "read");
  assert.ok(nextRead);
  await assert.rejects(() => nextRead.execute("read-old-mcp-spill", { path: spillPath }, new AbortController().signal, () => {}), /cross-session spill read denied/);
  passed = true;
} finally {
  if (releaseResponse && !released) releaseResponse();
  if (pendingSend) await pendingSend.catch((error) => { cleanupError ??= error; });
  if (pair) await pair.server.close().catch((error) => { cleanupError ??= error; });
  if (cockpit) await cockpit.stop().catch((error) => { cleanupError ??= error; });
  if (runtime) await runtime.dispose().catch((error) => { cleanupError ??= error; });
  if (passed && !cleanupError) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`[FAIL] Synthetic MCP fixture retained: ${root}`);
}
if (cleanupError) throw cleanupError;
console.log("MCP session-bound spills and in-flight cancellation: PASS");
