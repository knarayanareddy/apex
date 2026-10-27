import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ShellSandboxGate } from "./shell-sandbox-gate.mjs";
import { WalLedger } from "./wal-ledger.mjs";

/**
 * Pi-Apex Reference Harness Engine
 * Implements exact Pi v1.4 contracts:
 *  - SessionManager v3 Tree-JSONL (`session`, `message`, `compaction`, `branch_summary`)
 *  - Byte-Frozen Prefix (`SYSTEM.md` + 6 Direct Tools) with SHA-256 Prefix Cache Verification
 *  - Codemode Sandbox (`searchTools`, `describeTool`, `await tools.<name>(args)`) with `<parentId>/<n>` nested hooks
 *  - SQLite WAL Intent Ledger + Idempotent Crash Recovery + `asOf` Forkable Documents
 *  - Git Tree Shadow Checkpoints (`git write-tree` / `git read-tree`) synced to `/tree` rewinds
 *  - Two-Tier LSP Feedback (file-local <=500ms on edit; workspace-wide on Verification Gate)
 *  - Trust-Gated Memory (`READ_ONLY` on untrusted repos + SHA-256 CAS Dreaming Consolidation)
 *  - Event-Driven Observer + Reconciler appending strictly to tail `toolResult`
 *  - 1-Level Isolated `git worktree` Worker Pool + Blind Post-Merge Reviewer
 *  - Sub-Second Zero-Token `.cassette.jsonl` Recorder & Deterministic CI Replayer
 */

export const FROZEN_DIRECT_TOOLS = Object.freeze([
  {
    name: "read",
    description: "Read UTF-8 file content from workspace with optional line range.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write",
    description: "Create or overwrite a file inside workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Replace exact text slice in an existing workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
  {
    name: "bash",
    description: "Execute command inside OS-sandboxed workspace shell.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "codemode",
    description:
      "Execute async JS in sandbox with `searchTools(q)`, `describeTool(name)`, and `await tools.<name>(args)`.",
    parameters: { type: "object", properties: { script: { type: "string" } }, required: ["script"] },
  },
  {
    name: "delegate_workers",
    description:
      "Spawn 1-level parallel git-worktree child workers on disjoint file scopes, followed by blind diff review.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              spec: { type: "string" },
              ownedFiles: { type: "array", items: { type: "string" } },
            },
            required: ["id", "spec", "ownedFiles"],
          },
        },
      },
      required: ["tasks"],
    },
  },
]);

export function estimateTokens(str) {
  // Conservative ~3.8 chars/token heuristic for English + JSON schemas
  return Math.ceil(Buffer.byteLength(str, "utf8") / 3.8);
}

export class PiApexHarness {
  constructor(opts) {
    this.cwd = opts.cwd;
    this.surfacesDir = opts.surfacesDir;
    this.trusted = Boolean(opts.trusted);
    this.depth = opts.depth ?? 0; // 0 = root lead, 1 = worktree child
    this.sessionId = opts.sessionId ?? `sess_${crypto.randomBytes(6).toString("hex")}`;
    this.providerSessionAffinityId = opts.providerSessionAffinityId ?? crypto.randomUUID();
    this.harnessDir = path.join(this.cwd, ".harness");
    fs.mkdirSync(path.join(this.harnessDir, "spill"), { recursive: true });
    fs.mkdirSync(path.join(this.harnessDir, "sessions"), { recursive: true });

    this.jsonlPath =
      opts.jsonlPath ?? path.join(this.harnessDir, "sessions", `${this.sessionId}.jsonl`);
    this.dbPath = opts.dbPath ?? path.join(this.harnessDir, "state.sqlite");
    this.wal = opts.sharedWal ?? new WalLedger(this.dbPath);
    this.ownsWal = !opts.sharedWal;

    this.shellGate = new ShellSandboxGate(opts.guardrails ?? {});
    this.hiddenTools = new Map(); // exposure: "codemode" MCP + auxiliary tools (NEVER sent in LLM tools[])
    this.entries = new Map();
    this.leafId = null;

    // Verification state tracking
    this.dirtySourceFiles = new Set();
    this.verifiedSinceLastMutation = true;
    this.consecutiveToolErrors = 0;
    this.pendingAdvisories = [];
    this.prefixAuditTrail = [];

    // Cassette Recording / Replay
    this.cassetteMode = opts.cassetteMode ?? "off"; // "off" | "record" | "replay"
    this.cassettePath = opts.cassettePath ?? path.join(this.harnessDir, "run.cassette.jsonl");
    this.cassetteCursor = 0;
    this.cassetteFrames =
      this.cassetteMode === "replay" && fs.existsSync(this.cassettePath)
        ? fs
            .readFileSync(this.cassettePath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];

    // Assemble & freeze immutable prompt + tool schema prefix ONCE at boot
    this.frozenSystemPrompt = this._assembleFrozenSystemPrompt();
    this.frozenTools =
      this.depth === 0
        ? FROZEN_DIRECT_TOOLS
        : Object.freeze(FROZEN_DIRECT_TOOLS.filter((t) => t.name !== "delegate_workers"));

    this._initOrLoadSessionTree();
    this._registerBuiltInCodemodeTools();
  }

