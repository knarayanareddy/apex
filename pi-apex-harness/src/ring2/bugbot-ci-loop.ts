/**
 * Ring 2 — Cursor BugBot `REVIEW_RULES.md` PR Reviewer + OpenAI Codex `ReviewOutputEvent`
 *          + Automated CI/Test Verification Loop
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `openai/codex` @ `970111f6cb62` (Apache-2.0 License, OpenAI):
 *    - `codex-rs/app-server-protocol/src/protocol/v2/review.rs`: `ReviewTarget`
 *      (`uncommittedChanges`, `baseBranch`, `commit`, `custom`).
 *    - `codex-rs/core/src/tasks/review.rs`: `parseReviewOutputEvent` (strict JSON parse
 *      with embedded `{...}` extraction fallback to `overall_explanation`).
 *    - `codex-rs/protocol/src/review_format.rs`: `REVIEW_FALLBACK_MESSAGE`,
 *      `formatReviewFindingsBlock`, `renderReviewOutputText`.
 *    - Upstream Bug Fix Applied (Codex Issues #8404 & #17160): `baseBranch` computes
 *      `mergeBaseSha = git merge-base <branch> HEAD` and runs `git diff <mergeBaseSha>...HEAD`
 *      (three-dot branch diff) instead of `git diff <mergeBaseSha>` so untracked/working-tree
 *      files never pollute PR branch reviews.
 * 2. Cursor 3.5 BugBot `REVIEW_RULES.md` learned rule schema + false-positive suppression
 *    & Devin-style bounded CI verification loop (`runCiVerificationLoop`).
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { DurabilityMode, GuardrailsConfig, SandboxMode } from "../types.ts";
import { createBwrapBashOperations } from "../core/bwrap-sandbox.ts";
import { evaluateShellCommandGuard } from "../core/monotonic-guard.ts";
import { readWorkspaceFileSafe } from "../core/safe-path.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import type { TrustArtifactController, TrustArtifactRecord } from "./plan-trust-artifacts.ts";

// ============================================================================
// Upstream `openai/codex` (`v2/review.rs`, `tasks/review.rs`, `review_format.rs`)
// ============================================================================

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export interface ReviewCodeLocation {
  absolute_file_path: string;
  line_range: {
    start: number;
    end: number;
  };
}

export interface ReviewFinding {
  title: string;
  body: string;
  confidence_score: number;
  priority: number;
  code_location: ReviewCodeLocation;
  rule_id?: string;
}

export interface ReviewOutputEvent {
  findings: ReviewFinding[];
  overall_correctness: "patch is correct" | "patch is incorrect" | "unknown";
  overall_explanation: string;
  overall_confidence_score: number;
}

export const REVIEW_FALLBACK_MESSAGE = "Reviewer failed to output a response.";

function formatLocation(item: ReviewFinding): string {
  const filePath = item.code_location.absolute_file_path;
  const start = item.code_location.line_range.start;
  const end = item.code_location.line_range.end;
  return `${filePath}:${start}-${end}`;
}

/**
 * Direct TypeScript port of `codex-rs/protocol/src/review_format.rs::format_review_findings_block`.
 */
export function formatReviewFindingsBlock(
  findings: readonly ReviewFinding[],
  selection?: readonly boolean[]
): string {
  const lines: string[] = [""];

  if (findings.length > 1) {
    lines.push("Full review comments:");
  } else {
    lines.push("Review comment:");
  }

  for (let idx = 0; idx < findings.length; idx++) {
    const item = findings[idx];
    lines.push("");
    const title = item.title;
    const location = formatLocation(item);

    if (selection !== undefined) {
      const checked = selection[idx] ?? true;
      const marker = checked ? "[x]" : "[ ]";
      lines.push(`- ${marker} ${title} — ${location}`);
    } else {
      lines.push(`- ${title} — ${location}`);
    }

    for (const bodyLine of item.body.split("\n")) {
      lines.push(`  ${bodyLine}`);
    }
  }

  return lines.join("\n");
}

/**
 * Direct TypeScript port of `codex-rs/protocol/src/review_format.rs::render_review_output_text`.
 */
