import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { rewindChatAndDiskToLeaf } from "../../src/core/git-rewind.ts";
import { countO200kTokens } from "../../src/core/prefix-budget.ts";
import { createRing0Harness, createSharedModelRuntime } from "../../src/core/ring0-session.ts";
import { StateDb } from "../../src/core/state-db.ts";
import { createRing1Harness } from "../../src/ring1/ring1-extension.ts";
import { applyTwoStageCompactionToSessionManager } from "../../src/ring1/two-stage-compaction.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, "../..");
const MOCK_LSP_SERVER = path.resolve(__dirname, "../fixtures/stdio-lsp-server.ts");

async function runRing1Tests(): Promise<void> {
  const t0 = performance.now();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-ring1-"));
  const checks: string[] = [];

  try {
    // =========================================================================
    // Setup Ring 1 Test Workspace & Surfaces
    // =========================================================================
    const ws = path.join(tmpRoot, "ws");
    const surfaces = path.join(tmpRoot, "surfaces");
    fs.mkdirSync(path.join(ws, "src", "payments"), { recursive: true });
    fs.mkdirSync(path.join(ws, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(ws, ".cursor", "rules"), { recursive: true });
    fs.mkdirSync(surfaces, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: ws });

    fs.copyFileSync(path.join(HARNESS_ROOT, "surfaces/SYSTEM.md"), path.join(surfaces, "SYSTEM.md"));
    fs.copyFileSync(path.join(HARNESS_ROOT, "surfaces/TOOL_GUIDANCE.md"), path.join(surfaces, "TOOL_GUIDANCE.md"));
    fs.copyFileSync(path.join(HARNESS_ROOT, "surfaces/MEMORY.md"), path.join(surfaces, "MEMORY.md"));

    // Secret file inside `src/payments/.env` — MUST NEVER appear in ENOENT suggestions, Repo-Map, or LSP!
    fs.writeFileSync(path.join(ws, "src", "payments", ".env"), "STRIPE_KEY=sk_live_secret_ring1", "utf8");

    // Subdirectory `AGENTS.md` + `.cursor/rules/stripe.mdc`
    fs.writeFileSync(
      path.join(ws, "src", "payments", "AGENTS.md"),
      "PAYMENTS_DIR_RULE: Always represent currency amounts in integer minor units (cents).\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(ws, ".cursor", "rules", "stripe.mdc"),
      [
        "---",
        "description: Stripe TypeScript Handler Standards",
        "globs: src/payments/**/*.ts",
        "alwaysApply: false",
        "---",
        "STRIPE_MDC_RULE: Every charge call must pass an idempotency key."
      ].join("\n"),
      "utf8"
    );

    // Real TypeScript + Python source files for Tree-Sitter WASM Repo-Map & Stdio LSP
    fs.writeFileSync(
      path.join(ws, "src", "payments", "fee.ts"),
      [
        "export function calculateStripeFee(amountCents: number): number {",
        "  return Math.round(amountCents * 0.029) + 30;",
        "}"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(ws, "src", "payments", "charge.ts"),
      [
        'import { calculateStripeFee } from "./fee.ts";',
        "",
        "export class PaymentProcessor {",
        "  processCharge(amountCents: number): number {",
        "    const fee = calculateStripeFee(amountCents);",
        "    return amountCents - fee;",
        "  }",
        "}",
        "",
        "export function invokeProcessor(x: number): number {",
        "  return calculateStripeFee(x);",
        "}"
      ].join("\n") + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(ws, "scripts", "reconcile.py"),
      [
        "class LedgerReconciler:",
        "    def verify_totals(self, items):",
        "        return sum(items)"
      ].join("\n") + "\n",
      "utf8"
    );

    // =========================================================================
    // R1-1. Exact Zero Schema Bloat (`+0` tokens vs Ring 0) & Prefix Invariance
    // =========================================================================
    const faux = fauxProvider();
    const sharedRuntime = await createSharedModelRuntime();
    sharedRuntime.registerNativeProvider(faux.provider);
    await sharedRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");

    const r0Baseline = await createRing0Harness({
      workspaceRoot: ws,
      surfacesDir: surfaces,
      modelRuntime: sharedRuntime,
      model: faux.getModel()
    });
    const r0SchemaTokens = countO200kTokens(
      JSON.stringify(
        r0Baseline.session.agent.state.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? null
        }))
      )
    );
    r0Baseline.dispose();

    const prevApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-secret-must-not-leak-to-lsp";

    const r1 = await createRing1Harness({
      workspaceRoot: ws,
      surfacesDir: surfaces,
      durabilityMode: "power-loss-safe",
      modelRuntime: sharedRuntime,
      model: faux.getModel(),
      ring1: {
        lspServers: [
          {
            languageId: "typescript",
            extensions: [".ts", ".tsx"],
            command: process.execPath,
            args: ["--experimental-strip-types", MOCK_LSP_SERVER]
          }
        ],
        lspDiagnosticsWaitMs: 300
      }
    });

    try {
      const r1SchemaTokens = countO200kTokens(
        JSON.stringify(
          r1.session.agent.state.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            parameters: t.parameters ?? null
          }))
        )
      );
      assert.equal(
        r1SchemaTokens,
        r0SchemaTokens,
        `Ring 1 deferred tools (repo_map, lsp_query) MUST add +0 active schema tokens (got ${r1SchemaTokens} vs ${r0SchemaTokens})!`
      );
      checks.push(`R1-1. Zero active schema bloat (${r1SchemaTokens} === ${r0SchemaTokens} o200k tokens): PASS`);

      // =========================================================================
      // R1-2. Real `web-tree-sitter` WASM Merkle AST Repo-Map & Incremental Cache
      // =========================================================================
      const mapRun1 = await r1.repoMapEngine.generateRepoMap({
        query: "calculateStripeFee",
        maxTokens: 512
      });
      assert.equal(mapRun1.totalIndexedFiles, 3);
      assert.equal(mapRun1.reparsedFiles, 3, "Cold run must parse all 3 source files via Tree-Sitter WASM");
      assert.equal(mapRun1.cacheHitFiles, 0);
      assert.ok(mapRun1.tokenCount <= 512);
      assert.ok(mapRun1.renderedMap.includes("calculateStripeFee"));
      assert.ok(mapRun1.renderedMap.includes("PaymentProcessor"));
      assert.ok(!mapRun1.renderedMap.includes("sk_live_secret_ring1"), "Secret .env must never enter Repo-Map!");
      // `fee.ts` is called by `charge.ts` AND matches `calculateStripeFee` BM25 -> must rank top!
      assert.equal(mapRun1.rankedFiles[0].relPath, "src/payments/fee.ts");

      // Second run with zero file modifications -> 0 WASM reparses, 3 Merkle cache hits!
      const mapRun2 = await r1.repoMapEngine.generateRepoMap({
        query: "LedgerReconciler",
        maxTokens: 512
      });
      assert.equal(mapRun2.reparsedFiles, 0, "Unchanged workspace MUST hit Merkle AST cache with 0 WASM reparses!");
      assert.equal(mapRun2.cacheHitFiles, 3);
      assert.equal(mapRun2.rootMerkleHash, mapRun1.rootMerkleHash);
      assert.equal(mapRun2.rankedFiles[0].relPath, "scripts/reconcile.py");

      // Modify ONLY `scripts/reconcile.py` -> exactly 1 WASM reparse, 2 Merkle cache hits, new root Merkle hash!
      fs.appendFileSync(
        path.join(ws, "scripts", "reconcile.py"),
        "\ndef audit_drift(delta):\n    return abs(delta)\n",
        "utf8"
      );
      const mapRun3 = await r1.repoMapEngine.generateRepoMap({ query: "audit_drift", maxTokens: 512 });
      assert.equal(mapRun3.reparsedFiles, 1, "Single-file edit must reparse ONLY the 1 modified file!");
      assert.equal(mapRun3.cacheHitFiles, 2);
      assert.notEqual(mapRun3.rootMerkleHash, mapRun2.rootMerkleHash);
      assert.ok(mapRun3.renderedMap.includes("audit_drift"));
      checks.push("R1-2. Real web-tree-sitter WASM Merkle AST Repo-Map + incremental cache (3->0->1 reparses): PASS");

      // =========================================================================
      // R1-3 & R1-4. Live Agent Turn: ENOENT Fuzzy Hint, Scoped `.mdc`/`AGENTS.md` Tail,
      //              `read` LSP Warm-Up, Post-`write` `<lsp-diagnostics>`, & All 9 LSP Ops in QuickJS `Codemode`!
      // =========================================================================
      faux.setResponses([
        // Turn 1:
        // 1) Typo `read` (`src/payments/charg.ts`) -> triggers fuzzy `"Did you mean ... src/payments/charge.ts"`!
        // 2) Valid `read` (`src/payments/charge.ts`) -> triggers `AGENTS.md` + `stripe.mdc` tail injection + LSP warm-up!
        // 3) `read` (`src/payments/fee.ts`) -> rules already on active branch -> MUST NOT duplicate `<scoped-context>`!
        // 4) `write` (`src/payments/broken.ts` with `TYPE_ERROR_MARKER`) -> triggers `<lsp-diagnostics>` tail injection!
        // 5) `codemode` calling BOTH `tools.repo_map` AND all 9 OpenCode `tools.lsp_query` operations!
        fauxAssistantMessage([
          fauxToolCall("read", { path: "src/payments/charg.ts" }, { id: "r1_typo" }),
          fauxToolCall("read", { path: "src/payments/charge.ts" }, { id: "r1_read_charge" }),
          fauxToolCall("read", { path: "src/payments/fee.ts" }, { id: "r1_read_fee" }),
          fauxToolCall(
            "write",
            {
              path: "src/payments/broken.ts",
              content: "export const bad: number = TYPE_ERROR_MARKER;\n"
            },
            { id: "r1_write_broken" }
          ),
          fauxToolCall(
            "codemode",
            {
              code: `
                const rmap = await tools.repo_map({ query: "PaymentProcessor", maxTokens: 400 });
                const defRes = await tools.lsp_query({
                  operation: "goToDefinition",
                  filePath: "src/payments/charge.ts",
                  line: 5,
                  character: 20
                });
                const refRes = await tools.lsp_query({
                  operation: "findReferences",
                  filePath: "src/payments/fee.ts",
                  line: 1,
                  character: 20
                });
                const hovRes = await tools.lsp_query({
                  operation: "hover",
                  filePath: "src/payments/fee.ts",
                  line: 1,
                  character: 20
                });
                const docSym = await tools.lsp_query({
                  operation: "documentSymbol",
                  filePath: "src/payments/charge.ts"
                });
                const wsSym = await tools.lsp_query({
                  operation: "workspaceSymbol",
                  query: "PaymentProcessor"
                });
                const implRes = await tools.lsp_query({
                  operation: "goToImplementation",
                  filePath: "src/payments/charge.ts",
                  line: 5,
                  character: 20
                });
                const prepCall = await tools.lsp_query({
                  operation: "prepareCallHierarchy",
                  filePath: "src/payments/fee.ts",
                  line: 1,
                  character: 20
                });
                const incCall = await tools.lsp_query({
                  operation: "incomingCalls",
                  filePath: "src/payments/fee.ts",
                  line: 1,
                  character: 20
                });
                const outCall = await tools.lsp_query({
                  operation: "outgoingCalls",
                  filePath: "src/payments/charge.ts",
                  line: 4,
                  character: 5
                });
                return {
                  hasMap: typeof rmap === "string" ? rmap.includes("PaymentProcessor") : JSON.stringify(rmap).includes("PaymentProcessor"),
                  defRes,
                  refRes,
                  hovRes,
                  docSym,
                  wsSym,
                  implRes,
                  prepCall,
                  incCall,
                  outCall
                };
              `
            },
            { id: "r1_cm_lsp" }
          )
        ]),
        fauxAssistantMessage("Turn 1 complete."),
        // Turn 2: Read `src/payments/charge.ts` again in next turn -> verify `<scoped-context>` is NOT re-injected on same branch!
        fauxAssistantMessage([
          fauxToolCall("read", { path: "src/payments/charge.ts" }, { id: "r1_read_charge_t2" })
        ]),
        fauxAssistantMessage("Turn 2 complete.")
      ]);

      await r1.session.prompt("Inspect payments module and run semantic queries");
      await r1.session.prompt("Re-read charge.ts in Turn 2");

      const extractMsgText = (msg: unknown): string => {
        if (!msg || typeof msg !== "object") return "";
        const content = (msg as { content?: unknown }).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : JSON.stringify(p)))
            .join("\n");
        }
        return JSON.stringify(msg);
      };

      const toolMsgs = r1.session.messages.filter((m) => m.role === "toolResult");
      const findToolText = (callId: string) =>
        extractMsgText(toolMsgs.find((m) => (m as { toolCallId?: string }).toolCallId === callId));

      // Verify ENOENT fuzzy suggestion (`src/payments/charge.ts` suggested, `.env` NOT suggested!)
      const typoOut = findToolText("r1_typo");
      assert.ok(typoOut.includes("Did you mean one of these?"), `Missing fuzzy hint: ${typoOut}`);
      assert.ok(typoOut.includes("src/payments/charge.ts"));
      assert.ok(!typoOut.includes(".env"), "Secret .env MUST NOT appear in ENOENT fuzzy suggestions!");

      // Verify scoped `AGENTS.md` + `.mdc` injected on `r1_read_charge`, NOT duplicated on `r1_read_fee` or `r1_read_charge_t2`!
      const chargeOut = findToolText("r1_read_charge");
      assert.ok(chargeOut.includes("PAYMENTS_DIR_RULE"));
      assert.ok(chargeOut.includes("STRIPE_MDC_RULE"));

      const feeOut = findToolText("r1_read_fee");
      assert.ok(!feeOut.includes("PAYMENTS_DIR_RULE"), "AGENTS.md must not duplicate within same turn!");
      assert.ok(!feeOut.includes("STRIPE_MDC_RULE"), ".mdc rule must not duplicate within same turn!");

      const chargeT2Out = findToolText("r1_read_charge_t2");
      assert.ok(!chargeT2Out.includes("PAYMENTS_DIR_RULE"), "AGENTS.md must not duplicate on subsequent turn in same branch!");
      assert.equal(r1.injectedRulesLog.length, 2, "Exactly 2 unique rules should have been injected across both turns");

      // Verify `read` triggered LSP warm-up AND `write` appended `<lsp-diagnostics>` error tail!
      assert.ok(r1.lspManager.touchedFiles.includes("src/payments/charge.ts"));
      const brokenWriteOut = findToolText("r1_write_broken");
      assert.ok(brokenWriteOut.includes("<lsp-diagnostics file=\"src/payments/broken.ts\">"), `Missing LSP diagnostics tail: ${brokenWriteOut}`);
      assert.ok(brokenWriteOut.includes("TS2322"));

      // Verify all 9 OpenCode semantic LSP operations + `repo_map` succeeded inside QuickJS `Codemode`!
      const cmOut = findToolText("r1_cm_lsp");
      assert.ok(cmOut.includes("src/payments/fee.ts"), `goToDefinition failed: ${cmOut}`);
      assert.ok(cmOut.includes("PaymentProcessor"), `documentSymbol/workspaceSymbol failed: ${cmOut}`);
      assert.ok(cmOut.includes("callerBlock"), `incomingCalls failed: ${cmOut}`);
      assert.ok(cmOut.includes("calculateStripeFee"), `outgoingCalls/hover failed: ${cmOut}`);

      // Verify ZERO static prefix drift across all tail injections & turns (`Invariant I-01` & `I-02`)!
      assert.ok(r1.observedPrefixHashes.length >= 4);
      assert.equal(new Set(r1.observedPrefixHashes).size, 1, "Static prefix SHA-256 MUST stay 100% invariant!");
      checks.push(
        "R1-3 & R1-4. Scoped .mdc/AGENTS.md tail + ENOENT fuzzy hint + stdio LSP (all 9 ops & <lsp-diagnostics>) + 0 prefix drift: PASS"
      );

      // =========================================================================
      // R1-5. Deterministic 3-Strike Identical-Call & Edit Ping-Pong Loop Guard
      // =========================================================================
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "src/payments/nonexistent-loop.ts" }, { id: "lg_1" })]),
        fauxAssistantMessage([fauxToolCall("read", { path: "src/payments/nonexistent-loop.ts" }, { id: "lg_2" })]),
        fauxAssistantMessage([
          fauxToolCall("read", { path: "src/payments/nonexistent-loop.ts" }, { id: "lg_3" }),
          // Distinct recovery call right after Strike-3 block MUST succeed!
          fauxToolCall("read", { path: "src/payments/fee.ts" }, { id: "lg_recover" })
        ]),
        fauxAssistantMessage("Recovered from 3-strike loop.")
      ]);

      await r1.session.prompt("Test 3-strike identical failing call guard");

      const allToolMsgsAfterLoop = r1.session.messages.filter((m) => m.role === "toolResult");
      const getMsgById = (id: string) =>
        extractMsgText(allToolMsgsAfterLoop.find((m) => (m as { toolCallId?: string }).toolCallId === id));

      assert.ok(getMsgById("lg_2").includes('<loop-guard-warning strike="2"'));
      assert.ok(getMsgById("lg_3").includes("LOOP_GUARD_TRIPPED (strike 3)"));
      assert.ok(getMsgById("lg_recover").includes("calculateStripeFee"), "Distinct recovery call must be permitted!");

      // Also verify `A -> B -> A -> B` edit ping-pong detection across sequential agent steps on the same file!
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("write", { path: "src/payments/osc.ts", content: "export const state = 'A';\n" }, { id: "pp_1" })]),
        fauxAssistantMessage([fauxToolCall("write", { path: "src/payments/osc.ts", content: "export const state = 'B';\n" }, { id: "pp_2" })]),
        fauxAssistantMessage([fauxToolCall("write", { path: "src/payments/osc.ts", content: "export const state = 'A';\n" }, { id: "pp_3" })]),
        fauxAssistantMessage([fauxToolCall("write", { path: "src/payments/osc.ts", content: "export const state = 'B';\n" }, { id: "pp_4" })]),
        // 5th oscillating write is blocked by `PING_PONG_BLOCKED`!
        fauxAssistantMessage([fauxToolCall("write", { path: "src/payments/osc.ts", content: "export const state = 'A';\n" }, { id: "pp_5" })]),
        fauxAssistantMessage("Ping-pong handled.")
      ]);
      await r1.session.prompt("Test A->B->A->B edit ping-pong guard");
      const ppMsgs = r1.session.messages.filter((m) => m.role === "toolResult");
      const pp5Text = extractMsgText(ppMsgs.find((m) => (m as { toolCallId?: string }).toolCallId === "pp_5"));
      assert.ok(pp5Text.includes("LOOP_GUARD_PING_PONG"), `Expected ping-pong block on pp_5, got: ${pp5Text}`);
      checks.push("R1-5. Deterministic 3-strike identical-call block + A->B->A->B edit ping-pong block: PASS");
    } finally {
      if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevApiKey;
      await r1.disposeAsync();
    }

    // =========================================================================
    // R1-6. Two-Stage Warm-Prefix Compaction (`appendContextEdit` Stage 1 -> `<compacted-summary>` Stage 2 + FTS5)
    // =========================================================================
    const compDir = path.join(tmpRoot, "compaction");
    fs.mkdirSync(compDir, { recursive: true });
    const compDb = new StateDb(path.join(compDir, "state.db"), "power-loss-safe");
    const smComp = SessionManager.create(ws, path.join(compDir, "sessions"));

    // Seed 6 turns with verbose older tool outputs (~250 tokens each) + `<scoped-context>` inside Turn 1
    for (let i = 1; i <= 6; i++) {
      smComp.appendMessage({
        role: "user",
        content: `Investigate module part ${i} in src/payments/charge.ts`,
        timestamp: Date.now()
      });
      smComp.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Reading verbose output ${i}` }],
        api: "openai-responses",
        provider: "faux",
        model: "faux-1",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "toolUse",
        timestamp: Date.now()
      });
      const scopedSuffix =
        i === 1
          ? `\n<scoped-context rule="agents:src/payments/AGENTS.md" sha256="${"a".repeat(64)}">\nKEEP_THIS_RULE\n</scoped-context>`
          : "";
      smComp.appendMessage({
        role: "toolResult",
        toolCallId: `verbose_call_${i}`,
        toolName: "read",
        content: [
          {
            type: "text",
            text: `FILE_DUMP_${i}: ` + `const line_${i} = "verbose_payload_data_${i}";\n`.repeat(35) + scopedSuffix
          }
        ],
        isError: false,
        timestamp: Date.now()
      });
    }

    // 1. Trigger Stage 1 ONLY (`contextWindowTokens = 2600`, `staticPrefixTokens = 500`):
    //    Stage 1 (`appendContextEdit`, `0` LLM calls) drops tokens well below `0.80 * 2600 = 2080`!
    const stage1Receipt = await applyTwoStageCompactionToSessionManager({
      sessionManager: smComp,
      stateDb: compDb,
      workspaceRoot: ws,
      options: {
        contextWindowTokens: 2_600,
        staticPrefixTokens: 500,
        stage1TriggerRatio: 0.70,
        stage2TriggerRatio: 0.85,
        keepRecentToolResults: 2,
        pruneMinToolTokens: 100
      }
    });
    assert.equal(stage1Receipt.stage1Triggered, true, "Stage 1 appendContextEdit pruner must trigger!");
    assert.equal(stage1Receipt.stage2Triggered, false, "Stage 2 must NOT run when Stage 1 brings tokens below 0.85!");
    assert.equal(stage1Receipt.prunedEntryIds.length, 4, "Oldest 4 of 6 verbose toolResults must be pruned!");
    assert.ok(stage1Receipt.tokensAfterStage1 < stage1Receipt.tokensBefore - 600);

    const projectedAfterS1 = JSON.stringify(smComp.buildSessionContext().messages);
    assert.ok(projectedAfterS1.includes("[Stage-1 Context Pruned"), "Pruned stub must appear in projected context");
    assert.ok(projectedAfterS1.includes("KEEP_THIS_RULE"), "Stage-1 pruning MUST preserve <scoped-context> rules!");
    assert.ok(projectedAfterS1.includes("FILE_DUMP_6"), "Newest toolResults must remain verbatim!");

    // 2. Now trigger Stage 2 (`contextWindowTokens = 1400` -> even after Stage 1, exceeds `0.80 * 1400 = 1120`)!
    const stage2Receipt = await applyTwoStageCompactionToSessionManager({
      sessionManager: smComp,
      stateDb: compDb,
      workspaceRoot: ws,
      options: {
        contextWindowTokens: 1_400,
        staticPrefixTokens: 500,
        stage1TriggerRatio: 0.65,
        stage2TriggerRatio: 0.75,
        keepRecentToolResults: 2,
        keepRecentEntriesOnStage2: 4
      }
    });
    assert.equal(stage2Receipt.stage2Triggered, true, "Stage 2 <compacted-summary> must trigger when utilization stays high!");
    assert.ok(stage2Receipt.episodeId !== null);

    const projectedAfterS2 = JSON.stringify(smComp.buildSessionContext().messages);
    assert.ok(projectedAfterS2.includes("<compacted-summary purpose="));
    assert.ok(projectedAfterS2.includes("src/payments/charge.ts"));

    // Verify FTS5 episode was durably recorded in `state.db`!
    const ftsHits = compDb.searchEpisodes("payments");
    assert.equal(ftsHits.length, 1);
    compDb.close();
    checks.push(
      "R1-6. Two-stage warm-prefix compaction (Stage-1 appendContextEdit 0-LLM -> Stage-2 <compacted-summary> + FTS5): PASS"
    );

    // =========================================================================
    // R1-7. Untrusted Workspace LSP Gate + `/tree` Branch Rewind Scoped-Rule Re-Injection
    //       + Live `turn_end` BoundaryResult Compaction
    // =========================================================================
    const untrustedR1 = await createRing1Harness({
      workspaceRoot: ws,
      surfacesDir: surfaces,
      trustedRepo: false,
      modelRuntime: sharedRuntime,
      model: faux.getModel(),
      ring1: {
        lspServers: [
          {
            languageId: "typescript",
            extensions: [".ts"],
            command: process.execPath,
            args: ["--experimental-strip-types", MOCK_LSP_SERVER]
          }
        ],
        compaction: {
          contextWindowTokens: 1_900,
          staticPrefixTokens: 1_100,
          stage1TriggerRatio: 0.65,
          stage2TriggerRatio: 0.95,
          keepRecentToolResults: 1,
          pruneMinToolTokens: 60
        }
      }
    });

    try {
      const untrustedLspOut = (await untrustedR1.lspManager.executeOperation({
        operation: "hover",
        filePath: "src/payments/fee.ts",
        line: 1,
        character: 15
      })) as { available: boolean; reason?: string };
      assert.equal(untrustedLspOut.available, false);
      assert.ok(untrustedLspOut.reason?.includes("untrusted workspace"));

      // Turn 1 touches ONLY `scripts/reconcile.py` (no payments rules yet -> captures checkpoint `leafBeforePayments`)
      fs.writeFileSync(
        path.join(ws, "scripts", "big_log.txt"),
        "VERBOSE_LOG_LINE_DATA_FOR_LIVE_BOUNDARY_COMPACTION\n".repeat(45),
        "utf8"
      );

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "scripts/big_log.txt" }, { id: "b_t1" })]),
        fauxAssistantMessage("Read big_log 1.")
      ]);
      await untrustedR1.session.prompt("Turn 1 before payments");
      const leafBeforePayments = untrustedR1.session.sessionManager.getLeafId()!;
      assert.ok(leafBeforePayments);

      // Turn 2 reads `src/payments/fee.ts` -> injects `PAYMENTS_DIR_RULE` & triggers live `turn_end` Stage-1 BoundaryResult!
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "src/payments/fee.ts" }, { id: "b_t2" })]),
        fauxAssistantMessage("Read payments fee.")
      ]);
      await untrustedR1.session.prompt("Turn 2 read payments");
      const leafAfterPayments = untrustedR1.session.sessionManager.getLeafId()!;
      assert.equal(untrustedR1.injectedRulesLog.length, 2);
      assert.ok(untrustedR1.compactionReceipts.length >= 1, "Live turn_end BoundaryResult compaction must fire!");
      assert.equal(untrustedR1.compactionReceipts[0].stage1Triggered, true);

      // Rewind `/tree` from `leafAfterPayments` -> `leafBeforePayments`:
      // Abandoned branch's `<scoped-context>` is no longer on active branch -> reading `src/payments/fee.ts` MUST re-inject!
      rewindChatAndDiskToLeaf({
        stateDb: untrustedR1.stateDb,
        workspaceRoot: ws,
        sessionManager: untrustedR1.session.sessionManager,
        sessionId: untrustedR1.session.sessionManager.getSessionId(),
        fromLeafId: leafAfterPayments,
        toLeafId: leafBeforePayments
      });

      const reCheck = untrustedR1.rulesLoader.collectTailInjectionsForPath(
        "src/payments/fee.ts",
        untrustedR1.session.sessionManager
      );
      assert.equal(
        reCheck.injections.length,
        2,
        "After /tree rewind to pre-injection leaf, scoped rules MUST re-inject cleanly on the new branch!"
      );
      assert.equal(new Set(untrustedR1.observedPrefixHashes).size, 1);
      checks.push(
        "R1-7. Untrusted-repo LSP block + /tree rewind rule re-injection + live turn_end BoundaryResult compaction: PASS"
      );
    } finally {
      await untrustedR1.disposeAsync();
    }

    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    console.log(JSON.stringify({ ring1_allPassed: true, elapsedMs, checks }, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runRing1Tests().catch((err) => {
  console.error(err);
  process.exit(1);
});