  _assembleFrozenSystemPrompt() {
    const sys = fs.readFileSync(path.join(this.surfacesDir, "SYSTEM.md"), "utf8").trim();
    const guidance = fs.readFileSync(path.join(this.surfacesDir, "TOOL_GUIDANCE.md"), "utf8").trim();
    const memPath = path.join(this.surfacesDir, "MEMORY.md");
    const mem = fs.existsSync(memPath) ? fs.readFileSync(memPath, "utf8").trim() : "";
    const trustBanner = this.trusted
      ? "TRUST_STATE: TRUSTED_WORKSPACE"
      : "TRUST_STATE: UNTRUSTED_WORKSPACE (Project MCP disabled; MEMORY.md & skills mounted READ_ONLY)";
    return `${sys}\n\n${guidance}\n\n${mem}\n\n[${trustBanner}]`;
  }

  getBasePrefixTokenEstimate() {
    const payload = JSON.stringify({
      systemPrompt: this.frozenSystemPrompt,
      tools: this.frozenTools,
    });
    return {
      bytes: Buffer.byteLength(payload, "utf8"),
      tokens: estimateTokens(payload),
      directToolCount: this.frozenTools.length,
      hiddenCodemodeToolCount: this.hiddenTools.size,
    };
  }

  _initOrLoadSessionTree() {
    if (!fs.existsSync(this.jsonlPath)) {
      const header = {
        type: "session",
        version: 3,
        id: this.sessionId,
        providerSessionId: this.providerSessionAffinityId,
        timestamp: new Date().toISOString(),
        cwd: this.cwd,
      };
      fs.writeFileSync(this.jsonlPath, JSON.stringify(header) + "\n", "utf8");
      return;
    }
    const lines = fs.readFileSync(this.jsonlPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.type === "session") continue;
      this.entries.set(obj.id, obj);
      this.leafId = obj.id;
    }
  }

  _appendEntry(type, fields) {
    const id = `e_${crypto.randomBytes(4).toString("hex")}`;
    const entry = {
      type,
      id,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      ...fields,
    };
    fs.appendFileSync(this.jsonlPath, JSON.stringify(entry) + "\n", "utf8");
    this.entries.set(id, entry);
    this.leafId = id;
    return entry;
  }

  getAncestorChain(fromId = this.leafId) {
    const chain = [];
    let cur = fromId;
    while (cur) {
      chain.push(cur);
      const entry = this.entries.get(cur);
      cur = entry ? entry.parentId : null;
    }
    return chain;
  }

  getActiveMessages() {
    const chainIds = this.getAncestorChain().reverse();
    const msgs = [];
    for (const id of chainIds) {
      const e = this.entries.get(id);
      if (e.type === "message") msgs.push(e.message);
      else if (e.type === "branch_summary") {
        msgs.push({
          role: "user",
          content: `<branch_summary from="${e.fromId}">${e.summary}</branch_summary>`,
        });
      }
    }
    return msgs;
  }

  /**
   * Registers MCP or auxiliary tools at `exposure: "codemode"`.
   * Zero bytes are added to `this.frozenSystemPrompt` or `this.frozenTools`!
   */
  registerCodemodeTool(def) {
    this.hiddenTools.set(def.name, def);
  }

  /**
   * Simulates Pi's `project_trust` gate when discovering `.pi/mcp.json` in a cloned repo.
   */
  loadProjectMcpConfig() {
    const repoMcp = path.join(this.cwd, ".pi", "mcp.json");
    if (!fs.existsSync(repoMcp)) return { loaded: 0, blockedByTrustGate: false };
    if (!this.trusted) {
      return {
        loaded: 0,
        blockedByTrustGate: true,
        reason: "PROJECT_TRUST_GATE: Refused to spawn untrusted repo .pi/mcp.json servers",
      };
    }
    const parsed = JSON.parse(fs.readFileSync(repoMcp, "utf8"));
    return { loaded: Object.keys(parsed.mcpServers || {}).length, blockedByTrustGate: false };
  }

  _registerBuiltInCodemodeTools() {
    this.registerCodemodeTool({
      name: "session_search",
      description: "Search past episodic session transcripts via SQLite FTS5.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: async ({ query }) => {
        const res = await this.wal.call("search_episodes", { query, limit: 5 });
        return res.hits;
      },
    });

    this.registerCodemodeTool({
      name: "memory_update",
      description: "Update global MEMORY.md with optimistic SHA-256 concurrency check.",
      parameters: {
        type: "object",
        properties: { expectedSha256: { type: "string" }, newContent: { type: "string" } },
        required: ["expectedSha256", "newContent"],
      },
      execute: async ({ expectedSha256, newContent }) => {
        if (!this.trusted) {
          throw new Error("MEMORY_TRUST_LOCK: Untrusted workspace cannot mutate global MEMORY.md");
        }
        const memPath = path.join(this.surfacesDir, "MEMORY.md");
        const current = fs.readFileSync(memPath, "utf8");
        const actualSha = crypto.createHash("sha256").update(current).digest("hex");
        if (actualSha !== expectedSha256) {
          throw new Error(`CAS_CONFLICT: expected ${expectedSha256}, found ${actualSha}`);
        }
        if (estimateTokens(newContent) > 800) {
          throw new Error(`MEMORY_TOKEN_CAP: exceeds 800-token hard limit`);
        }
        fs.writeFileSync(memPath, newContent, "utf8");
        return { ok: true, sha256: crypto.createHash("sha256").update(newContent).digest("hex") };
      },
    });
  }

  /**
   * Captures a zero-copy Git Tree OID (`git write-tree` on a temporary index)
   * so `/tree` rewinds restore BOTH conversation branch AND exact disk files!
   */
  async snapshotGitWorkspace(entryId) {
    const tmpIdx = path.join(this.harnessDir, `idx_${process.pid}_${Date.now()}`);
    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIdx };
      const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: this.cwd,
        encoding: "utf8",
      });
      if (head.status === 0) {
        execFileSync("git", ["read-tree", "HEAD"], { cwd: this.cwd, env });
      }
      execFileSync("git", ["add", "-A", "--", ".", ":!.harness"], { cwd: this.cwd, env });
      const treeOid = execFileSync("git", ["write-tree"], {
        cwd: this.cwd,
        env,
        encoding: "utf8",
      }).trim();
      await this.wal.call("put_checkpoint", {
        sessionId: this.sessionId,
        entryId,
        gitTreeOid: treeOid,
      });
      return treeOid;
    } finally {
      if (fs.existsSync(tmpIdx)) fs.unlinkSync(tmpIdx);
    }
  }

  /**
   * Pi `/tree` navigation enhanced with Git Tree Workspace Restoration + `BranchSummaryEntry`.
   */
  async rewindTreeTo(targetEntryId, summaryOfAbandonedBranch) {
    const previousLeaf = this.leafId;
    if (!this.entries.has(targetEntryId)) {
      throw new Error(`Unknown target entry ${targetEntryId}`);
    }
    const cp = await this.wal.call("get_checkpoint", {
      sessionId: this.sessionId,
      entryId: targetEntryId,
    });
    if (cp.gitTreeOid) {
      execFileSync("git", ["read-tree", "--reset", "-u", cp.gitTreeOid], { cwd: this.cwd });
      // Clean untracked files outside .harness
      execFileSync("git", ["clean", "-fd", "-e", ".harness"], { cwd: this.cwd });
    }
    this.leafId = targetEntryId;
    if (summaryOfAbandonedBranch) {
      this._appendEntry("branch_summary", {
        fromId: previousLeaf,
        summary: summaryOfAbandonedBranch,
      });
    }
    this.dirtySourceFiles.clear();
    this.verifiedSinceLastMutation = true;
    return { restoredLeafId: this.leafId, restoredGitTreeOid: cp.gitTreeOid };
  }

  /**
   * Crash-recovery reconciliation on daemon startup (`reconcileOrphanedIntents`).
   * Never double-executes an `EFFECT_COMMITTED` write!
   */
  async reconcileAfterCrash() {
    const { orphans } = await this.wal.call("reconcile_orphans", { sessionId: this.sessionId });
    const recovered = [];
    for (const row of orphans) {
      if (row.status === "EFFECT_COMMITTED" && row.result_json) {
        const parsedResult = JSON.parse(row.result_json);
        const entry = this._appendEntry("message", {
          message: {
            role: "toolResult",
            toolCallId: row.tool_call_id,
            toolName: row.tool_name,
            content: parsedResult.content,
            isError: Boolean(parsedResult.isError),
          },
        });
        await this.wal.call("mark_appended", { idempotencyKey: row.idempotency_key });
        recovered.push({
          toolCallId: row.tool_call_id,
          action: "REPLAYED_COMMITTED_EFFECT_ZERO_REEXECUTION",
          entryId: entry.id,
        });
      } else {
        // Uncertain `EXECUTING` or `INTENT_LOGGED` mutating call: fail closed instead of hidden retry!
        const errText = `UNCERTAIN_CRASH_INTERRUPTION: Tool '${row.tool_name}' (${row.tool_call_id}) crashed in state ${row.status}. Inspect workspace before retrying.`;
        const entry = this._appendEntry("message", {
          message: {
            role: "toolResult",
            toolCallId: row.tool_call_id,
            toolName: row.tool_name,
            content: errText,
            isError: true,
          },
        });
        await this.wal.call("mark_appended", { idempotencyKey: row.idempotency_key });
        recovered.push({
          toolCallId: row.tool_call_id,
          action: "FAILED_CLOSED_NO_HIDDEN_RETRY",
          entryId: entry.id,
        });
      }
    }
    return recovered;
  }

  /**
   * Computes exact SHA-256 of the static prefix (`systemPrompt + tools`) and prior message prefix
   * before sending to LLM provider, proving 100% KV-cache stability.
   */
  _recordPrefixAudit(messages) {
    const basePrefixHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ system: this.frozenSystemPrompt, tools: this.frozenTools }))
      .digest("hex");

    const priorTranscriptHash =
      messages.length > 1
        ? crypto
            .createHash("sha256")
            .update(JSON.stringify(messages.slice(0, -1)))
            .digest("hex")
        : null;

    const record = {
      turnIndex: this.prefixAuditTrail.length + 1,
      basePrefixHash,
      messageCount: messages.length,
      priorTranscriptHash,
      fullTranscriptHash: crypto.createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
    };
    this.prefixAuditTrail.push(record);
    return record;
  }

  /**
   * Tier-1 File-Local LSP Diagnostic Simulator (<50ms, file-scoped, capped <=10 lines).
   * Catches local syntax/type annotations without panicking over unedited downstream callers.
   */
  _runTier1FileLocalLsp(relPath) {
    const abs = path.join(this.cwd, relPath);
    if (!fs.existsSync(abs) || !/\.(js|mjs|ts)$/.test(relPath)) return [];
    const src = fs.readFileSync(abs, "utf8");
    const diags = [];

    // Check unbalanced braces / syntax errors via `node --check` for .mjs/.js
    if (/\.(js|mjs)$/.test(relPath)) {
      const chk = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
      if (chk.status !== 0) {
        diags.push(
          ...chk.stderr
            .trim()
            .split("\n")
            .slice(0, 5)
            .map((l) => `[LSP:Syntax] ${l}`)
        );
      }
    }
    // Lightweight local type-contract marker for test demonstration
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (line.includes("__TYPE_ERROR__")) {
        diags.push(`[LSP:${relPath}:${i + 1}] TS2322: Type 'string' is not assignable to type 'number'.`);
      }
    });
    return diags.slice(0, 10);
  }

  /**
   * Event-Driven Observer + Reconciler.
   * Fires ONLY when triggered (e.g., >=2 consecutive tool errors), matches local `skills/`,
   * and queues a compact `<advisory>` appended strictly to the TAIL `toolResult`.
   */
  _maybeTriggerObserverReconciler(lastErrorText) {
    if (this.consecutiveToolErrors < 2) return null;
    const skillsRoot = path.join(this.surfacesDir, "skills");
    if (!fs.existsSync(skillsRoot)) return null;
    for (const dir of fs.readdirSync(skillsRoot)) {
      const skillFile = path.join(skillsRoot, dir, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const raw = fs.readFileSync(skillFile, "utf8");
      if (
        (lastErrorText.includes("TS2345") || lastErrorText.includes("signature mismatch")) &&
        dir === "api-refactor"
      ) {
        // Reconciler deduplication: never emit same skill twice in one session branch
        if (this._emittedSkill === dir) return null;
        this._emittedSkill = dir;
        return `<reconciler_advisory source="skill_matcher" skill="${dir}">\nDetected repeated signature error. Load guidance:\n${raw.trim()}\n</reconciler_advisory>`;
      }
    }
    return null;
  }

  /**
   * Truncates oversized tool outputs (e.g., >8KB or >200 lines) and spills full raw output to `.harness/spill/`.
   */
  _applySpillPolicy(toolCallId, text) {
    const maxBytes = 8192;
    const maxLines = 200;
    const lines = text.split("\n");
    if (Buffer.byteLength(text, "utf8") <= maxBytes && lines.length <= maxLines) {
      return { text, spilledPath: null };
    }
    const spillPath = path.join(this.harnessDir, "spill", `${toolCallId.replace(/\//g, "_")}.log`);
    fs.writeFileSync(spillPath, text, "utf8");
    const preview = lines.slice(0, 40).join("\n").slice(0, 2048);
    return {
      text: `${preview}\n\n[OUTPUT_TRUNCATED: ${Buffer.byteLength(text, "utf8")} bytes / ${lines.length} lines. Full raw output saved to ${ path.relative(this.cwd, spillPath) } — inspect specific ranges with read/bash.]`,
      spilledPath: spillPath,
    };
  }

  /**
   * Executes a single tool call through Pi's exact hook pipeline:
   *   `tool_call` (Preflight Gate + WAL Intent Lease) -> Execute -> `tool_result` (LSP + Spill + Reconciler)
   */
  async executeToolPipeline(toolCall, opts = {}) {
    const { id: toolCallId, name: toolName, args } = toolCall;
    const mutating = ["write", "edit", "bash", "delegate_workers"].includes(toolName);

    // 1. `tool_call` Hook: Deterministic Security & Depth Gates BEFORE WAL Execution
    if (toolName === "delegate_workers" && this.depth >= 1) {
      return this._finalizeToolResult(toolCall, {
        content: "SUBAGENT_DEPTH_GATE: Child workers (depth=1) are forbidden from spawning grandchildren.",
        isError: true,
        persistTranscript: opts.persistTranscript ?? true,
      });
    }

    if (toolName === "bash") {
      const verdict = this.shellGate.inspectCommand(args.command);
      if (verdict.block) {
        return this._finalizeToolResult(toolCall, {
          content: verdict.reason,
          isError: true,
          persistTranscript: opts.persistTranscript ?? true,
        });
      }
    }

    if ((toolName === "write" || toolName === "edit") && !this.trusted) {
      const targetAbs = path.resolve(this.cwd, args.path);
      if (targetAbs.startsWith(path.resolve(this.surfacesDir))) {
        return this._finalizeToolResult(toolCall, {
          content: "MEMORY_TRUST_LOCK: Untrusted workspace cannot write to harness surfaces or MEMORY.md.",
          isError: true,
          persistTranscript: opts.persistTranscript ?? true,
        });
      }
    }

    // 2. Write-Ahead Intent Log & Idempotency Lease in SQLite WAL
    const { idempotencyKey, canonicalArgs } = WalLedger.computeIdempotencyKey(
      this.sessionId,
      this.leafId ?? "root",
      toolCallId,
      toolName,
      args
    );

    const intentRes = await this.wal.call("log_intent", {
      idempotencyKey,
      sessionId: this.sessionId,
      leafEntryId: this.leafId ?? "root",
      toolCallId,
      toolName,
      canonicalArgs,
      mutating,
      leaseOwner: `pid_${process.pid}`,
    });

    if (
      intentRes.existing &&
      (intentRes.existing.status === "EFFECT_COMMITTED" ||
        intentRes.existing.status === "TRANSCRIPT_APPENDED")
    ) {
      const cached = JSON.parse(intentRes.existing.result_json);
      return this._finalizeToolResult(toolCall, {
        ...cached,
        idempotencyKey,
        fromWalCache: true,
        persistTranscript: opts.persistTranscript ?? true,
      });
    }

    await this.wal.call("mark_executing", { idempotencyKey });

    // 3. Execute Core Tool (or Replay Deterministic Leaf Tool Fixture if in Cassette Replay mode;
    //    `codemode` always runs its deterministic VM script so nested `<parentId>/<n>` hooks & leaf fixtures execute!)
    let rawOutput = "";
    let isError = false;
    try {
      if (this.cassetteMode === "replay" && toolName !== "codemode") {
        const frame = this._nextCassetteFrame("tool_fixture", toolCallId);
        rawOutput = frame.content;
        isError = frame.isError;
      } else {
        rawOutput = await this._dispatchToolImpl(toolCall);
      }
    } catch (err) {
      rawOutput = `ERROR: ${err.message}`;
      isError = true;
    }

    // 4. `tool_result` Enrichment: Tier-1 File-Local LSP + Spill-to-Disk + Reconciler Advisory
    if (!isError && (toolName === "write" || toolName === "edit")) {
      this.dirtySourceFiles.add(args.path);
      this.verifiedSinceLastMutation = false;
      const lspDiags = this._runTier1FileLocalLsp(args.path);
      if (lspDiags.length > 0) {
        rawOutput += `\n\n<lsp_tier1 file="${args.path}">\n${lspDiags.join("\n")}\n</lsp_tier1>`;
      }
    }

    if (toolName === "bash" && !isError && /\b(node\s+--test|npm\s+test|pytest)\b/.test(args.command)) {
      this.verifiedSinceLastMutation = true;
    }

    if (isError) {
      this.consecutiveToolErrors++;
      const advisory = this._maybeTriggerObserverReconciler(rawOutput);
      if (advisory) rawOutput += `\n\n${advisory}`;
    } else {
      this.consecutiveToolErrors = 0;
    }

    const spilled = this._applySpillPolicy(toolCallId, rawOutput);
    const resultPayload = { content: spilled.text, isError, spilledPath: spilled.spilledPath };

    if (this.cassetteMode === "record" && toolName !== "codemode") {
      this._recordCassetteFrame({
        kind: "tool_fixture",
        toolCallId,
        toolName,
        content: rawOutput,
        isError,
      });
    }

    // 5. Commit Effect to WAL *BEFORE* Transcript Append
    await this.wal.call("commit_effect", { idempotencyKey, result: resultPayload });

    // Fault-injection hook for Scenario 5 (Simulate `SIGKILL` right after side-effect commits!)
    if (opts.simulateCrashAfterWalCommit) {
      throw new Error("SIMULATED_SIGKILL_AFTER_WAL_COMMIT");
    }

    return this._finalizeToolResult(toolCall, {
      ...resultPayload,
      idempotencyKey,
      persistTranscript: opts.persistTranscript ?? true,
    });
  }

  async _finalizeToolResult(toolCall, { content, isError, idempotencyKey, fromWalCache, spilledPath, persistTranscript }) {
    let entry = null;
    if (persistTranscript) {
      entry = this._appendEntry("message", {
        message: {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content,
          isError: Boolean(isError),
        },
      });
      await this.wal.call("index_episode", {
        sessionId: this.sessionId,
        entryId: entry.id,
        role: "toolResult",
        toolName: toolCall.name,
        content,
      });
    }
    if (idempotencyKey) {
      await this.wal.call("mark_appended", { idempotencyKey });
    }
    return { content, isError: Boolean(isError), entryId: entry?.id, fromWalCache: Boolean(fromWalCache), spilledPath };
  }

  async _dispatchToolImpl(toolCall) {
    const { id: parentId, name, args } = toolCall;
    if (name === "read") {
      return fs.readFileSync(path.join(this.cwd, args.path), "utf8");
    }
    if (name === "write") {
      const target = path.join(this.cwd, args.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, args.content, "utf8");
      return `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
    }
    if (name === "edit") {
      const target = path.join(this.cwd, args.path);
      const cur = fs.readFileSync(target, "utf8");
      if (!cur.includes(args.oldText)) {
        throw new Error(`edit oldText not found in ${args.path}`);
      }
      const updated = cur.replace(args.oldText, args.newText);
      fs.writeFileSync(target, updated, "utf8");
      return `Edited ${args.path}`;
    }
    if (name === "bash") {
      const res = spawnSync("bash", ["-c", args.command], {
        cwd: this.cwd,
        encoding: "utf8",
        timeout: 15000,
      });
      if (res.status !== 0) {
        throw new Error(`Exit ${res.status}: ${(res.stderr || res.stdout || "").trim()}`);
      }
      return (res.stdout + (res.stderr ? `\n${res.stderr}` : "")).trim() || "(exit 0)";
    }
    if (name === "codemode") {
      return this._runCodemodeSandbox(parentId, args.script);
    }
    if (name === "delegate_workers") {
      return this._runWorktreeWorkers(args.tasks, args._workerDrivers, args._blindReviewerFn);
    }
    // Nested hidden MCP/auxiliary tool call
    if (this.hiddenTools.has(name)) {
      const out = await this.hiddenTools.get(name).execute(args);
      return typeof out === "string" ? out : JSON.stringify(out);
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Executes model-written JavaScript inside an isolated VM context (`Codemode`),
   * routing nested `tools.<name>(args)` calls through `executeToolPipeline` with `<parentId>/<n>` IDs!
   */
  async _runCodemodeSandbox(parentToolCallId, script) {
    let nestedSeq = 0;
    const logs = [];
    const toolsProxy = new Proxy(
      {},
      {
        get: (_target, prop) => async (callArgs = {}) => {
          const nestedId = `${parentToolCallId}/${nestedSeq++}`;
          const res = await this.executeToolPipeline(
            { id: nestedId, name: String(prop), args: callArgs },
            { persistTranscript: false } // Only final codemode script output reaches LLM transcript!
          );
          if (res.isError) throw new Error(res.content);
          try {
            return JSON.parse(res.content);
          } catch {
            return res.content;
          }
        },
      }
    );

    const sandboxGlobals = {
      console: { log: (...a) => logs.push(a.map(String).join(" ")) },
      Promise,
      JSON,
      searchTools: (query = "") => {
        const q = query.toLowerCase();
        return [...this.hiddenTools.values()]
          .filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
          .map((t) => ({ name: t.name, description: t.description }));
      },
      describeTool: (toolName) => {
        const t = this.hiddenTools.get(toolName);
        if (!t) return null;
        return { name: t.name, description: t.description, parameters: t.parameters };
      },
      tools: toolsProxy,
    };

    const ctx = vm.createContext(sandboxGlobals);
    const wrapped = `(async () => {\n${script}\n})()`;
    const value = await vm.runInContext(wrapped, ctx, { timeout: 5000 });
    return JSON.stringify({ returnValue: value ?? null, logs, nestedCallsExecuted: nestedSeq });
  }

  /**
   * Spawns 1-Level Isolated `git worktree` Workers, merges them in a staging worktree,
   * runs integration tests, and gates merge on a fresh-context Blind Reviewer!
   */
  async _runWorktreeWorkers(tasks, workerDrivers = {}, blindReviewerFn = null) {
    // 1. Validate disjoint file ownership across parallel workers (DAG collision prevention)
    const claimed = new Map();
    for (const t of tasks) {
      for (const f of t.ownedFiles) {
        if (claimed.has(f)) {
          throw new Error(
            `DAG_OWNERSHIP_COLLISION: File '${f}' claimed by both '${claimed.get(f)}' and '${t.id}'`
          );
        }
        claimed.set(f, t.id);
      }
    }

    const wtRoot = fs.mkdtempSync(path.join("/tmp", "pi-apex-wt-"));
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: this.cwd, encoding: "utf8" }).trim();
    const workerReports = [];

    try {
      // 2. Run 1-level workers concurrently in real isolated `git worktree` checkouts
      await Promise.all(
        tasks.map(async (task) => {
          const wtPath = path.join(wtRoot, task.id);
          const branchName = `apex-worker-${task.id}-${Date.now()}`;
          execFileSync("git", ["worktree", "add", "-b", branchName, wtPath, baseSha], {
            cwd: this.cwd,
            stdio: "pipe",
          });

          const childHarness = new PiApexHarness({
            cwd: wtPath,
            surfacesDir: this.surfacesDir,
            trusted: this.trusted,
            depth: this.depth + 1, // depth = 1 -> `delegate_workers` stripped & hard-blocked!
            sessionId: `${this.sessionId}_w_${task.id}`,
            sharedWal: this.wal,
          });

          const driver = workerDrivers[task.id];
          const driverOut = driver ? await driver(childHarness, task) : null;

          execFileSync("git", ["add", "-A", "--", ".", ":!.harness"], { cwd: wtPath });
          execFileSync("git", ["commit", "-m", `worker(${task.id}): ${task.spec}`], {
            cwd: wtPath,
            stdio: "pipe",
          });
          workerReports.push({ taskId: task.id, branchName, wtPath, driverOut });
        })
      );

      // 3. Create isolated Staging Merge Worktree to test combined diff BEFORE touching user checkout!
      const stagePath = path.join(wtRoot, "_staging_merge");
      const stageBranch = `apex-staging-${Date.now()}`;
      execFileSync("git", ["worktree", "add", "-b", stageBranch, stagePath, baseSha], {
        cwd: this.cwd,
        stdio: "pipe",
      });

      for (const w of workerReports) {
        execFileSync("git", ["merge", "--no-edit", w.branchName], { cwd: stagePath, stdio: "pipe" });
      }

      const combinedDiff = execFileSync("git", ["diff", baseSha, "HEAD"], {
        cwd: stagePath,
        encoding: "utf8",
      });
      const testRun = spawnSync("node", ["--test"], { cwd: stagePath, encoding: "utf8" });
      const testPassed = testRun.status === 0;

      // 4. Blind Reviewer: Fresh context seeing ONLY { specs, combinedDiff, testOutput } — ZERO worker rationalizations!
      const blindInput = Object.freeze({
        specs: tasks.map((t) => ({ id: t.id, spec: t.spec })),
        combinedDiff,
        testExitCode: testRun.status,
        testOutput: (testRun.stdout + "\n" + testRun.stderr).trim(),
      });

      const reviewVerdict = blindReviewerFn
        ? await blindReviewerFn(blindInput)
        : { approved: testPassed && combinedDiff.length > 0, score: testPassed ? 95 : 20 };

      if (!reviewVerdict.approved) {
        throw new Error(`BLIND_REVIEW_REJECTED: ${reviewVerdict.reason ?? "Failed review gate"}`);
      }

      // 5. Fast-forward lead branch to verified staging commit
      const mergedSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: stagePath,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["merge", "--ff-only", mergedSha], { cwd: this.cwd, stdio: "pipe" });
      this.verifiedSinceLastMutation = true;

      return JSON.stringify({
        mergedSha,
        workersCompleted: workerReports.map((w) => ({ id: w.taskId, driverOut: w.driverOut })),
        blindReview: reviewVerdict,
      });
    } finally {
      // Cleanup git worktrees cleanly
      spawnSync("git", ["worktree", "prune"], { cwd: this.cwd });
      fs.rmSync(wtRoot, { recursive: true, force: true });
    }
  }

  _recordCassetteFrame(frame) {
    fs.appendFileSync(this.cassettePath, JSON.stringify(frame) + "\n", "utf8");
  }

  _nextCassetteFrame(expectedKind, expectedId) {
    const frame = this.cassetteFrames[this.cassetteCursor++];
    if (!frame || frame.kind !== expectedKind) {
      throw new Error(
        `CASSETTE_MISMATCH at cursor ${this.cassetteCursor - 1}: expected ${expectedKind} (${expectedId}), got ${JSON.stringify(frame)}`
      );
    }
    return frame;
  }

  /**
   * Executes an end-to-end multi-turn prompt loop (`prompt()`), enforcing:
   *  - Prefix SHA-256 invariance across turns
   *  - `shouldStopAfterTurn` Deterministic Verification Gate (blocks premature stop when dirty edits weren't tested)
   *  - Git Tree Shadow Checkpointing at every turn boundary
   */
  async runPrompt(userText, modelResponderFn) {
    if (this.cassetteMode === "record" && !this._recordedCatalogInit) {
      this._recordedCatalogInit = true;
      this._recordCassetteFrame({
        kind: "mcp_catalog_snapshot",
        catalog: [...this.hiddenTools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    } else if (this.cassetteMode === "replay" && this.cassetteCursor === 0 && this.cassetteFrames[0]?.kind === "mcp_catalog_snapshot") {
      const snap = this._nextCassetteFrame("mcp_catalog_snapshot");
      for (const item of snap.catalog) {
        if (!this.hiddenTools.has(item.name)) {
          this.registerCodemodeTool({
            ...item,
            execute: async () => {
              throw new Error(`Live MCP execution forbidden during replay for ${item.name}`);
            },
          });
        }
      }
    }

    const userEntry = this._appendEntry("message", {
      message: { role: "user", content: userText },
    });
    await this.wal.call("index_episode", {
      sessionId: this.sessionId,
      entryId: userEntry.id,
      role: "user",
      content: userText,
    });
    await this.snapshotGitWorkspace(userEntry.id);

    let safetyMaxTurns = 12;
    let finalAssistantText = "";

    while (safetyMaxTurns-- > 0) {
      const activeMessages = this.getActiveMessages();
      const prefixAudit = this._recordPrefixAudit(activeMessages);

      // Call Provider (or Replay Zero-Token Cassette Frame)
      let assistantTurn;
      if (this.cassetteMode === "replay") {
        assistantTurn = this._nextCassetteFrame("assistant_turn").turn;
      } else {
        assistantTurn = await modelResponderFn({
          systemPrompt: this.frozenSystemPrompt,
          tools: this.frozenTools,
          messages: activeMessages,
          prefixAudit,
        });
        if (this.cassetteMode === "record") {
          this._recordCassetteFrame({ kind: "assistant_turn", turn: assistantTurn });
        }
      }

      const asstEntry = this._appendEntry("message", {
        message: {
          role: "assistant",
          content: assistantTurn.text ?? "",
          toolCalls: assistantTurn.toolCalls ?? [],
        },
      });

      if (assistantTurn.toolCalls && assistantTurn.toolCalls.length > 0) {
        for (const tc of assistantTurn.toolCalls) {
          await this.executeToolPipeline(tc);
        }
        await this.snapshotGitWorkspace(this.leafId);
        continue;
      }

      // No tool calls -> Assistant wants to finish! Run Deterministic Verification Gate!
      if (this.dirtySourceFiles.size > 0 && !this.verifiedSinceLastMutation) {
        const dirtyList = [...this.dirtySourceFiles].join(", ");
        this._appendEntry("message", {
          message: {
            role: "user",
            content: `<verification_gate_blocked>Cannot finish turn: modified source files [${dirtyList}] have not been verified by a passing test run since the last edit. Run tests now.</verification_gate_blocked>`,
          },
        });
        continue;
      }

      finalAssistantText = assistantTurn.text ?? "";
      await this.snapshotGitWorkspace(asstEntry.id);
      break;
    }

    return { finalAssistantText, leafId: this.leafId, prefixAuditTrail: this.prefixAuditTrail };
  }

  close() {
    if (this.ownsWal) this.wal.close();
  }
}