export function renderReviewOutputText(output: ReviewOutputEvent): string {
  const sections: string[] = [];
  const explanation = output.overall_explanation.trim();
  if (explanation.length > 0) {
    sections.push(explanation);
  }
  if (output.findings.length > 0) {
    const findings = formatReviewFindingsBlock(output.findings, undefined).trim();
    if (findings.length > 0) {
      sections.push(findings);
    }
  }
  return sections.length === 0 ? REVIEW_FALLBACK_MESSAGE : sections.join("\n\n");
}

function isValidReviewOutputShape(candidate: unknown): candidate is Record<string, unknown> {
  if (!candidate || typeof candidate !== "object") return false;
  const obj = candidate as Record<string, unknown>;
  return Array.isArray(obj.findings) || typeof obj.overall_explanation === "string";
}

function normalizeParsedReviewOutput(raw: Record<string, unknown>): ReviewOutputEvent {
  const findings = Array.isArray(raw.findings) ? (raw.findings as ReviewFinding[]) : [];
  return {
    findings,
    overall_correctness:
      raw.overall_correctness === "patch is correct" ||
      raw.overall_correctness === "patch is incorrect"
        ? raw.overall_correctness
        : findings.length > 0
          ? "patch is incorrect"
          : "patch is correct",
    overall_explanation:
      typeof raw.overall_explanation === "string" ? raw.overall_explanation : "",
    overall_confidence_score:
      typeof raw.overall_confidence_score === "number" ? raw.overall_confidence_score : 0.8
  };
}

/**
 * Direct TypeScript port of `codex-rs/core/src/tasks/review.rs::parse_review_output_event`.
 */
export function parseReviewOutputEvent(text: string): ReviewOutputEvent {
  try {
    const parsed = JSON.parse(text);
    if (isValidReviewOutputShape(parsed)) {
      return normalizeParsedReviewOutput(parsed as Record<string, unknown>);
    }
  } catch {
    // Fall through to substring `{...}` extraction
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (isValidReviewOutputShape(parsed)) {
        return normalizeParsedReviewOutput(parsed as Record<string, unknown>);
      }
    } catch {
      // Fall through to plain-text fallback
    }
  }

  return {
    findings: [],
    overall_correctness: "unknown",
    overall_explanation: text,
    overall_confidence_score: 0
  };
}

// ============================================================================
// Cursor BugBot `REVIEW_RULES.md` + Diff Hunk Parser (with Codex #8404 Fix)
// ============================================================================

export interface LearnedReviewRule {
  id: string;
  title: string;
  glob: string;
  forbiddenPattern: string;
  body: string;
  priority: number;
}

interface DiffAddedLine {
  relPath: string;
  lineNumber: number;
  content: string;
}

function globToRegex(glob: string): RegExp {
  const norm = glob.trim().replace(/\\/g, "/");
  if (!norm || norm === "**" || norm === "*") return /^.*$/;
  let re = "^";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*" && norm[i + 1] === "*") {
      if (norm[i + 2] === "/") {
        re += "(?:.+/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("+.^$|()[]{}\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function parseUnifiedDiffAddedLines(diffText: string): DiffAddedLine[] {
  const added: DiffAddedLine[] = [];
  let currentFile: string | null = null;
  let newLineCursor = 0;
  let inHunk = false;

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length).trim();
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLineCursor = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentFile) continue;

    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({
        relPath: currentFile,
        lineNumber: newLineCursor,
        content: line.slice(1)
      });
      newLineCursor++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Removed line does not advance new-file line counter
    } else if (line.startsWith(" ")) {
      newLineCursor++;
    }
  }

  return added;
}

