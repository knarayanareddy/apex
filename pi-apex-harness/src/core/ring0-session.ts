import fs from "node:fs";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type BashOperations,
  createAgentSession,
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  type LoadExtensionsResult,
  ModelRuntime,
  SessionManager,
  type SessionStartEvent,
  SettingsManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { ApprovalPolicy, DurabilityMode, GuardrailsConfig, MutabilityClass, SandboxMode } from "../types.ts";
import { createBwrapBashOperations } from "./bwrap-sandbox.ts";
import { installSafeNetworkDispatcher } from "../ring10/safe-network.ts";
import { captureTurnCheckpoint, recoverInterruptedRewinds } from "./git-rewind.ts";
import { loadVerifiedGuardrails } from "./guardrail-pin.ts";
import {
  createConfinedFileOperations,
  evaluateShellCommandGuard,
  resolveAndValidateWorkspacePath
} from "./monotonic-guard.ts";
import { type BootPinnedPrefix, buildBootPinnedPrefix } from "./prefix-budget.ts";
import { PrivateSpillStore } from "./spill-store.ts";
import { StateDb } from "./state-db.ts";
import {
  assertNoUnresolvedOutcomeUnknown,
  executeThroughWalSpine,
  markWalCallTreeTranscriptAppended,
  reconcileWalOnStartup,
  syncSessionTranscriptDurable
} from "./wal-recovery.ts";

export interface Ring0HarnessOptions {
  workspaceRoot: string;
  surfacesDir: string;
  guardrailsPath?: string;
  expectedGuardrailsSha256?: string;
  trustedRepo?: boolean;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  unattendedRoutine?: boolean;
  durabilityMode?: DurabilityMode;
  allowUnsandboxedDev?: boolean;
  beforeAction?: (tool: string, summary: string) => Promise<void>;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
  sessionStartEvent?: SessionStartEvent;
  settingsManager?: SettingsManager;
  sessionManager?: SessionManager;
  extraExtensions?: ExtensionFactory[];
  extraTools?: ToolDefinition<any, any, any>[];
}

export interface Ring0HarnessInstance {
  readonly session: AgentSession;
  readonly agentDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly resourceLoader: DefaultResourceLoader;
  readonly extensionsResult: LoadExtensionsResult;
  readonly modelFallbackMessage?: string;
  readonly stateDb: StateDb;
  readonly spillStore: PrivateSpillStore;
  readonly prefix: BootPinnedPrefix;
  readonly guardrails: GuardrailsConfig;
  readonly bashOps: BashOperations;
  readonly sandboxMode: SandboxMode;
  readonly observedPrefixHashes: string[];
  readonly interceptedToolCalls: Array<{
    toolCallId: string;
    parentToolCallId: string | null;
    toolName: string;
    blocked: boolean;
    reason?: string;
  }>;
  readonly transcriptSyncReceipts: Array<{
    sessionFile: string | undefined;
    fileSynced: boolean;
    dirSynced: boolean;
  }>;
  dispose(): void;
}

