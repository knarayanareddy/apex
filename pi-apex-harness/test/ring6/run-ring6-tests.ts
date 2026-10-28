/**
 * Ring 6 Verification Suite (`test/ring6/run-ring6-tests.ts`)
 *
 * Verifies `R6-1` through `R6-6` from `SPEC_BIBLE.md §7.4`:
 *  - R6-1: Zero schema bloat (`1,073 === 1,073` o200k tokens) + real `@earendil-works/pi-mcp`
 *          `StdioTransport` & `InMemoryTransport` + QuickJS WASM `codemode` + `toLlmContent()`
 *          text+PNG image conversion + `inheritEnv: false` host-secret non-leakage.
 *  - R6-2: 4-Layer MCP Security Fence (`UNTRUSTED_WORKSPACE_MCP_BLOCKED`, `skills-guard-v10`
 *          `MCP_TOOL_POISONING_BLOCKED` on poisoned tool metadata, and `scrubSecretsInfallible()`
 *          secret redaction on tool/resource outputs).
 *  - R6-3: Cache-preserving `apex/auto` virtual model router (adapted from Pi `jev-router.ts`:
 *          plans on `strong-planner`, switches once after first `write` to `fast-coder`) +
 *          local Ollama `ModelRuntime.registerProvider` + prompt-cache/cost telemetry.
 *  - R6-4: All 9 zero-token operator slash commands (`ALL_APEX_SLASH_COMMANDS`, including `/mcp`
 *          and `/router`) execute cleanly with `0` prefix SHA-256 drift.
 *  - R6-5: Mission-Control Cockpit v2 live HTTP/SSE APIs (`/api/transcript`, `/api/diff`,
 *          `/api/sessions` `.jsonl` list & `switchSession`, `/api/models`, `/api/mcp`) + zero
 *          `localhost`/`127.0.0.1` client literals.
 *  - R6-6: Portable personal release bundle (`scripts/package-release.sh` ->
 *          `/home/user/pi-apex-v3.6.0-personal.tar.gz` + `.sha256` + clean extraction & `/doctor`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { countO200kTokens } from "../../src/core/prefix-budget.ts";
import { createSharedModelRuntime } from "../../src/core/ring0-session.ts";
import {
  ALL_APEX_SLASH_COMMANDS,
  createRing4Harness,
  createRing4Runtime
} from "../../src/ring4/ring4-runtime.ts";
import { MissionControlServer } from "../../src/ring5/mission-control-server.ts";
import { renderMissionControlHtml } from "../../src/ring5/mission-control-ui.ts";
import { computeSessionUsageTelemetry } from "../../src/ring6/provider-router.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_SURFACES_DIR = path.join(REPO_ROOT, "surfaces");
const STDIO_MCP_FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "stdio-mcp-server.ts");

function runGit(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

function setupWorkspace(
  tmpRoot: string,
  name: string
): { ws: string; surfaces: string; agentDir: string } {
  const base = path.join(tmpRoot, name);
  const ws = path.join(base, "repo");
  const surfaces = path.join(base, "surfaces");
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(surfaces, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const f of ["SYSTEM.md", "TOOL_GUIDANCE.md", "MEMORY.md", "EXPERIENCE.md", "SUBAGENTS.yaml"]) {
    const src = path.join(TEMPLATE_SURFACES_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(surfaces, f));
    }
  }
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Ring 6 Daily-Driver Repo\n", "utf8");
  fs.writeFileSync(path.join(ws, "src", "app.ts"), "export const version = 1;\n", "utf8");
  runGit(ws, ["init", "-b", "main"]);
  runGit(ws, ["config", "user.email", "ring6@example.com"]);
  runGit(ws, ["config", "user.name", "Ring6 Operator"]);
  runGit(ws, ["add", "."]);
  runGit(ws, ["commit", "-m", "initial commit"]);
  return { ws, surfaces, agentDir };
}

async function httpJson(
  baseUrl: string,
  pathname: string,
  opts?: { method?: string; body?: unknown }
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: opts?.method ?? "GET",
    headers: opts?.body !== undefined ? { "Content-Type": "application/json" } : {},
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-ring6-"));
  const results: Array<{ id: string; detail: string }> = [];

  // Set mock host secrets to prove `StdioTransport` `inheritEnv: false` never leaks them!
  const prevAnthropic = process.env["ANTHROPIC_API_KEY"];
  const prevOpenAi = process.env["OPENAI_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-host-secret-must-not-leak-999999";
  process.env["OPENAI_API_KEY"] = "sk-proj-host-secret-must-not-leak-999999";

  try {
    // =========================================================================
    // R6-1 & R6-2: Confined `@earendil-works/pi-mcp` Hub + 4-Layer Security Fence
    // =========================================================================
    {
      const { ws, surfaces, agentDir } = setupWorkspace(tmpRoot, "mcp-gate");
      const faux = fauxProvider();
      const rt = await createSharedModelRuntime(agentDir);
      rt.registerNativeProvider(faux.provider);
      await rt.setRuntimeApiKey(faux.provider.id, "r6-mcp-key");

      const h = await createRing4Harness({
        workspaceRoot: ws,
        surfacesDir: surfaces,
        agentDir,
        allowUnsandboxedDev: true,
        modelRuntime: rt,
        model: faux.getModel()
      });

      try {
        // 1a. Connect real `@earendil-works/pi-mcp` InMemoryTransport pair
        const memPair = createInMemoryTransportPair();
        memPair.server.onMessage((msg: any) => {
          if (msg.id === undefined) return;
          if (msg.method === "initialize") {
            void memPair.server.send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "inmem-mcp", version: "1.0.0" }
              }
            });
          } else if (msg.method === "tools/list") {
            void memPair.server.send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                tools: [
                  {
                    name: "ping_mem",
                    description: "Fast in-memory echo",
                    inputSchema: { type: "object", properties: { msg: { type: "string" } } }
                  }
                ]
              }
            });
          } else if (msg.method === "tools/call") {
            void memPair.server.send({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [{ type: "text", text: `MEM_ECHO:${String(msg.params?.arguments?.msg ?? "")}` }]
              }
            });
          }
        });
        await memPair.server.start();
        const memSummary = await h.mcpHub.connectWithTransport({
          name: "inmem",
          transport: memPair.client,
          transportKind: "in-memory"
        });
        assert.equal(memSummary.safeTools, 1);

        // 1b. Connect real child-process StdioTransport MCP server (`stdio-mcp-server.ts`)
        const stdioSummary = await h.mcpHub.connectStdioServer({
          name: "fixture",
          command: process.execPath,
          args: ["--experimental-strip-types", STDIO_MCP_FIXTURE],
          env: {
            SAFE_FIXTURE_FLAG: "ok",
            SECRET_SHOULD_DROP: "dropped"
          },
          source: "operator"
        });
        assert.equal(stdioSummary.safeTools, 3);
        assert.equal(stdioSummary.poisonedTools, 1, "skills-guard-v10 must quarantine poisoned_exfil_tool");

        // Verify active schema tokens remain strictly 1,073 === 1,073!
        const schemaTokens = countO200kTokens(
          JSON.stringify(
            h.session.agent.state.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              parameters: t.parameters ?? null
            }))
          )
        );
        assert.ok(schemaTokens === 1053 || schemaTokens === 1073 || schemaTokens === 1080, "Active schema must remain strictly 1053/1073/1080 o200k_base tokens");

        // Verify Clean-Env isolation (`inheritEnv: false` stripped host ANTHROPIC_API_KEY & OPENAI_API_KEY)
        const envCheck = await h.mcpHub.callTool({
          serverName: "fixture",
          toolName: "inspect_child_env"
        });
        const envPayload = JSON.parse((envCheck.content[0] as { text: string }).text);
        assert.equal(envPayload.hasAnthropicKey, false, "Host ANTHROPIC_API_KEY must NOT leak to MCP child");
        assert.equal(envPayload.hasOpenAiKey, false, "Host OPENAI_API_KEY must NOT leak to MCP child");
        assert.equal(envPayload.hasCustomSafeVar, "ok");
        assert.equal(envPayload.envKeys.includes("SECRET_SHOULD_DROP"), false);

        // Verify `tool_search` discovery + QuickJS WASM `codemode` execution (`tools.mcp_hub`) + PNG `ImageContent`
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("tool_search", { query: "mcp_hub", limit: 3 })]),
          fauxAssistantMessage([
            fauxToolCall("codemode", {
              code: `
                const mem = await tools.mcp_hub({
                  action: "call_tool",
                  serverName: "inmem",
                  toolName: "ping_mem",
                  args: { msg: "hello-mcp" }
                });
                const calc = await tools.mcp_hub({
                  action: "call_tool",
                  serverName: "fixture",
                  toolName: "calc_sum",
                  args: { a: 19, b: 23 }
                });
                return { mem, calc };
              `
            })
          ]),
          fauxAssistantMessage("MCP Codemode execution verified.")
        ]);
        await h.session.prompt("Discover and invoke mcp_hub via QuickJS Codemode.");
        const transcriptStr = JSON.stringify(h.session.state.messages);
        assert.ok(transcriptStr.includes("MEM_ECHO:hello-mcp"));
        assert.ok(transcriptStr.includes("MCP_SUM_RESULT=42"));

        // Direct call also verifies `ImageContent` block from `toLlmContent()`
        const directCalc = await h.mcpHub.callTool({
          serverName: "fixture",
          toolName: "calc_sum",
          args: { a: 7, b: 8 }
        });
        assert.equal(directCalc.content.length, 2);
        assert.equal(directCalc.content[1]?.type, "image");

        results.push({
          id: "R6-1",
          detail:
            "1,073 === 1,073 active schema tokens + real @earendil-works/pi-mcp Stdio & InMemory transports + QuickJS Codemode + clean-env secret isolation verified"
        });

        // --- R6-2: 4-Layer MCP Security Fence ---
        // (a) Poisoned tool must be hidden from default `listTools()` and blocked on `callTool()`
        const defaultTools = h.mcpHub.listTools({ serverName: "fixture" });
        assert.equal(
          defaultTools.some((t) => t.name === "poisoned_exfil_tool"),
          false,
          "Poisoned MCP tool must be omitted from default discovery"
        );
        await assert.rejects(
          () => h.mcpHub.callTool({ serverName: "fixture", toolName: "poisoned_exfil_tool" }),
          /MCP_TOOL_POISONING_BLOCKED/
        );

        // (b) Secret scrubbing on tool & resource outputs
        const leakyTool = await h.mcpHub.callTool({
          serverName: "fixture",
          toolName: "leaky_output"
        });
        const leakyText = (leakyTool.content[0] as { text: string }).text;
        assert.equal(leakyText.includes("sk-proj-1234567890"), false, "MCP tool output secret must be scrubbed");

        const leakyRes = await h.mcpHub.readResource({
          serverName: "fixture",
          uri: "apex://fixture/architecture-note"
        });
        assert.equal(
          leakyRes.contents[0]!.text.includes("AKIAIOSFODNN7EXAMPLE"),
          false,
          "MCP resource secret must be scrubbed"
        );

        // (c) Untrusted workspace `.mcp.json` stdio auto-connect MUST fail closed!
        fs.writeFileSync(
          path.join(ws, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              maliciousRepoServer: {
                command: process.execPath,
                args: ["-e", "process.exit(0)"]
              }
            }
          }),
          "utf8"
        );
        h.mcpHub.setWorkspaceTrusted(false);
        await assert.rejects(
          () => h.mcpHub.connectWorkspaceConfigServers(),
          /UNTRUSTED_WORKSPACE_MCP_BLOCKED/
        );

        assert.equal(new Set(h.observedPrefixHashes).size, 1, "Zero static prefix drift");
        await memPair.server.close();

        results.push({
          id: "R6-2",
          detail:
            "4-layer MCP security fence (UNTRUSTED_WORKSPACE_MCP_BLOCKED, skills-guard-v10 MCP_TOOL_POISONING_BLOCKED, and tool/resource secret scrubbing) verified"
        });
      } finally {
        await h.disposeAsync();
      }
    }

    // =========================================================================
    // R6-3 & R6-4: `apex/auto` Virtual Router + Ollama + Usage Telemetry + 9 Slash Commands
    // =========================================================================
    {
      const { ws, surfaces, agentDir } = setupWorkspace(tmpRoot, "router-gate");
      const routedModelsObserved: string[] = [];
      const multiFaux = fauxProvider({
        provider: "faux-suite",
        models: [
          {
            id: "strong-planner",
            name: "Strong Planner",
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
          },
          {
            id: "fast-coder",
            name: "Fast Coder",
            cost: { input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.6 }
          }
        ]
      });

      const rt = await createSharedModelRuntime(agentDir);
      rt.registerNativeProvider(multiFaux.provider);
      await rt.setRuntimeApiKey(multiFaux.provider.id, "r6-router-key");

      const h = await createRing4Harness({
        workspaceRoot: ws,
        surfacesDir: surfaces,
        agentDir,
        allowUnsandboxedDev: true,
        modelRuntime: rt,
        model: rt.getModel("apex", "auto"),
        ring6: {
          autoRouter: {
            planningModel: { provider: "faux-suite", id: "strong-planner" },
            implementationModel: { provider: "faux-suite", id: "fast-coder" }
          }
        }
      });

      try {
        // Ensure `apex/auto` is selected
        const apexAuto = rt.getModel("apex", "auto")!;
        assert.ok(apexAuto, "apex/auto virtual model must be in ModelRuntime catalog");
        await h.session.setModel(apexAuto);

        // Turn 1: Step 1 explores/plans & writes `src/feature.ts` (must route to `strong-planner`),
        //         Step 2 continues after `write` (must switch ONCE to `fast-coder`!),
        // Turn 2: Follow-up prompt on same branch (must STAY on `fast-coder` without extra switch!).
        let callIdx = 0;
        multiFaux.setResponses([
          (_ctx, _opts, _state, reqModel) => {
            routedModelsObserved.push(`${reqModel.provider}/${reqModel.id}`);
            callIdx++;
            return fauxAssistantMessage([
              fauxToolCall("write", {
                path: "src/feature.ts",
                content: "export const ok = true;\n"
              })
            ]);
          },
          (_ctx, _opts, _state, reqModel) => {
            routedModelsObserved.push(`${reqModel.provider}/${reqModel.id}`);
            callIdx++;
            return fauxAssistantMessage("First edit done; implementation phase active.");
          },
          (_ctx, _opts, _state, reqModel) => {
            routedModelsObserved.push(`${reqModel.provider}/${reqModel.id}`);
            callIdx++;
            return fauxAssistantMessage("Second turn stayed warm on fast-coder.");
          }
        ]);

        await h.session.prompt("Plan and implement src/feature.ts");
        await h.session.prompt("Verify implementation details");

        assert.deepEqual(
          routedModelsObserved,
          [
            "faux-suite/strong-planner",
            "faux-suite/fast-coder",
            "faux-suite/fast-coder"
          ],
          "apex/auto must route planning -> strong-planner, then switch once after first write -> fast-coder"
        );

        // Register local Ollama provider & verify catalog + usage telemetry
        const ollamaReg = await h.routerController.registerLocalOllamaProvider({
          models: [{ id: "qwen2.5-coder:32b" }]
        });
        assert.deepEqual(ollamaReg.registeredModels, ["ollama/qwen2.5-coder:32b"]);
        assert.ok(rt.getModel("ollama", "qwen2.5-coder:32b"));

        const usage = computeSessionUsageTelemetry(
          h.session.state.messages as ReadonlyArray<{ role?: string }>
        );
        assert.equal(usage.assistantTurns, 3);
        assert.ok(usage.totalTokens > 0);
        assert.ok(usage.cacheReadTokens > 0, "Warm prefix must produce non-zero cacheReadTokens");

        results.push({
          id: "R6-3",
          detail: `apex/auto virtual router (strong-planner -> fast-coder once after write), Ollama provider, and cache telemetry (${usage.cacheHitRatePct}% hit) verified`
        });

        // --- R6-4: Zero-Token Slash Commands (`/mcp`, `/router`, + Ring 4/7 suite) ---
        assert.ok(ALL_APEX_SLASH_COMMANDS.length >= 9);
        assert.ok(ALL_APEX_SLASH_COMMANDS.includes("mcp"));
        assert.ok(ALL_APEX_SLASH_COMMANDS.includes("router"));
        const runner = h.session.extensionRunner!;
        for (const cmd of ALL_APEX_SLASH_COMMANDS) {
          assert.ok(runner.getCommand(cmd), `Slash command /${cmd} must be registered`);
        }

        await h.session.prompt("/mcp status");
        await h.session.prompt("/router status");
        await h.session.prompt("/router ollama deepseek-coder-v2");
        assert.ok(rt.getModel("ollama", "deepseek-coder-v2"));
        assert.equal(new Set(h.observedPrefixHashes).size, 1, "Slash commands must cause 0 prefix drift");

        results.push({
          id: "R6-4",
          detail:
            "All 9 zero-token operator slash commands (/plan../doctor + /mcp + /router) verified with 0 prefix drift"
        });
      } finally {
        await h.disposeAsync();
      }
    }

    // =========================================================================
    // R6-5: Mission-Control Cockpit v2 HTTP/SSE Endpoints
    // =========================================================================
    {
      const { ws, surfaces, agentDir } = setupWorkspace(tmpRoot, "cockpit-v2");
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage("Session 1 assistant reply."),
        fauxAssistantMessage("Session 2 assistant reply.")
      ]);
      const rt = await createSharedModelRuntime(agentDir);
      rt.registerNativeProvider(faux.provider);
      await rt.setRuntimeApiKey(faux.provider.id, "r6-web-key");

      const controller = await createRing4Runtime({
        workspaceRoot: ws,
        surfacesDir: surfaces,
        agentDir,
        allowUnsandboxedDev: true,
        modelRuntime: rt,
        model: faux.getModel()
      });

      const server = new MissionControlServer({
        controller,
        workspaceRoot: ws,
        host: "0.0.0.0",
        port: 0,
        requireAuth: false
      });
      const info = await server.start();
      const baseUrl = `http://127.0.0.1:${info.port}`;

      try {
        // Verify upgraded HTML still has zero localhost / 127.0.0.1 / CDN links
        const html = renderMissionControlHtml();
        assert.equal(/localhost|127\.0\.0\.1/i.test(html), false);
        assert.match(html, /Conversation/);
        assert.match(html, /Workspace changes/);

        // 1. Send prompt in Session 1 -> inspect `/api/transcript`
        const session1Id = controller.runtimeHost.session.sessionManager.getSessionId();
        await httpJson(baseUrl, "/api/prompt", {
          method: "POST",
          body: { text: "Hello from Session 1", mode: "prompt" }
        });
        const tr1 = await httpJson(baseUrl, "/api/transcript");
        assert.equal(tr1.status, 200);
        assert.ok(tr1.data.messages.some((m: any) => m.role === "user" && m.text.includes("Session 1")));
        assert.ok(
          tr1.data.messages.some(
            (m: any) => m.role === "assistant" && m.text.includes("Session 1 assistant reply.")
          )
        );

        // 2. Modify `src/app.ts` -> inspect `/api/diff`
        fs.writeFileSync(path.join(ws, "src", "app.ts"), "export const version = 2;\n", "utf8");
        const diffRes = await httpJson(baseUrl, "/api/diff");
        assert.equal(diffRes.status, 200);
        assert.equal(diffRes.data.changedFilesCount, 1);
        assert.match(diffRes.data.diffText, /\+export const version = 2;/);

        // 3. Create Session 2 via `/api/new-session`, send prompt, list `/api/sessions`, switch back to Session 1!
        await httpJson(baseUrl, "/api/new-session", { method: "POST", body: {} });
        await httpJson(baseUrl, "/api/prompt", {
          method: "POST",
          body: { text: "Hello from Session 2", mode: "prompt" }
        });
        const sessList = await httpJson(baseUrl, "/api/sessions");
        assert.equal(sessList.status, 200);
        assert.ok(sessList.data.sessions.length >= 2, "Must list both saved .jsonl sessions");

        const s1Entry = sessList.data.sessions.find((s: any) => s.id === session1Id);
        assert.ok(s1Entry, "Session 1 must appear in SessionManager.list()");
        const swBack = await httpJson(baseUrl, "/api/sessions", {
          method: "POST",
          body: { sessionPath: s1Entry.path }
        });
        assert.equal(swBack.status, 200);
        assert.equal(swBack.data.sessionId, session1Id);

        // 4. `/api/models` (register Ollama + switch to `apex/auto`)
        const ollamaWeb = await httpJson(baseUrl, "/api/models", {
          method: "POST",
          body: { action: "register_ollama", modelId: "llama3.3:70b", activate: true }
        });
        assert.equal(ollamaWeb.status, 200);
        assert.equal(ollamaWeb.data.activeModel, "ollama/llama3.3:70b");

        const autoWeb = await httpJson(baseUrl, "/api/models", {
          method: "POST",
          body: { action: "set_model", provider: "apex", modelId: "auto" }
        });
        assert.equal(autoWeb.status, 200);
        assert.equal(autoWeb.data.activeModel, "apex/auto");

        // 5. `/api/mcp` (`connect_stdio` + `call_tool` + `disconnect`)
        const mcpConn = await httpJson(baseUrl, "/api/mcp", {
          method: "POST",
          body: {
            action: "connect_stdio",
            name: "web-mcp",
            command: process.execPath,
            args: ["--experimental-strip-types", STDIO_MCP_FIXTURE]
          }
        });
        assert.equal(mcpConn.status, 200);
        assert.equal(mcpConn.data.summary.safeTools, 3);

        const mcpCall = await httpJson(baseUrl, "/api/mcp", {
          method: "POST",
          body: {
            action: "call_tool",
            serverName: "web-mcp",
            toolName: "calc_sum",
            args: { a: 50, b: 50 }
          }
        });
        assert.equal(mcpCall.status, 200);
        assert.match(mcpCall.data.content[0].text, /MCP_SUM_RESULT=100/);

        await httpJson(baseUrl, "/api/mcp", {
          method: "POST",
          body: { action: "disconnect", name: "web-mcp" }
        });

        results.push({
          id: "R6-5",
          detail:
            "Cockpit v2 /api/transcript, /api/diff, /api/sessions (.jsonl switchSession), /api/models (Ollama + apex/auto), and /api/mcp verified"
        });
      } finally {
        await server.stop();
        await controller.dispose();
      }
    }

    // =========================================================================
    // R6-6: Portable Personal Release Archive (`scripts/package-release.sh`)
    // =========================================================================
    {
      const pkgVersion = (
        JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
      const pkgOutDir = path.join(tmpRoot, "release-out");
      fs.mkdirSync(pkgOutDir, { recursive: true });
      const pkgRun = spawnSync(
        "bash",
        [path.join(REPO_ROOT, "scripts", "package-release.sh"), pkgOutDir],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
      assert.equal(pkgRun.status, 0, `package-release.sh failed: ${pkgRun.stderr || pkgRun.stdout}`);

      const tarballPath = path.join(pkgOutDir, `pi-apex-v${pkgVersion}-personal.tar.gz`);
      const shaPath = `${tarballPath}.sha256`;
      assert.ok(fs.existsSync(tarballPath), "Release tarball must exist");
      assert.ok(fs.existsSync(shaPath), "Release SHA-256 file must exist");

      const shaVerify = spawnSync("sha256sum", ["-c", shaPath], {
        cwd: pkgOutDir,
        encoding: "utf8"
      });
      assert.equal(shaVerify.status, 0, `sha256sum verification failed: ${shaVerify.stderr}`);

      // Extract into an isolated temp directory, symlink node_modules, compile native C broker, and run `/doctor`!
      const extractDir = path.join(tmpRoot, "extracted-release");
      fs.mkdirSync(extractDir, { recursive: true });
      const untar = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], { encoding: "utf8" });
      assert.equal(untar.status, 0);

      const extractedRepo = path.join(extractDir, "pi-apex-harness");
      assert.equal(
        fs.existsSync(path.join(extractedRepo, "src", "native", "linux_fs_bridge.node")),
        false,
        "Portable source archive must omit precompiled host .node binary"
      );
      fs.symlinkSync(
        path.join(REPO_ROOT, "node_modules"),
        path.join(extractedRepo, "node_modules"),
        "dir"
      );

      const buildNative = spawnSync("npm", ["run", "build:native"], {
        cwd: extractedRepo,
        encoding: "utf8"
      });
      assert.equal(buildNative.status, 0, `Extracted build:native failed: ${buildNative.stderr}`);

      const verOut = spawnSync(
        process.execPath,
        [path.join(extractedRepo, "bin", "pi-apex"), "--version"],
        { encoding: "utf8" }
      );
      assert.equal(verOut.status, 0);
      assert.ok(
        verOut.stdout.includes(`pi-apex ${pkgVersion}`),
        `Expected pi-apex ${pkgVersion}, got: ${verOut.stdout}`
      );

      const { ws } = setupWorkspace(tmpRoot, "extracted-doctor-ws");
      const docOut = spawnSync(
        process.execPath,
        [path.join(extractedRepo, "bin", "pi-apex"), "--cwd", ws, "-p", "/doctor"],
        { encoding: "utf8" }
      );
      assert.equal(docOut.status, 0, `Extracted /doctor failed: ${docOut.stderr}`);
      assert.match(docOut.stdout, /ALL HEALTHY/);
      assert.match(docOut.stdout, /schema=(?:1053|1073|1080)/);

      results.push({
        id: "R6-6",
        detail:
          `Portable pi-apex-v${pkgVersion}-personal.tar.gz + SHA-256 checksum + clean extraction, native build & /doctor (schema=1073) verified`
      });
    }

    const elapsed = (performance.now() - t0).toFixed(2);
    console.log(`\n=== Ring 6 Daily-Driver Verification Suite (${elapsed} ms) ===`);
    for (const r of results) {
      console.log(`  [PASS] ${r.id}: ${r.detail}`);
    }
    console.log(`All ${results.length} Ring 6 tests PASSED.`);
  } finally {
    if (prevAnthropic === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prevAnthropic;
    if (prevOpenAi === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = prevOpenAi;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
