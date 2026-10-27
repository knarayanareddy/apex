import type { ExtensionFactory, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadVerifiedGuardrails } from "../core/guardrail-pin.ts";
import {
  createRing0Harness,
  type Ring0HarnessInstance,
  type Ring0HarnessOptions
} from "../core/ring0-session.ts";
import type { StateDb } from "../core/state-db.ts";
import { syncSessionTranscriptDurable } from "../core/wal-recovery.ts";
import {
  LspClientManager,
  type LspOperationName,
  type LspServerCommandSpec
} from "./lsp-client.ts";
import { ThreeStrikeLoopGuard, type LoopGuardOptions } from "./loop-guard.ts";
import { MerkleRepoMapEngine } from "./merkle-repo-map.ts";
import {
  type ScopedRuleInjection,
  ScopedRulesLoader,
  suggestSiblingPathsOnEnoent
} from "./scoped-rules-loader.ts";
import {
  type CompactionExecutionReceipt,
  planTwoStageCompactionDrafts,
  type TwoStageCompactionOptions
} from "./two-stage-compaction.ts";

export interface Ring1Options {
  compaction?: TwoStageCompactionOptions;
  loopGuard?: LoopGuardOptions;
  lspServers?: LspServerCommandSpec[];
  lspDiagnosticsWaitMs?: number;
}

export interface Ring1HarnessInstance extends Ring0HarnessInstance {
  readonly rulesLoader: ScopedRulesLoader;
  readonly loopGuard: ThreeStrikeLoopGuard;
  readonly repoMapEngine: MerkleRepoMapEngine;
  readonly lspManager: LspClientManager;
  readonly injectedRulesLog: ScopedRuleInjection[];
  readonly compactionReceipts: CompactionExecutionReceipt[];
  disposeAsync(): Promise<void>;
}

/**
 * Builds the `Ring 1` Extension Pack (`Invariant I-01`, `I-02`, `I-03`, `I-10`):
 *  1. Append-only `.mdc` & subdirectory `AGENTS.md` dynamic context tail loader (`<= 32 KiB`) + `ENOENT` fuzzy sibling hints
 *  2. Two-stage warm-prefix compaction (`appendContextEdit` Stage 1 -> `<compacted-summary>` Stage 2)
 *  3. Deterministic 3-strike identical-call & edit ping-pong loop guard
 *  4. Real `web-tree-sitter` WASM Merkle AST `repo_map` tool (`exposure: "deferred"` -> `+0` schema tokens)
 *  5. Stdio JSON-RPC 2.0 `lsp_query` tool (OpenCode's 9 semantic ops + `diagnostics`, `exposure: "deferred"`) + `read` warm-up & post-edit `<lsp-diagnostics>` tail
 */