function wrapToolDefinitionWithWal(
  tool: ToolDefinition<any, any, any>,
  walContext: {
    stateDb: StateDb;
    spillStore: PrivateSpillStore;
    sessionId: string;
    sessionManager: SessionManager;
    workspaceRoot: string;
  }
): ToolDefinition<any, any, any> {
  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let mutabilityClass: MutabilityClass = "OPAQUE_EXTERNAL";
      let localReversibleSpec: { targetPath: string; expectedAfterBytes: Buffer | string } | undefined = undefined;

      const p = (params ?? {}) as Record<string, any>;
      if (tool.name === "read") {
        mutabilityClass = "PURE_READ";
      } else if (tool.name === "bash") {
        mutabilityClass = "OPAQUE_EXTERNAL";
      } else if (tool.name === "write") {
        mutabilityClass = "LOCAL_REVERSIBLE";
        const targetPath = path.resolve(walContext.workspaceRoot, String(p.path ?? ""));
        const content = typeof p.content === "string" ? p.content : "";
        localReversibleSpec = {
          targetPath,
          expectedAfterBytes: Buffer.from(content, "utf8")
        };
      } else if (tool.name === "edit") {
        mutabilityClass = "LOCAL_REVERSIBLE";
        const targetPath = path.resolve(walContext.workspaceRoot, String(p.path ?? ""));
        let expectedBytes: Buffer | string = "";
        try {
          if (fs.existsSync(targetPath)) {
            let current = fs.readFileSync(targetPath, "utf8");
            if (Array.isArray(p.edits)) {
              for (const e of p.edits) {
                if (typeof e.oldText === "string" && typeof e.newText === "string") {
                  current = current.replace(e.oldText, e.newText);
                }
              }
            } else if (typeof p.oldText === "string" && typeof p.newText === "string") {
              current = current.replace(p.oldText, p.newText);
            }
            expectedBytes = Buffer.from(current, "utf8");
          }
        } catch {
          // ignore
        }
        localReversibleSpec = {
          targetPath,
          expectedAfterBytes: expectedBytes
        };
      }

      const leafId = walContext.sessionManager.getLeafId() ?? walContext.sessionId;

      const walRes = await executeThroughWalSpine({
        stateDb: walContext.stateDb,
        spillStore: walContext.spillStore,
        sessionId: walContext.sessionId,
        leafId,
        toolCallId,
        parentToolCallId: null,
        toolName: tool.name,
        mutabilityClass,
        args: params,
        localReversibleSpec,
        executeEffect: async () => {
          const res = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
          const rawText = (res.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          return {
            rawText,
            details: res.details
          };
        }
      });

      return {
        content: [{ type: "text", text: walRes.finalText }],
        details: walRes.details
      };
    }
  };
}

/**
 * Shared singleton helper preventing Pi Issue #11076 (subagents losing custom providers/credentials).
 */
export async function createSharedModelRuntime(agentDir: string = getAgentDir()): Promise<ModelRuntime> {
  installSafeNetworkDispatcher();
  return await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false
  });
}