export function parseReviewRulesMarkdown(markdown: string): LearnedReviewRule[] {
  const rules: LearnedReviewRule[] = [];
  const blockRegex = /```(?:json|review-rule)\s*\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(blockRegex)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Partial<LearnedReviewRule>;
      if (parsed.id && parsed.title && parsed.forbiddenPattern) {
        rules.push({
          id: String(parsed.id),
          title: String(parsed.title),
          glob: typeof parsed.glob === "string" ? parsed.glob : "**/*",
          forbiddenPattern: String(parsed.forbiddenPattern),
          body: typeof parsed.body === "string" ? parsed.body : String(parsed.title),
          priority: typeof parsed.priority === "number" ? parsed.priority : 1
        });
      }
    } catch {
      continue;
    }
  }
  return rules;
}

export interface CiDiagnosticLocation {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface CiLoopAttempt {
  attempt: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  diagnostics: CiDiagnosticLocation[];
}

export interface CiLoopResult {
  passed: boolean;
  attempts: CiLoopAttempt[];
  verificationArtifact?: TrustArtifactRecord;
}

export function extractCiDiagnostics(output: string): CiDiagnosticLocation[] {
  const diags: CiDiagnosticLocation[] = [];
  const seen = new Set<string>();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    // Pattern 1: TypeScript `src/foo.ts(12,5): error TS2322: ...`
    const tsParen = line.match(/^([^\s(:]+)\((\d+),(\d+)\):\s*(.+)$/);
    if (tsParen) {
      const key = `${tsParen[1]}:${tsParen[2]}:${tsParen[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        diags.push({
          file: tsParen[1],
          line: Number(tsParen[2]),
          column: Number(tsParen[3]),
          message: tsParen[4]
        });
      }
      continue;
    }

    // Pattern 2: `src/foo.ts:12:5 - error ...` or `src/foo.py:12:5: ...`
    const colonLoc = line.match(/^([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+):(\d+):(\d+)[:\s-]+(.+)$/);
    if (colonLoc) {
      const key = `${colonLoc[1]}:${colonLoc[2]}:${colonLoc[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        diags.push({
          file: colonLoc[1],
          line: Number(colonLoc[2]),
          column: Number(colonLoc[3]),
          message: colonLoc[4]
        });
      }
    }
  }
  return diags;
}

export class BugBotAndCiEngine {
  private readonly workspaceRoot: string;
  private readonly db: DatabaseSync;
  private readonly guardrails: GuardrailsConfig;
  private readonly durabilityMode: DurabilityMode;
  private readonly bashOps: BashOperations;
  private readonly sandboxMode: SandboxMode;
  private readonly artifacts?: TrustArtifactController;

  constructor(opts: {
    workspaceRoot: string;
    db: DatabaseSync;
    guardrails: GuardrailsConfig;
    durabilityMode?: DurabilityMode;
    bashOps?: BashOperations;
    sandboxMode?: SandboxMode;
    allowUnsandboxedDev?: boolean;
    useBwrap?: boolean;
    artifacts?: TrustArtifactController;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.db = opts.db;
    this.guardrails = opts.guardrails;
    this.durabilityMode = opts.durabilityMode ?? "crash-safe";
    this.sandboxMode = opts.sandboxMode ?? "workspace-write";
    this.bashOps =
      opts.bashOps ??
      createBwrapBashOperations({
        workspaceRoot: this.workspaceRoot,
        mode: this.sandboxMode,
        unshareNet: opts.guardrails.sandbox.unshare_network_by_default,
        allowUnsandboxedDev: opts.allowUnsandboxedDev ?? false
      });
    this.artifacts = opts.artifacts;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bugbot_suppressions (
        fingerprint TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
  }

  public computeFindingFingerprint(ruleId: string, relPath: string, snippet: string): string {
    return crypto
      .createHash("sha256")
      .update(`${ruleId}\0${relPath}\0${snippet.trim()}`, "utf8")
      .digest("hex")
      .slice(0, 24);
  }

  public suppressFalsePositive(params: {
    ruleId: string;
    relPath: string;
    lineSnippet: string;
    reason: string;
  }): string {
    const fp = this.computeFindingFingerprint(params.ruleId, params.relPath, params.lineSnippet);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO bugbot_suppressions (fingerprint, rule_id, rel_path, reason, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(fp, params.ruleId, params.relPath, params.reason, Date.now());
    return fp;
  }

  public learnReviewRule(rule: LearnedReviewRule): { relPath: string; totalRules: number } {
    const relPath = "REVIEW_RULES.md";
    let existing = "";
    try {
      existing = readWorkspaceFileSafe({
        workspaceRoot: this.workspaceRoot,
        candidatePath: relPath
      }).toString("utf8");
    } catch {
      existing = "# BugBot Learned Review Rules\n";
    }

    const block = [
      "",
      `### ${rule.id}: ${rule.title}`,
      "```review-rule",
      JSON.stringify(rule, null, 2),
      "```",
      ""
    ].join("\n");

    const updated = `${existing.trimEnd()}\n${block}`;
    writeFileDurable(path.join(this.workspaceRoot, relPath), updated, this.durabilityMode, {
      workspaceRoot: this.workspaceRoot,
      mode: 0o644
    });
    return { relPath, totalRules: this.loadLearnedRules().length };
  }

  public loadLearnedRules(): LearnedReviewRule[] {
    const rules: LearnedReviewRule[] = [];
    for (const relPath of ["REVIEW_RULES.md", ".cursor/REVIEW_RULES.md"]) {
      const abs = path.join(this.workspaceRoot, relPath);
      if (!fs.existsSync(abs)) continue;
      try {
        const rawBuf = readWorkspaceFileSafe({
          workspaceRoot: this.workspaceRoot,
          candidatePath: relPath
        });
        rules.push(...parseReviewRulesMarkdown(rawBuf.toString("utf8")));
      } catch {
        continue;
      }
    }
    return rules;
  }

  /**
   * Computes git diff for any Codex `ReviewTarget`, explicitly applying the
   * Codex Issue #8404 / #17160 fix (`git diff <mergeBaseSha>...HEAD`) for `baseBranch`.
   */
  public collectTargetDiff(target: ReviewTarget): { diffText: string; mergeBaseSha?: string } {
    const runGit = (args: string[]) =>
      spawnSync("git", args, {
        cwd: this.workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });

    switch (target.type) {
      case "baseBranch": {
        const mb = runGit(["merge-base", target.branch, "HEAD"]);
        if ((mb.status ?? 1) !== 0) {
          throw new Error(
            `REVIEW_MERGE_BASE_FAILED (${target.branch}): ${(mb.stderr || mb.stdout).trim()}`
          );
        }
        const mergeBaseSha = mb.stdout.trim();
        // Codex Issue #8404 / #17160 fix: three-dot `mergeBaseSha...HEAD` compares ONLY committed
        // branch changes, never untracked or uncommitted working-tree files!
        const diff = runGit(["diff", "--unified=3", `${mergeBaseSha}...HEAD`]);
        if ((diff.status ?? 1) !== 0) {
          throw new Error(`REVIEW_DIFF_FAILED: ${(diff.stderr || diff.stdout).trim()}`);
        }
        return { diffText: diff.stdout, mergeBaseSha };
      }
      case "commit": {
        const show = runGit(["show", "--format=", "--unified=3", target.sha]);
        if ((show.status ?? 1) !== 0) {
          throw new Error(`REVIEW_COMMIT_DIFF_FAILED (${target.sha}): ${(show.stderr || show.stdout).trim()}`);
        }
        return { diffText: show.stdout };
      }
      case "uncommittedChanges":
      case "custom": {
        const hasHead = (runGit(["rev-parse", "--verify", "HEAD"]).status ?? 1) === 0;
        const diff = hasHead
          ? runGit(["diff", "--unified=3", "HEAD"])
          : runGit(["diff", "--unified=3"]);
        return { diffText: diff.stdout ?? "" };
      }
    }
  }

  public reviewTarget(target: ReviewTarget): {
    output: ReviewOutputEvent;
    renderedText: string;
    mergeBaseSha?: string;
    addedLinesInspected: number;
  } {
    const { diffText, mergeBaseSha } = this.collectTargetDiff(target);
    const addedLines = parseUnifiedDiffAddedLines(diffText);
    const rules = this.loadLearnedRules();
    const suppressedSet = new Set(
      (
        this.db.prepare(`SELECT fingerprint FROM bugbot_suppressions`).all() as Array<{
          fingerprint: string;
        }>
      ).map((r) => r.fingerprint)
    );

    const findings: ReviewFinding[] = [];
    for (const rule of rules) {
      const fileMatcher = globToRegex(rule.glob);
      let patternRe: RegExp;
      try {
        patternRe = new RegExp(rule.forbiddenPattern);
      } catch {
        continue;
      }

      for (const line of addedLines) {
        if (!fileMatcher.test(line.relPath)) continue;
        if (!patternRe.test(line.content)) continue;

        const fp = this.computeFindingFingerprint(rule.id, line.relPath, line.content);
        if (suppressedSet.has(fp)) continue;

        findings.push({
          title: `[${rule.id}] ${rule.title}`,
          body: `${rule.body}\nMatched line: \`${line.content.trim()}\``,
          confidence_score: 0.95,
          priority: rule.priority,
          rule_id: rule.id,
          code_location: {
            absolute_file_path: path.join(this.workspaceRoot, line.relPath),
            line_range: { start: line.lineNumber, end: line.lineNumber }
          }
        });
      }
    }

    const output: ReviewOutputEvent = {
      findings,
      overall_correctness: findings.length === 0 ? "patch is correct" : "patch is incorrect",
      overall_explanation:
        findings.length === 0
          ? `Reviewed ${addedLines.length} added diff line(s) against ${rules.length} learned REVIEW_RULES.md rule(s): 0 violations.`
          : `Found ${findings.length} violation(s) across ${addedLines.length} added diff line(s).`,
      overall_confidence_score: findings.length === 0 ? 0.9 : 0.95
    };

    return {
      output,
      renderedText: renderReviewOutputText(output),
      mergeBaseSha,
      addedLinesInspected: addedLines.length
    };
  }

  public async runCiVerificationLoop(params: {
    command: string;
    maxAttempts?: number;
    onFailureAutofix?: (attempt: CiLoopAttempt) => Promise<void> | void;
    recordTrustArtifact?: boolean;
  }): Promise<CiLoopResult> {
    const guard = evaluateShellCommandGuard({
      command: params.command,
      cfg: this.guardrails,
      approvalPolicy: "never",
      unattendedRoutine: false
    });
    if (!guard.allowed) {
      throw new Error(`CI_COMMAND_DENIED: ${guard.reason}`);
    }

    const maxAttempts = Math.max(1, Math.min(params.maxAttempts ?? 3, 5));
    const attempts: CiLoopAttempt[] = [];
    let passed = false;

    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      if (this.sandboxMode === "read-only") {
        throw new Error("CI_COMMAND_DENIED: [guard: CI execution denied in read-only sandbox mode]");
      }

      let exitCode = 1;
      let stdout = "";
      let stderr = "";

      const chunks: Buffer[] = [];
      const res = await this.bashOps.exec(params.command, this.workspaceRoot, {
        onData: (d) => chunks.push(d),
        timeout: 60
      });
      exitCode = res.exitCode ?? 1;
      stdout = Buffer.concat(chunks).toString("utf8");

      const combined = `${stdout}\n${stderr}`;
      const diagnostics = extractCiDiagnostics(combined);
      const attemptRecord: CiLoopAttempt = {
        attempt: attemptNo,
        exitCode,
        stdout,
        stderr,
        diagnostics
      };
      attempts.push(attemptRecord);

      if (exitCode === 0) {
        passed = true;
        break;
      }

      if (attemptNo < maxAttempts && params.onFailureAutofix) {
        await params.onFailureAutofix(attemptRecord);
      } else {
        break;
      }
    }

    let verificationArtifact: TrustArtifactRecord | undefined;
    if (this.artifacts && params.recordTrustArtifact !== false) {
      const last = attempts[attempts.length - 1];
      const md = [
        `# CI Verification Receipt: ${passed ? "PASSED" : "FAILED"}`,
        `- Command: \`${params.command}\``,
        `- Attempts: ${attempts.length}`,
        `- Final Exit Code: ${last.exitCode}`,
        last.diagnostics.length > 0
          ? `## Structured Diagnostics\n` +
            last.diagnostics.map((d) => `- \`${d.file}:${d.line}:${d.column}\` — ${d.message}`).join("\n")
          : `## Output Tail\n\`\`\`\n${`${last.stdout}\n${last.stderr}`.trim().slice(-1500)}\n\`\`\``
      ].join("\n\n");

      verificationArtifact = this.artifacts.createOrUpdateArtifact({
        kind: "verification",
        title: `CI Verification (${params.command})`,
        markdown: md,
        status: passed ? "verified" : "changes_requested"
      });
    }

    return { passed, attempts, verificationArtifact };
  }
}
