/**
 * Ring 2 — Interactive Planning, Structured Trust Artifacts, & Inline Comment `steer()`
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/plan-mode/utils.ts`
 *    & `examples/extensions/plan-mode/index.ts` (MIT License, Earendil Works):
 *    - `DESTRUCTIVE_PATTERNS`, `SAFE_PATTERNS`, `isSafeCommand`, `TodoItem`,
 *      `cleanStepText`, `extractTodoItems`, `extractDoneSteps`, `markCompletedSteps`.
 *    - Hardening applied over upstream `utils.ts`: upstream `SAFE_PATTERNS` only anchored
 *      command start (`^\s*cat\b`), which allowed compound shell chaining (`cat a && curl -X POST ...`)
 *      unless caught by `DESTRUCTIVE_PATTERNS`. We reject shell chaining/subshell metacharacters
 *      in Plan Mode AND run Ring 0's `evaluateShellCommand()` monotonic guard.
 * 2. `@earendil-works/pi-coding-agent@1.4.0` — `AgentSession.steer()` & `sendCustomMessage()`
 *    combined with Antigravity 2.0 structured Trust Artifacts (`plan`, `diff`, `verification`)
 *    for line-anchored inline review comment injection without mutating the static prefix (`I-01`/`I-02`).
 */

import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DurabilityMode, GuardrailsConfig } from "../types.ts";
import { evaluateShellCommandGuard } from "../core/monotonic-guard.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";

// ============================================================================
// Upstream `@earendil-works/pi-coding-agent` (`examples/extensions/plan-mode/utils.ts`)
// ============================================================================

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|worktree\s+(add|remove|prune))/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i
];

const SAFE_PATTERNS: readonly RegExp[] = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|merge-base)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python3?\s+--version/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/
];

/**
 * Reject compound shell chaining (`&&`, `||`, `;`, newlines) and subshell expansion
 * in Plan Mode unless every pipeline stage is itself an allowlisted read-only command.
 */