export async function createRing0Harness(opts: Ring0HarnessOptions): Promise<Ring0HarnessInstance> {
  const durabilityMode = opts.durabilityMode ?? "crash-safe";
  const trustedRepo = opts.trustedRepo ?? true;
  const approvalPolicy = opts.approvalPolicy ?? (trustedRepo ? "on-request" : "untrusted");

  // 1. Cryptographically verify GUARDRAILS.yaml against compiled SHA-256 constant (Invariant I-11)
  const { config: guardrails } = loadVerifiedGuardrails(
    opts.guardrailsPath,
    opts.expectedGuardrailsSha256
  );

  // 2. Initialize StateDb (WAL + FTS5 CRUD triggers) & PrivateSpillStore (0700 / 0600 O_EXCL)
  const harnessDir = path.join(opts.workspaceRoot, ".harness");
  const stateDb = new StateDb(path.join(harnessDir, "state.db"), durabilityMode);
  const spillStore = new PrivateSpillStore({
    rootDir: path.join(harnessDir, "spill"),
    maxInlineBytes: guardrails.spill.max_inline_bytes,
    maxInlineLines: guardrails.spill.max_inline_lines,
    previewBytes: guardrails.spill.preview_bytes,
    cleanupDays: guardrails.spill.cleanup_days
  });
  spillStore.sweepExpiredSync();

  // 3. Build session-pinned prefix snapshot (MEMORY.md & AGENTS.md frozen in RAM for session lifetime)
  const prefix = buildBootPinnedPrefix({
    surfacesDir: opts.surfacesDir,
    workspaceRoot: opts.workspaceRoot,
    trustedRepo,
    caps: guardrails.prefix_caps_o200k
  });

  const sandboxMode = opts.sandboxMode ?? guardrails.sandbox.default_mode;
  const agentDir = opts.agentDir ?? getAgentDir();
  const modelRuntime = opts.modelRuntime ?? (await createSharedModelRuntime(agentDir));
  const sessionManager = opts.sessionManager ?? SessionManager.create(opts.workspaceRoot, path.join(harnessDir, "sessions"));
  const sessionId = sessionManager.getSessionId();

  // 4. Construct confined built-in Operations (Minimal-Rootfs bwrap + Secret-Masked FS + Durable Writes)
  const { readOps, writeOps, editOps } = createConfinedFileOperations({
    workspaceRoot: opts.workspaceRoot,
    cfg: guardrails,
    durabilityMode,
    mode: sandboxMode
  });

  const bashOps = createBwrapBashOperations({
    workspaceRoot: opts.workspaceRoot,
    mode: sandboxMode,
    unshareNet: guardrails.sandbox.unshare_network_by_default,
    allowUnsandboxedDev: opts.allowUnsandboxedDev ?? false,
    beforeAction: opts.beforeAction,
    unmaskedSecretExceptions: guardrails.sandbox.unmasked_exceptions
  });

  const rawBuiltins: ToolDefinition<any, any, any>[] = [
    createReadToolDefinition(opts.workspaceRoot, { operations: readOps }),
    createBashToolDefinition(opts.workspaceRoot, { operations: bashOps, exposeSessionEnvironment: false }),
    createEditToolDefinition(opts.workspaceRoot, { operations: editOps }),
    createWriteToolDefinition(opts.workspaceRoot, { operations: writeOps }),
    ...(opts.extraTools ?? [])
  ];

  const walContext = {
    stateDb,
    spillStore,
    sessionId,
    sessionManager,
    workspaceRoot: opts.workspaceRoot
  };

  const confinedBuiltins: ToolDefinition<any, any, any>[] = rawBuiltins.map((t) =>
    wrapToolDefinitionWithWal(t, walContext)
  );

  // 5. Startup Crash & Rewind Reconciliation
  reconcileWalOnStartup(stateDb, spillStore, sessionId);
  try {
    recoverInterruptedRewinds({
      stateDb,
      workspaceRoot: opts.workspaceRoot,
      sessionManager,
      sessionId,
      durabilityMode
    });
  } catch (err) {
    // RewindConflictError propagates fail-closed so user edits are never overwritten silently
    stateDb.close();
    throw err;
  }

  const observedPrefixHashes: string[] = [];
  const interceptedToolCalls: Ring0HarnessInstance["interceptedToolCalls"] = [];
  const transcriptSyncReceipts: Ring0HarnessInstance["transcriptSyncReceipts"] = [];
  const pendingRootToolCallIds = new Set<string>();
  let turnCounter = 0;
  let sessionRef: AgentSession | null = null;

  // 6. Core Ring-0 Extension Factory (intercepts BOTH Direct & Nested Codemode `<parentId>/<n>` calls!)
  const ring0CoreExtension: ExtensionFactory = (pi) => {
    const auditPrefix = () => {
      if (!sessionRef) return;
      const h = prefix.verifyInvariantBeforeRequest(sessionRef.systemPrompt, sessionRef.agent.state.tools);
      observedPrefixHashes.push(h);
    };

    pi.on("turn_start", async () => {
      auditPrefix();
    });

    pi.on("before_provider_request", async () => {
      auditPrefix();
    });

    pi.on("tool_call", async (event) => {
      try {
        assertNoUnresolvedOutcomeUnknown(stateDb, sessionId);

        if (event.toolName === "bash") {
          const cmd = String((event.input as { command?: string }).command ?? "");
          const verdict = evaluateShellCommandGuard({
            command: cmd,
            cfg: guardrails,
            approvalPolicy,
            unattendedRoutine: opts.unattendedRoutine
          });
          if (!verdict.allowed) {
            interceptedToolCalls.push({
              toolCallId: event.toolCallId,
              parentToolCallId: event.parentToolCallId ?? null,
              toolName: event.toolName,
              blocked: true,
              reason: verdict.reason
            });
            return { block: true, reason: verdict.reason };
          }
        } else if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
          const target = String((event.input as { path?: string }).path ?? "");
          const accessMode = event.toolName === "read" ? "read" : "write";
          resolveAndValidateWorkspacePath(target, opts.workspaceRoot, accessMode, guardrails, sandboxMode);
        }

        if (!event.parentToolCallId) {
          pendingRootToolCallIds.add(event.toolCallId);
        }
        interceptedToolCalls.push({
          toolCallId: event.toolCallId,
          parentToolCallId: event.parentToolCallId ?? null,
          toolName: event.toolName,
          blocked: false
        });
        return undefined;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        interceptedToolCalls.push({
          toolCallId: event.toolCallId,
          parentToolCallId: event.parentToolCallId ?? null,
          toolName: event.toolName,
          blocked: true,
          reason
        });
        return { block: true, reason };
      }
    });

    pi.on("tool_result", async (event) => {
      // Scrub secrets and spill oversized text blocks across all tool outputs
      let mutated = false;
      const nextContent = event.content.map((block) => {
        if (block.type !== "text") return block;
        const out = spillStore.scrubAndMaybeSpill(sessionId, block.text);
        if (out.text !== block.text) mutated = true;
        return { ...block, text: out.text };
      });
      if (mutated) {
        return {
          content: nextContent,
          structuredContent: event.structuredContent
        };
      }
      return undefined;
    });

    pi.on("turn_end", async () => {
      turnCounter += 1;
      // Synchronize session JSONL file (+ parent dir) in `power-loss-safe` mode BEFORE marking WAL trees TRANSCRIPT_APPENDED!
      if (pendingRootToolCallIds.size > 0) {
        const sessionFile = sessionManager.getSessionFile();
        const syncRes = syncSessionTranscriptDurable(
          sessionFile,
          stateDb.durabilityMode,
          sessionFile !== undefined || opts.sessionManager === undefined
        );
        transcriptSyncReceipts.push({
          sessionFile,
          fileSynced: syncRes.fileSynced,
          dirSynced: syncRes.dirSynced
        });
        for (const rootCallId of pendingRootToolCallIds) {
          markWalCallTreeTranscriptAppended(stateDb, sessionId, rootCallId, {
            transcriptSynced: syncRes.synced
          });
        }
        pendingRootToolCallIds.clear();
      }

      const leafId = sessionManager.getLeafId();
      if (leafId) {
        try {
          captureTurnCheckpoint({
            stateDb,
            workspaceRoot: opts.workspaceRoot,
            sessionId,
            leafId,
            turnIndex: turnCounter
          });
        } catch {
          // Non-git workspace tolerated gracefully unless /tree rewind invoked
        }
      }
    });
  };

  const activeDirectToolNames = [
    "read",
    "bash",
    "edit",
    "write",
    "codemode",
    ...(opts.extraTools?.map((t) => t.name) ?? [])
  ];

  const settingsManager =
    opts.settingsManager ??
    SettingsManager.inMemory({
      defaultTools: activeDirectToolNames
    });

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.workspaceRoot,
    agentDir,
    systemPromptOverride: () => prefix.frozenSystemPrompt,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      ring0CoreExtension,
      ...(opts.extraExtensions ?? [])
    ]
  });
  await resourceLoader.reload();

  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    cwd: opts.workspaceRoot,
    agentDir,
    modelRuntime,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    scopedModels: opts.scopedModels,
    sessionStartEvent: opts.sessionStartEvent,
    noTools: "builtin",
    customTools: confinedBuiltins,
    resourceLoader,
    settingsManager,
    sessionManager
  });
  session.setActiveToolsByName(activeDirectToolNames);
  sessionRef = session;

  // 7. Lock exact serialized effective prompt + active tool schemas & assert total o200k token budget (Invariant I-01)
  prefix.lockToolSchemasAndComputeHash(session.agent.state.tools, session.systemPrompt);

  return {
    session,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    extensionsResult,
    modelFallbackMessage,
    stateDb,
    spillStore,
    prefix,
    guardrails,
    bashOps,
    sandboxMode,
    observedPrefixHashes,
    interceptedToolCalls,
    transcriptSyncReceipts,
    dispose() {
      session.dispose();
      stateDb.close();
    }
  };
}