export async function createRing1Harness(
  opts: Ring0HarnessOptions & { ring1?: Ring1Options }
): Promise<Ring1HarnessInstance> {
  const { config: guardrails } = loadVerifiedGuardrails(
    opts.guardrailsPath,
    opts.expectedGuardrailsSha256
  );

  const rulesLoader = new ScopedRulesLoader(opts.workspaceRoot, guardrails);
  const loopGuard = new ThreeStrikeLoopGuard(opts.workspaceRoot, opts.ring1?.loopGuard);
  const lspManager = new LspClientManager({
    workspaceRoot: opts.workspaceRoot,
    guardrails,
    trustedRepo: opts.trustedRepo ?? true,
    servers: opts.ring1?.lspServers,
    diagnosticsWaitMs: opts.ring1?.lspDiagnosticsWaitMs ?? 200
  });

  const injectedRulesLog: ScopedRuleInjection[] = [];
  const compactionReceipts: CompactionExecutionReceipt[] = [];

  let stateDbRef: StateDb | null = null;
  let sessionManagerRef: SessionManager | null = null;
  let repoMapEngineRef: MerkleRepoMapEngine | null = null;
  let pendingCompactionSyncNeeded = false;

  const ring1Extension: ExtensionFactory = (pi) => {
    // 1. Register `repo_map` strictly as `exposure: "deferred"` (+0 active schema tokens!)
    pi.registerTool({
      name: "repo_map",
      label: "Merkle AST Repo-Map",
      description:
        "Builds or queries the incremental Tree-Sitter Merkle AST symbol & call-centrality map within a strict token budget.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Symbol, concept, or task query for BM25 + PageRank ranking" })),
        focusFiles: Type.Optional(Type.Array(Type.String())),
        maxTokens: Type.Optional(Type.Number({ minimum: 128, maximum: 8192 }))
      }),
      exposure: "deferred",
      async execute(_id, params) {
        if (!repoMapEngineRef) {
          throw new Error("MerkleRepoMapEngine not yet bound to StateDb");
        }
        const res = await repoMapEngineRef.generateRepoMap({
          query: params.query,
          focusFiles: params.focusFiles,
          maxTokens: params.maxTokens
        });
        return {
          content: [{ type: "text", text: res.renderedMap }],
          details: {
            rootMerkleHash: res.rootMerkleHash,
            totalIndexedFiles: res.totalIndexedFiles,
            reparsedFiles: res.reparsedFiles,
            cacheHitFiles: res.cacheHitFiles,
            tokenCount: res.tokenCount
          }
        };
      }
    });

    // 2. Register `lsp_query` (OpenCode's 9 semantic ops + `diagnostics`) strictly as `exposure: "deferred"` (+0 active schema tokens!)
    pi.registerTool({
      name: "lsp_query",
      label: "Semantic LSP Query",
      description:
        "Executes semantic LSP navigation and call-hierarchy queries over stdio JSON-RPC (goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls, diagnostics).",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("goToDefinition"),
          Type.Literal("findReferences"),
          Type.Literal("hover"),
          Type.Literal("documentSymbol"),
          Type.Literal("workspaceSymbol"),
          Type.Literal("goToImplementation"),
          Type.Literal("prepareCallHierarchy"),
          Type.Literal("incomingCalls"),
          Type.Literal("outgoingCalls"),
          Type.Literal("diagnostics")
        ]),
        filePath: Type.Optional(Type.String({ description: "Workspace-relative file path" })),
        line: Type.Optional(Type.Number({ minimum: 1, description: "1-based line number" })),
        character: Type.Optional(Type.Number({ minimum: 1, description: "1-based column number" })),
        query: Type.Optional(Type.String({ description: "Symbol query for workspaceSymbol" }))
      }),
      exposure: "deferred",
      async execute(_id, params) {
        const out = await lspManager.executeOperation({
          operation: params.operation as LspOperationName,
          filePath: params.filePath,
          line: params.line,
          character: params.character,
          query: params.query
        });
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          details: out
        };
      }
    });

    pi.on("turn_start", async () => {
      rulesLoader.resetTurnState();
    });

    // 3. Deterministic 3-Strike Loop & Ping-Pong Gate
    pi.on("tool_call", async (event) => {
      const verdict = loopGuard.evaluateBeforeToolCall({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input
      });
      if (verdict.blocked) {
        return { block: true, reason: verdict.reason };
      }
      return undefined;
    });

    // 4. Append-Only Tail Enrichments (`Invariant I-02` — ZERO system prompt mutation!):
    //    - `ENOENT` sibling fuzzy suggestions on `read`
    //    - Non-blocking `lsp.touchFileBackground` warm-up on `read`
    //    - Post-`write`/`edit` `<lsp-diagnostics>` error tail injection
    //    - Scoped `.mdc` & subdirectory `AGENTS.md` tail injection (`<= 32 KiB`)
    //    - Loop-guard Strike-2 warning tail
    pi.on("tool_result", async (event) => {
      const rawText = event.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");

      const tailFragments: string[] = [];

      // 4a. Loop guard recording + optional Strike-2 warning
      const loopOut = loopGuard.recordToolResult({
        toolCallId: event.toolCallId,
        resultText: rawText,
        isError: event.isError
      });
      if (loopOut.warningTailBlock) {
        tailFragments.push(loopOut.warningTailBlock);
      }

      const targetPath = typeof event.input?.path === "string" ? event.input.path : null;

      // 4b. OpenCode `read.ts` ENOENT sibling suggestion OR background LSP warm-up
      if (event.toolName === "read" && targetPath) {
        if (event.isError && /ENOENT|no such file|not found/i.test(rawText)) {
          const suggestions = suggestSiblingPathsOnEnoent(targetPath, opts.workspaceRoot, guardrails);
          if (suggestions.length > 0) {
            tailFragments.push(
              `\n\nDid you mean one of these?\n${suggestions.map((s) => `  - ${s}`).join("\n")}`
            );
          }
        } else if (!event.isError) {
          lspManager.touchFileBackground(targetPath);
        }
      }

      // 4c. Scoped `.mdc` & subdirectory `AGENTS.md` tail injection on `read` / `write` / `edit`
      if (
        !event.isError &&
        targetPath &&
        sessionManagerRef &&
        (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit")
      ) {
        const scoped = rulesLoader.collectTailInjectionsForPath(targetPath, sessionManagerRef);
        if (scoped.injections.length > 0) {
          injectedRulesLog.push(...scoped.injections);
          tailFragments.push(scoped.formattedTailBlock);
        }
      }

      // 4d. Post-`write`/`edit` LSP diagnostics tail injection
      if (!event.isError && targetPath && (event.toolName === "write" || event.toolName === "edit")) {
        const diagOut = await lspManager.syncModifiedFileAndFormatTailDiagnostics(targetPath);
        if (diagOut.formattedTailBlock) {
          tailFragments.push(diagOut.formattedTailBlock);
        }
      }

      if (tailFragments.length === 0) {
        return undefined;
      }

      const appendedSuffix = tailFragments.join("");
      const updatedContent = [...event.content];
      let appended = false;
      for (let i = updatedContent.length - 1; i >= 0; i--) {
        const item = updatedContent[i];
        if (item.type === "text") {
          updatedContent[i] = { ...item, text: `${item.text}${appendedSuffix}` };
          appended = true;
          break;
        }
      }
      if (!appended) {
        updatedContent.push({ type: "text", text: appendedSuffix.trimStart() });
      }

      return {
        content: updatedContent,
        structuredContent: event.structuredContent
      };
    });

    // 5. Two-Stage Warm-Prefix Compaction at `turn_end` via native `BoundaryResult` (`Invariant I-10`)
    pi.on("turn_end", async (event) => {
      if (!opts.ring1?.compaction) return undefined;
      const receipt = await planTwoStageCompactionDrafts({
        projectedEntries: event.context.contextEntries,
        stateDb: stateDbRef ?? undefined,
        sessionId: sessionManagerRef?.getSessionId(),
        workspaceRoot: opts.workspaceRoot,
        options: opts.ring1.compaction
      });
      if (receipt.boundaryDrafts.length === 0) {
        return undefined;
      }
      compactionReceipts.push(receipt);
      pendingCompactionSyncNeeded = true;
      return {
        entries: receipt.boundaryDrafts
      };
    });

    pi.on("agent_before_settle", async () => {
      if (pendingCompactionSyncNeeded && stateDbRef && sessionManagerRef) {
        pendingCompactionSyncNeeded = false;
        const sf = sessionManagerRef.getSessionFile();
        syncSessionTranscriptDurable(sf, stateDbRef.durabilityMode, Boolean(sf));
      }
      return undefined;
    });
  };

  const ring0 = await createRing0Harness({
    ...opts,
    extraExtensions: [ring1Extension, ...(opts.extraExtensions ?? [])]
  });

  stateDbRef = ring0.stateDb;
  sessionManagerRef = ring0.session.sessionManager;
  repoMapEngineRef = new MerkleRepoMapEngine(opts.workspaceRoot, ring0.stateDb);

  const repoMapEngine = repoMapEngineRef;

  return {
    ...ring0,
    rulesLoader,
    loopGuard,
    repoMapEngine,
    lspManager,
    injectedRulesLog,
    compactionReceipts,
    dispose() {
      void lspManager.shutdownAll();
      ring0.dispose();
    },
    async disposeAsync() {
      await lspManager.shutdownAll();
      ring0.dispose();
    }
  };
}