function hasUnsafePlanShellComposition(command: string): boolean {
  if (/[;\n`]|[$]\(|\|\||&&/.test(command)) {
    return true;
  }
  const pipeStages = command.split("|").map((s) => s.trim());
  if (pipeStages.length > 1) {
    return pipeStages.some(
      (stage) => DESTRUCTIVE_PATTERNS.some((p) => p.test(stage)) || !SAFE_PATTERNS.some((p) => p.test(stage))
    );
  }
  return false;
}

export function isSafePlanModeCommand(command: string, guardrails?: GuardrailsConfig): boolean {
  if (!command.trim()) return false;
  if (hasUnsafePlanShellComposition(command)) return false;
  if (guardrails) {
    const guard = evaluateShellCommandGuard({
      command,
      cfg: guardrails,
      approvalPolicy: "on-request",
      unattendedRoutine: false
    });
    if (!guard.allowed) return false;
  }
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}

export interface TodoItem {
  step: number;
  text: string;
  completed: boolean;
}

export function cleanStepText(text: string): string {
  let cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (cleaned.length > 80) {
    cleaned = `${cleaned.slice(0, 77)}...`;
  }
  return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
  const items: TodoItem[] = [];
  const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
  const planSection = headerMatch
    ? message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length)
    : message;
  const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

  for (const match of planSection.matchAll(numberedPattern)) {
    const text = match[2]
      .trim()
      .replace(/\*{1,2}$/, "")
      .trim();
    if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
      const cleaned = cleanStepText(text);
      if (cleaned.length > 3) {
        items.push({ step: items.length + 1, text: cleaned, completed: false });
      }
    }
  }
  return items;
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
  const doneSteps = extractDoneSteps(text);
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item) item.completed = true;
  }
  return doneSteps.length;
}

// ============================================================================
// Structured Trust Artifacts (`plan`, `diff`, `verification`) + Inline `steer()`
// ============================================================================

export type TrustArtifactKind = "plan" | "diff" | "verification";
export type TrustArtifactStatus = "draft" | "approved" | "changes_requested" | "verified";

export interface TrustArtifactRecord {
  artifactId: string;
  kind: TrustArtifactKind;
  title: string;
  markdown: string;
  status: TrustArtifactStatus;
  todos: TodoItem[];
  sha256: string;
  diskRelPath: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface InlineArtifactComment {
  commentId: string;
  artifactId: string;
  lineStart: number;
  lineEnd: number;
  selectedExcerpt: string;
  comment: string;
  author: string;
  deliveredVia: "steer" | "nextTurn";
  createdAtMs: number;
}

export class TrustArtifactController {
  private readonly db: DatabaseSync;
  private readonly workspaceRoot: string;
  private readonly guardrails: GuardrailsConfig;
  private readonly durabilityMode: DurabilityMode;
  private sessionRef: AgentSession | null = null;
  private planModeActive = false;

  constructor(opts: {
    db: DatabaseSync;
    workspaceRoot: string;
    guardrails: GuardrailsConfig;
    durabilityMode?: DurabilityMode;
    initialPlanMode?: boolean;
  }) {
    this.db = opts.db;
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.guardrails = opts.guardrails;
    this.durabilityMode = opts.durabilityMode ?? "crash-safe";
    this.planModeActive = opts.initialPlanMode ?? false;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trust_artifacts (
        artifact_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('plan', 'diff', 'verification')),
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        status TEXT NOT NULL,
        todos_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disk_rel_path TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trust_artifact_comments (
        comment_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        selected_excerpt TEXT NOT NULL,
        comment TEXT NOT NULL,
        author TEXT NOT NULL,
        delivered_via TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
  }

  public bindSession(session: AgentSession): void {
    this.sessionRef = session;
  }

  public isPlanModeActive(): boolean {
    return this.planModeActive;
  }

  public setPlanMode(enabled: boolean): void {
    this.planModeActive = enabled;
  }

  public evaluatePlanModeToolCall(
    toolName: string,
    input: Record<string, unknown>
  ): { block: boolean; reason?: string } {
    if (!this.planModeActive) return { block: false };

    if (toolName === "write" || toolName === "edit") {
      return {
        block: true,
        reason: `PLAN_MODE_READ_ONLY: '${toolName}' is disabled while Plan Mode is active. Propose a plan via trust_artifact first or exit Plan Mode.`
      };
    }

    if (toolName === "bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      if (!isSafePlanModeCommand(cmd, this.guardrails)) {
        return {
          block: true,
          reason: `PLAN_MODE_READ_ONLY: bash command is not on the read-only Plan Mode allowlist: ${cmd}`
        };
      }
    }

    return { block: false };
  }

  public createOrUpdateArtifact(params: {
    artifactId?: string;
    kind: TrustArtifactKind;
    title: string;
    markdown: string;
    status?: TrustArtifactStatus;
  }): TrustArtifactRecord {
    const now = Date.now();
    const artifactId = params.artifactId ?? `art_${params.kind}_${crypto.randomUUID().slice(0, 8)}`;
    const existing = this.getArtifact(artifactId);
    const todos =
      params.kind === "plan"
        ? extractTodoItems(params.markdown)
        : existing?.todos ?? [];
    const status: TrustArtifactStatus =
      params.status ?? (params.kind === "verification" ? "verified" : existing?.status ?? "draft");
    const sha256 = crypto.createHash("sha256").update(params.markdown, "utf8").digest("hex");
    const safeFileSlug = artifactId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const diskRelPath = `.harness/artifacts/${safeFileSlug}.md`;
    const diskAbsPath = path.join(this.workspaceRoot, diskRelPath);

    writeFileDurable(diskAbsPath, params.markdown, this.durabilityMode, {
      workspaceRoot: this.workspaceRoot,
      mode: 0o600
    });

    const createdAtMs = existing?.createdAtMs ?? now;
    this.db
      .prepare(
        `INSERT INTO trust_artifacts (
          artifact_id, kind, title, markdown, status, todos_json, sha256, disk_rel_path, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          title = excluded.title,
          markdown = excluded.markdown,
          status = excluded.status,
          todos_json = excluded.todos_json,
          sha256 = excluded.sha256,
          updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        artifactId,
        params.kind,
        params.title,
        params.markdown,
        status,
        JSON.stringify(todos),
        sha256,
        diskRelPath,
        createdAtMs,
        now
      );

    return {
      artifactId,
      kind: params.kind,
      title: params.title,
      markdown: params.markdown,
      status,
      todos,
      sha256,
      diskRelPath,
      createdAtMs,
      updatedAtMs: now
    };
  }

  public recordAssistantTurnMarkers(assistantText: string): { updatedArtifacts: string[]; stepsCompleted: number } {
    if (!assistantText.includes("[DONE:")) {
      return { updatedArtifacts: [], stepsCompleted: 0 };
    }
    const plans = this.listArtifacts("plan");
    const updatedArtifacts: string[] = [];
    let totalCompleted = 0;

    for (const plan of plans) {
      if (plan.todos.length === 0) continue;
      const before = plan.todos.filter((t) => t.completed).length;
      markCompletedSteps(assistantText, plan.todos);
      const after = plan.todos.filter((t) => t.completed).length;
      if (after > before) {
        totalCompleted += after - before;
        updatedArtifacts.push(plan.artifactId);
        this.db
          .prepare(`UPDATE trust_artifacts SET todos_json = ?, updated_at_ms = ? WHERE artifact_id = ?`)
          .run(JSON.stringify(plan.todos), Date.now(), plan.artifactId);
      }
    }
    return { updatedArtifacts, stepsCompleted: totalCompleted };
  }

  public approvePlanArtifact(artifactId: string, exitPlanMode = true): TrustArtifactRecord {
    const art = this.getArtifact(artifactId);
    if (!art) {
      throw new Error(`TRUST_ARTIFACT_NOT_FOUND: ${artifactId}`);
    }
    if (exitPlanMode && art.kind === "plan") {
      this.planModeActive = false;
    }
    this.db
      .prepare(`UPDATE trust_artifacts SET status = 'approved', updated_at_ms = ? WHERE artifact_id = ?`)
      .run(Date.now(), artifactId);
    return this.getArtifact(artifactId)!;
  }

  /**
   * Antigravity-style inline line-anchored comment steering:
   * Extracts exact lines `lineStart..lineEnd` from the Trust Artifact, persists the review comment,
   * marks the artifact `changes_requested`, and delivers `<artifact-inline-steer>` via Pi's native
   * `session.steer()` (when actively streaming) or `sendCustomMessage({ deliverAs: "nextTurn" })`
   * when idle — strictly zero static-prefix mutations (`Invariant I-01` & `I-02`).
   */
  public async addInlineCommentAndSteer(params: {
    artifactId: string;
    lineStart: number;
    lineEnd?: number;
    comment: string;
    author?: string;
  }): Promise<InlineArtifactComment> {
    const artifact = this.getArtifact(params.artifactId);
    if (!artifact) {
      throw new Error(`TRUST_ARTIFACT_NOT_FOUND: ${params.artifactId}`);
    }

    const lines = artifact.markdown.split("\n");
    const start = Math.max(1, Math.min(params.lineStart, Math.max(1, lines.length)));
    const end = Math.max(start, Math.min(params.lineEnd ?? start, Math.max(1, lines.length)));
    const selectedExcerpt = lines.slice(start - 1, end).join("\n");
    const author = params.author ?? "user";
    const commentId = `cmt_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const steerPayload = [
      `<artifact-inline-steer artifact="${artifact.artifactId}" kind="${artifact.kind}" lines="L${start}-L${end}" author="${author}">`,
      `Quoted lines (L${start}-L${end} of ${artifact.title}):`,
      selectedExcerpt
        .split("\n")
        .map((l, idx) => `  ${start + idx} | ${l}`)
        .join("\n"),
      `Inline review comment: ${params.comment}`,
      `</artifact-inline-steer>`
    ].join("\n");

    let deliveredVia: "steer" | "nextTurn" = "nextTurn";
    if (this.sessionRef) {
      if (this.sessionRef.state.isStreaming) {
        await this.sessionRef.steer(steerPayload);
        deliveredVia = "steer";
      } else {
        await this.sessionRef.sendCustomMessage(
          {
            customType: "pi-apex-artifact-inline-steer",
            content: steerPayload,
            display: true,
            details: { artifactId: artifact.artifactId, commentId, lineStart: start, lineEnd: end }
          },
          { triggerTurn: false, deliverAs: "nextTurn" }
        );
        deliveredVia = "nextTurn";
      }
    }

    this.db
      .prepare(
        `INSERT INTO trust_artifact_comments (
          comment_id, artifact_id, line_start, line_end, selected_excerpt, comment, author, delivered_via, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(commentId, artifact.artifactId, start, end, selectedExcerpt, params.comment, author, deliveredVia, now);

    this.db
      .prepare(`UPDATE trust_artifacts SET status = 'changes_requested', updated_at_ms = ? WHERE artifact_id = ?`)
      .run(now, artifact.artifactId);

    return {
      commentId,
      artifactId: artifact.artifactId,
      lineStart: start,
      lineEnd: end,
      selectedExcerpt,
      comment: params.comment,
      author,
      deliveredVia,
      createdAtMs: now
    };
  }

  public getArtifact(artifactId: string): TrustArtifactRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM trust_artifacts WHERE artifact_id = ?`)
      .get(artifactId) as Record<string, unknown> | undefined;
    return row ? this.hydrateArtifact(row) : undefined;
  }

  public listArtifacts(kind?: TrustArtifactKind): TrustArtifactRecord[] {
    const rows = (
      kind
        ? this.db
            .prepare(`SELECT * FROM trust_artifacts WHERE kind = ? ORDER BY updated_at_ms DESC`)
            .all(kind)
        : this.db.prepare(`SELECT * FROM trust_artifacts ORDER BY updated_at_ms DESC`).all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => this.hydrateArtifact(r));
  }

  public listComments(artifactId: string): InlineArtifactComment[] {
    const rows = this.db
      .prepare(`SELECT * FROM trust_artifact_comments WHERE artifact_id = ? ORDER BY created_at_ms ASC`)
      .all(artifactId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      commentId: String(r.comment_id),
      artifactId: String(r.artifact_id),
      lineStart: Number(r.line_start),
      lineEnd: Number(r.line_end),
      selectedExcerpt: String(r.selected_excerpt),
      comment: String(r.comment),
      author: String(r.author),
      deliveredVia: String(r.delivered_via) as "steer" | "nextTurn",
      createdAtMs: Number(r.created_at_ms)
    }));
  }

  private hydrateArtifact(row: Record<string, unknown>): TrustArtifactRecord {
    return {
      artifactId: String(row.artifact_id),
      kind: String(row.kind) as TrustArtifactKind,
      title: String(row.title),
      markdown: String(row.markdown),
      status: String(row.status) as TrustArtifactStatus,
      todos: JSON.parse(String(row.todos_json || "[]")) as TodoItem[],
      sha256: String(row.sha256),
      diskRelPath: String(row.disk_rel_path),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }
}
