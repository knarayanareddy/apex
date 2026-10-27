/**
 * Ring 9 — Cryptographically Hash-Chained Unified Self-Learning Ledger
 * (`src/ring9/self-learning-ledger.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `google-research/harness2` @ `1cfe254e8d25` (`harness2/core/{library,proposer,selection}.py`,
 *    Apache-2.0): Structured `cue` / `lesson` / `evidence` / `confidence` experience records,
 *    SHA-based content IDs, and immutable `GUARDRAILS.yaml` separation.
 * 2. `NousResearch/hermes-agent` @ `765c6463009f` (`agent/{memory_manager,curator}.py` &
 *    `tools/skills_guard.py`, MIT): Closed learning loop with `scrubSecretsInfallible()`
 *    (preventing Hermes #115104 secret memorization) and `skills-guard-v10` anti-poisoning gate.
 * 3. Cursor BugBot `.agents/REVIEW_RULES.md` learned diff patterns (`src/ring2/bugbot-ci-loop.ts`).
 *
 * PRESERVED INVARIANTS:
 * - Append-only SHA-256 hash chain (`GENESIS_HASH = "0".repeat(64)`) stored in BOTH SQLite
 *   `learning_ledger` AND `.harness/ledger/SELF_LEARNING_LEDGER.jsonl`.
 * - Zero mid-session mutation of `session.systemPrompt` (`0` static-prefix SHA-256 drift);
 *   `materializeSurfaces()` compiles top-confidence entries to `surfaces/EXPERIENCE.md`
 *   (`<= 220` `o200k_base` tokens) and `.agents/REVIEW_RULES.md` for `/new` or next boot.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { countO200kTokens } from "../core/prefix-budget.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import { scanSkillBundle, type SkillVerdict } from "../ring3/skills-guard-quarantine.ts";
import type { DurabilityMode } from "../types.ts";

export const LEDGER_GENESIS_HASH = "0".repeat(64);
export const MAX_EXPERIENCE_SURFACE_TOKENS = 220;

export type LearningEntryKind =
  | "experience_cue"
  | "review_rule"
  | "memory_fact"
  | "skill_draft"
  | "routing_hint"
  | "tombstone";

export type LearningSourceEvent =
  | "pr_self_heal"
  | "bugbot_violation"
  | "operator_steer"
  | "swarm_consensus"
  | "turn_reflection"
  | "manual_operator"
  | "rollback_tombstone";

export type LearningEntryStatus = "active" | "quarantined" | "demoted" | "rolled_back";

export interface SelfLearningEntry {
  seq: number;
  entryId: string;
  prevHash: string;
  entryHash: string;
  timestampMs: number;
  sourceEvent: LearningSourceEvent;
  kind: LearningEntryKind;
  domain: string;
  cue: string;
  lesson: string;
  evidence: string;
  forbiddenPattern?: string;
  glob?: string;
  scanVerdict: SkillVerdict;
  status: LearningEntryStatus;
  confidence: number;
  appliedCount: number;
  helpedCount: number;
  regressedCount: number;
  targetEntryId?: string;
}

export interface LedgerIntegrityReport {
  valid: boolean;
  totalEntries: number;
  activeEntries: number;
  quarantinedEntries: number;
  rolledBackEntries: number;
  demotedEntries: number;
  headHash: string;
  jsonlMatchesDb: boolean;
  brokenAtSeq?: number;
  reason?: string;
}

export interface MaterializeSurfacesResult {
  experiencePath: string;
  experienceTokens: number;
  experienceCount: number;
  reviewRulesPath: string;
  reviewRulesCount: number;
  appliesOnNextBoot: true;
}

function computeCanonicalEntryHash(payload: {
  seq: number;
  entryId: string;
  prevHash: string;
  timestampMs: number;
  sourceEvent: LearningSourceEvent;
  kind: LearningEntryKind;
  domain: string;
  cue: string;
  lesson: string;
  evidence: string;
  forbiddenPattern: string;
  glob: string;
  scanVerdict: SkillVerdict;
  initialStatus: LearningEntryStatus;
  targetEntryId: string;
}): string {
  const canonical = JSON.stringify([
    payload.seq,
    payload.entryId,
    payload.prevHash,
    payload.timestampMs,
    payload.sourceEvent,
    payload.kind,
    payload.domain,
    payload.cue,
    payload.lesson,
    payload.evidence,
    payload.forbiddenPattern,
    payload.glob,
    payload.scanVerdict,
    payload.initialStatus,
    payload.targetEntryId
  ]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function computeBayesianConfidence(helped: number, applied: number): number {
  return Number(((helped + 2) / (applied + 3)).toFixed(4));
}

export class SelfLearningLedger {
  private readonly workspaceRoot: string;
  private readonly db: DatabaseSync;
  private readonly durabilityMode: DurabilityMode;
  private readonly ledgerJsonlPath: string;

  constructor(opts: {
    workspaceRoot: string;
    db: DatabaseSync;
    durabilityMode?: DurabilityMode;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.db = opts.db;
    this.durabilityMode = opts.durabilityMode ?? "crash-safe";
    this.ledgerJsonlPath = path.join(
      this.workspaceRoot,
      ".harness",
      "ledger",
      "SELF_LEARNING_LEDGER.jsonl"
    );
    this.initSchema();
  }

  public getJsonlPath(): string {
    return this.ledgerJsonlPath;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_ledger (
        seq                INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id           TEXT NOT NULL UNIQUE,
        prev_hash          TEXT NOT NULL,
        entry_hash         TEXT NOT NULL,
        timestamp_ms       INTEGER NOT NULL,
        source_event       TEXT NOT NULL,
        kind               TEXT NOT NULL,
        domain             TEXT NOT NULL,
        cue                TEXT NOT NULL,
        lesson             TEXT NOT NULL,
        evidence           TEXT NOT NULL,
        forbidden_pattern  TEXT NOT NULL DEFAULT '',
        glob               TEXT NOT NULL DEFAULT '',
        scan_verdict       TEXT NOT NULL,
        initial_status     TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('active','quarantined','demoted','rolled_back')),
        confidence         REAL NOT NULL,
        applied_count      INTEGER NOT NULL DEFAULT 0,
        helped_count       INTEGER NOT NULL DEFAULT 0,
        regressed_count    INTEGER NOT NULL DEFAULT 0,
        target_entry_id    TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_learning_ledger_status ON learning_ledger(status, kind);
    `);

    const ledgerDir = path.dirname(this.ledgerJsonlPath);
    fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.ledgerJsonlPath)) {
      fs.writeFileSync(this.ledgerJsonlPath, "", { mode: 0o600 });
    }
  }

  private getHeadSeqAndHash(): { nextSeq: number; prevHash: string } {
    const row = this.db
      .prepare(`SELECT seq, entry_hash FROM learning_ledger ORDER BY seq DESC LIMIT 1`)
      .get() as { seq: number; entry_hash: string } | undefined;
    if (!row) {
      return { nextSeq: 1, prevHash: LEDGER_GENESIS_HASH };
    }
    return { nextSeq: row.seq + 1, prevHash: row.entry_hash };
  }

  /**
   * Appends a secret-scrubbed, `skills-guard-v10`-scanned entry to the hash-chained ledger.
   * Poisoned lessons are stored with `status = 'quarantined'` so attempted prompt/memory
   * poisoning is permanently audited in the hash chain without ever entering active surfaces.
   */
  public recordLesson(input: {
    sourceEvent: LearningSourceEvent;
    kind: Exclude<LearningEntryKind, "tombstone">;
    domain?: string;
    cue: string;
    lesson: string;
    evidence?: string;
    forbiddenPattern?: string;
    glob?: string;
  }): SelfLearningEntry {
    const scrubbedDomain = scrubSecretsInfallible((input.domain ?? "general").trim() || "general");
    const scrubbedCue = scrubSecretsInfallible(input.cue.trim());
    const scrubbedLesson = scrubSecretsInfallible(input.lesson.trim());
    const scrubbedEvidence = scrubSecretsInfallible((input.evidence ?? "runtime").trim());
    const scrubbedForbidden = (input.forbiddenPattern ?? "").trim();
    const scrubbedGlob = (input.glob ?? "**/*").trim();

    if (!scrubbedCue || !scrubbedLesson) {
      throw new Error("LEDGER_EMPTY_LESSON: both 'cue' and 'lesson' must be non-empty.");
    }

    const scan = scanSkillBundle({
      skillName: `ledger-${input.kind}`,
      files: {
        "CUE.md": scrubbedCue,
        "LESSON.md": scrubbedLesson
      },
      source: `ledger:${input.sourceEvent}`,
      trustLevel: "agent-created"
    });

    const initialStatus: LearningEntryStatus =
      scan.verdict === "dangerous" ? "quarantined" : "active";

    const { nextSeq, prevHash } = this.getHeadSeqAndHash();
    const timestampMs = Date.now();
    const entryId = `led_${nextSeq}_${crypto.randomBytes(4).toString("hex")}`;

    const entryHash = computeCanonicalEntryHash({
      seq: nextSeq,
      entryId,
      prevHash,
      timestampMs,
      sourceEvent: input.sourceEvent,
      kind: input.kind,
      domain: scrubbedDomain,
      cue: scrubbedCue,
      lesson: scrubbedLesson,
      evidence: scrubbedEvidence,
      forbiddenPattern: scrubbedForbidden,
      glob: scrubbedGlob,
      scanVerdict: scan.verdict,
      initialStatus,
      targetEntryId: ""
    });

    const initialConfidence = initialStatus === "quarantined" ? 0 : computeBayesianConfidence(0, 0);

    this.db
      .prepare(
        `INSERT INTO learning_ledger (
           seq, entry_id, prev_hash, entry_hash, timestamp_ms, source_event, kind, domain,
           cue, lesson, evidence, forbidden_pattern, glob, scan_verdict, initial_status, status,
           confidence, applied_count, helped_count, regressed_count, target_entry_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '')`
      )
      .run(
        nextSeq,
        entryId,
        prevHash,
        entryHash,
        timestampMs,
        input.sourceEvent,
        input.kind,
        scrubbedDomain,
        scrubbedCue,
        scrubbedLesson,
        scrubbedEvidence,
        scrubbedForbidden,
        scrubbedGlob,
        scan.verdict,
        initialStatus,
        initialStatus,
        initialConfidence
      );

    this.appendJsonlMirror({
      seq: nextSeq,
      entryId,
      prevHash,
      entryHash,
      timestampMs,
      sourceEvent: input.sourceEvent,
      kind: input.kind,
      domain: scrubbedDomain,
      cue: scrubbedCue,
      lesson: scrubbedLesson,
      evidence: scrubbedEvidence,
      forbiddenPattern: scrubbedForbidden,
      glob: scrubbedGlob,
      scanVerdict: scan.verdict,
      initialStatus,
      targetEntryId: ""
    });

    return this.getEntryById(entryId)!;
  }

  /**
   * Closed-loop hook invoked automatically by `AutonomousPrPipeline` whenever a BugBot P0/P1
   * violation or sandboxed `bwrap` CI failure is autonomously repaired on `apex/<slug>`.
   */
  public recordSelfHealRecovery(opts: {
    prId: string;
    scope: string;
    triggerKind: "bugbot_review" | "bwrap_ci";
    failureSummary: string;
    repairedFiles: string[];
  }): SelfLearningEntry {
    const filesLabel = opts.repairedFiles.length > 0 ? opts.repairedFiles.join(", ") : opts.scope;
    const compactFailure = opts.failureSummary.replace(/\s+/g, " ").slice(0, 180);
    return this.recordLesson({
      sourceEvent: "pr_self_heal",
      kind: "experience_cue",
      domain: opts.scope || "pr",
      cue: `Modifying ${filesLabel} (${opts.triggerKind === "bugbot_review" ? "BugBot P0/P1 guard" : "sandboxed CI check"})`,
      lesson: `Avoid triggering '${compactFailure}' — apply the verified self-heal pattern up front on first-shot synthesis.`,
      evidence: `${opts.prId}:${opts.triggerKind}`
    });
  }

  /**
   * Closed-loop hook for operator inline plan steering or explicit corrections.
   */
  public recordOperatorSteer(opts: {
    domain?: string;
    cue: string;
    correction: string;
    artifactId?: string;
  }): SelfLearningEntry {
    return this.recordLesson({
      sourceEvent: "operator_steer",
      kind: "experience_cue",
      domain: opts.domain ?? "operator",
      cue: opts.cue,
      lesson: opts.correction,
      evidence: opts.artifactId ?? "operator-steer"
    });
  }

  /**
   * Closed-loop hook for Multi-Agent Debate consensus synthesis.
   */
  public recordSwarmConsensus(opts: {
    runId: string;
    topic: string;
    winningSummary: string;
  }): SelfLearningEntry {
    return this.recordLesson({
      sourceEvent: "swarm_consensus",
      kind: "experience_cue",
      domain: "architecture",
      cue: opts.topic.slice(0, 140),
      lesson: opts.winningSummary.slice(0, 240),
      evidence: `swarm:${opts.runId}`
    });
  }

  /**
   * Records empirical outcome feedback (`helped = true | false`), updating Bayesian confidence
   * `(helped + 2) / (applied + 3)` and auto-demoting regressed rules (`regressed >= 2 && regressed > helped`).
   */
  public recordOutcome(entryId: string, helped: boolean): SelfLearningEntry {
    const current = this.getEntryById(entryId);
    if (!current) {
      throw new Error(`LEDGER_ENTRY_NOT_FOUND: '${entryId}'`);
    }
    if (current.status === "quarantined" || current.status === "rolled_back") {
      throw new Error(
        `LEDGER_ENTRY_IMMUTABLE_STATUS: cannot record outcome on '${entryId}' (${current.status}).`
      );
    }

    const applied = current.appliedCount + 1;
    const helpedCount = current.helpedCount + (helped ? 1 : 0);
    const regressedCount = current.regressedCount + (helped ? 0 : 1);
    const confidence = computeBayesianConfidence(helpedCount, applied);
    const nextStatus: LearningEntryStatus =
      regressedCount >= 2 && regressedCount > helpedCount ? "demoted" : "active";

    this.db
      .prepare(
        `UPDATE learning_ledger
         SET applied_count = ?, helped_count = ?, regressed_count = ?, confidence = ?, status = ?
         WHERE entry_id = ?`
      )
      .run(applied, helpedCount, regressedCount, confidence, nextStatus, entryId);

    return this.getEntryById(entryId)!;
  }

  /**
   * Append-only rollback: marks target `rolled_back` in active projections AND appends a
   * hash-chained `tombstone` record so the ledger's cryptographic chain is never rewritten.
   */
  public rollbackEntry(entryId: string, reason = "operator rollback"): {
    rolledBack: SelfLearningEntry;
    tombstone: SelfLearningEntry;
  } {
    const target = this.getEntryById(entryId);
    if (!target) {
      throw new Error(`LEDGER_ENTRY_NOT_FOUND: '${entryId}'`);
    }
    if (target.kind === "tombstone") {
      throw new Error(`LEDGER_CANNOT_ROLLBACK_TOMBSTONE: '${entryId}'`);
    }

    const { nextSeq, prevHash } = this.getHeadSeqAndHash();
    const timestampMs = Date.now();
    const tombstoneId = `led_${nextSeq}_${crypto.randomBytes(4).toString("hex")}`;
    const scrubbedReason = scrubSecretsInfallible(reason.trim() || "operator rollback");

    const entryHash = computeCanonicalEntryHash({
      seq: nextSeq,
      entryId: tombstoneId,
      prevHash,
      timestampMs,
      sourceEvent: "rollback_tombstone",
      kind: "tombstone",
      domain: target.domain,
      cue: `ROLLBACK ${entryId}`,
      lesson: scrubbedReason,
      evidence: entryId,
      forbiddenPattern: "",
      glob: "",
      scanVerdict: "safe",
      initialStatus: "active",
      targetEntryId: entryId
    });

    this.db
      .prepare(`UPDATE learning_ledger SET status = 'rolled_back' WHERE entry_id = ?`)
      .run(entryId);

    this.db
      .prepare(
        `INSERT INTO learning_ledger (
           seq, entry_id, prev_hash, entry_hash, timestamp_ms, source_event, kind, domain,
           cue, lesson, evidence, forbidden_pattern, glob, scan_verdict, initial_status, status,
           confidence, applied_count, helped_count, regressed_count, target_entry_id
         ) VALUES (?, ?, ?, ?, ?, 'rollback_tombstone', 'tombstone', ?, ?, ?, ?, '', '', 'safe', 'active', 'active', 1.0, 0, 0, 0, ?)`
      )
      .run(
        nextSeq,
        tombstoneId,
        prevHash,
        entryHash,
        timestampMs,
        target.domain,
        `ROLLBACK ${entryId}`,
        scrubbedReason,
        entryId,
        entryId
      );

    this.appendJsonlMirror({
      seq: nextSeq,
      entryId: tombstoneId,
      prevHash,
      entryHash,
      timestampMs,
      sourceEvent: "rollback_tombstone",
      kind: "tombstone",
      domain: target.domain,
      cue: `ROLLBACK ${entryId}`,
      lesson: scrubbedReason,
      evidence: entryId,
      forbiddenPattern: "",
      glob: "",
      scanVerdict: "safe",
      initialStatus: "active",
      targetEntryId: entryId
    });

    return {
      rolledBack: this.getEntryById(entryId)!,
      tombstone: this.getEntryById(tombstoneId)!
    };
  }

  private appendJsonlMirror(record: {
    seq: number;
    entryId: string;
    prevHash: string;
    entryHash: string;
    timestampMs: number;
    sourceEvent: LearningSourceEvent;
    kind: LearningEntryKind;
    domain: string;
    cue: string;
    lesson: string;
    evidence: string;
    forbiddenPattern: string;
    glob: string;
    scanVerdict: SkillVerdict;
    initialStatus: LearningEntryStatus;
    targetEntryId: string;
  }): void {
    fs.appendFileSync(this.ledgerJsonlPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }

  /**
   * Cryptographically verifies EVERY link in the SHA-256 hash chain from `LEDGER_GENESIS_HASH`
   * across both SQLite `learning_ledger` and `.harness/ledger/SELF_LEARNING_LEDGER.jsonl`.
   */
  public verifyIntegrity(): LedgerIntegrityReport {
    const rows = this.db
      .prepare(
        `SELECT seq, entry_id, prev_hash, entry_hash, timestamp_ms, source_event, kind, domain,
                cue, lesson, evidence, forbidden_pattern, glob, scan_verdict, initial_status,
                status, target_entry_id
         FROM learning_ledger
         ORDER BY seq ASC`
      )
      .all() as Array<Record<string, unknown>>;

    let expectedPrev = LEDGER_GENESIS_HASH;
    let activeEntries = 0;
    let quarantinedEntries = 0;
    let rolledBackEntries = 0;
    let demotedEntries = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const seq = Number(r["seq"]);
      if (seq !== i + 1) {
        return {
          valid: false,
          totalEntries: rows.length,
          activeEntries,
          quarantinedEntries,
          rolledBackEntries,
          demotedEntries,
          headHash: expectedPrev,
          jsonlMatchesDb: false,
          brokenAtSeq: seq,
          reason: `Non-contiguous sequence number at index ${i} (got seq=${seq}).`
        };
      }
      if (String(r["prev_hash"]) !== expectedPrev) {
        return {
          valid: false,
          totalEntries: rows.length,
          activeEntries,
          quarantinedEntries,
          rolledBackEntries,
          demotedEntries,
          headHash: expectedPrev,
          jsonlMatchesDb: false,
          brokenAtSeq: seq,
          reason: `Broken prev_hash link at seq=${seq}.`
        };
      }

      const recomputed = computeCanonicalEntryHash({
        seq,
        entryId: String(r["entry_id"]),
        prevHash: String(r["prev_hash"]),
        timestampMs: Number(r["timestamp_ms"]),
        sourceEvent: String(r["source_event"]) as LearningSourceEvent,
        kind: String(r["kind"]) as LearningEntryKind,
        domain: String(r["domain"]),
        cue: String(r["cue"]),
        lesson: String(r["lesson"]),
        evidence: String(r["evidence"]),
        forbiddenPattern: String(r["forbidden_pattern"] ?? ""),
        glob: String(r["glob"] ?? ""),
        scanVerdict: String(r["scan_verdict"]) as SkillVerdict,
        initialStatus: String(r["initial_status"]) as LearningEntryStatus,
        targetEntryId: String(r["target_entry_id"] ?? "")
      });

      if (recomputed !== String(r["entry_hash"])) {
        return {
          valid: false,
          totalEntries: rows.length,
          activeEntries,
          quarantinedEntries,
          rolledBackEntries,
          demotedEntries,
          headHash: expectedPrev,
          jsonlMatchesDb: false,
          brokenAtSeq: seq,
          reason: `SHA-256 entry_hash mismatch at seq=${seq} (SQLite row tampered).`
        };
      }

      expectedPrev = recomputed;
      const st = String(r["status"]) as LearningEntryStatus;
      const kind = String(r["kind"]) as LearningEntryKind;
      if (kind !== "tombstone") {
        if (st === "active") activeEntries += 1;
        else if (st === "quarantined") quarantinedEntries += 1;
        else if (st === "rolled_back") rolledBackEntries += 1;
        else if (st === "demoted") demotedEntries += 1;
      }
    }

    // Verify JSONL mirror hash chain matches SQLite tip-for-tip
    let jsonlMatchesDb = true;
    if (!fs.existsSync(this.ledgerJsonlPath)) {
      jsonlMatchesDb = rows.length === 0;
    } else {
      const lines = fs
        .readFileSync(this.ledgerJsonlPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean);
      if (lines.length !== rows.length) {
        return {
          valid: false,
          totalEntries: rows.length,
          activeEntries,
          quarantinedEntries,
          rolledBackEntries,
          demotedEntries,
          headHash: expectedPrev,
          jsonlMatchesDb: false,
          brokenAtSeq: Math.min(lines.length, rows.length) + 1,
          reason: `JSONL line count (${lines.length}) diverges from SQLite row count (${rows.length}).`
        };
      }
      for (let i = 0; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]!) as Record<string, unknown>;
          const recomputedJsonl = computeCanonicalEntryHash({
            seq: Number(parsed["seq"]),
            entryId: String(parsed["entryId"]),
            prevHash: String(parsed["prevHash"]),
            timestampMs: Number(parsed["timestampMs"]),
            sourceEvent: String(parsed["sourceEvent"]) as LearningSourceEvent,
            kind: String(parsed["kind"]) as LearningEntryKind,
            domain: String(parsed["domain"]),
            cue: String(parsed["cue"]),
            lesson: String(parsed["lesson"]),
            evidence: String(parsed["evidence"]),
            forbiddenPattern: String(parsed["forbiddenPattern"] ?? ""),
            glob: String(parsed["glob"] ?? ""),
            scanVerdict: String(parsed["scanVerdict"]) as SkillVerdict,
            initialStatus: String(parsed["initialStatus"]) as LearningEntryStatus,
            targetEntryId: String(parsed["targetEntryId"] ?? "")
          });
          if (recomputedJsonl !== String(rows[i]!["entry_hash"])) {
            return {
              valid: false,
              totalEntries: rows.length,
              activeEntries,
              quarantinedEntries,
              rolledBackEntries,
              demotedEntries,
              headHash: expectedPrev,
              jsonlMatchesDb: false,
              brokenAtSeq: i + 1,
              reason: `JSONL entry at line ${i + 1} tampered (hash mismatch vs SQLite chain).`
            };
          }
        } catch {
          return {
            valid: false,
            totalEntries: rows.length,
            activeEntries,
            quarantinedEntries,
            rolledBackEntries,
            demotedEntries,
            headHash: expectedPrev,
            jsonlMatchesDb: false,
            brokenAtSeq: i + 1,
            reason: `Malformed JSONL entry at line ${i + 1}.`
          };
        }
      }
    }

    return {
      valid: true,
      totalEntries: rows.length,
      activeEntries,
      quarantinedEntries,
      rolledBackEntries,
      demotedEntries,
      headHash: expectedPrev,
      jsonlMatchesDb
    };
  }

  /**
   * Compiles highest-confidence `active` ledger entries into `surfaces/EXPERIENCE.md`
   * (`<= 220` `o200k_base` tokens) and `.agents/REVIEW_RULES.md` on disk for `/new` or next boot,
   * NEVER mutating `session.systemPrompt` mid-session (`0` live prefix drift).
   */
  public materializeSurfaces(opts: { surfacesDir: string }): MaterializeSurfacesResult {
    const activeRows = this.listEntries({ status: "active", includeTombstones: false });

    const expCandidates = activeRows
      .filter((e) => e.kind === "experience_cue" || e.kind === "memory_fact")
      .sort((a, b) => b.confidence - a.confidence || b.seq - a.seq);

    const header = "# Harness² Self-Learning Ledger Materialized Experience";
    const chosenLines: string[] = [header];
    let experienceCount = 0;

    for (const item of expCandidates) {
      const bullet = `- [${item.entryId}] cue: ${item.cue} -> lesson: ${item.lesson}`;
      const candidateDoc = `${chosenLines.join("\n")}\n${bullet}\n`;
      if (countO200kTokens(candidateDoc) > MAX_EXPERIENCE_SURFACE_TOKENS) {
        break;
      }
      chosenLines.push(bullet);
      experienceCount += 1;
    }

    const finalExpDoc = `${chosenLines.join("\n")}\n`;
    const experiencePath = path.join(path.resolve(opts.surfacesDir), "EXPERIENCE.md");
    fs.mkdirSync(path.dirname(experiencePath), { recursive: true });
    fs.writeFileSync(experiencePath, finalExpDoc, "utf8");

    const reviewCandidates = activeRows
      .filter((e) => e.kind === "review_rule" && Boolean(e.forbiddenPattern))
      .sort((a, b) => b.confidence - a.confidence || b.seq - a.seq);

    const reviewRulesRel = path.join(".agents", "REVIEW_RULES.md");
    const reviewRulesAbs = path.join(this.workspaceRoot, reviewRulesRel);
    if (reviewCandidates.length > 0) {
      const ruleBlocks = reviewCandidates.map((r, idx) =>
        [
          `## Rule: ${r.entryId}`,
          `- title: ${r.cue}`,
          `- glob: ${r.glob || "**/*"}`,
          `- forbiddenPattern: ${r.forbiddenPattern}`,
          `- priority: ${idx + 1}`,
          "",
          r.lesson
        ].join("\n")
      );
      const fullRulesDoc = `# BugBot Learned Review Rules (Ledger Synced)\n\n${ruleBlocks.join("\n\n")}\n`;
      writeFileDurable(reviewRulesAbs, Buffer.from(fullRulesDoc, "utf8"), this.durabilityMode, {
        workspaceRoot: this.workspaceRoot,
        mode: 0o644
      });
    }

    return {
      experiencePath,
      experienceTokens: countO200kTokens(finalExpDoc),
      experienceCount,
      reviewRulesPath: reviewRulesAbs,
      reviewRulesCount: reviewCandidates.length,
      appliesOnNextBoot: true
    };
  }

  public getEntryById(entryId: string): SelfLearningEntry | undefined {
    const row = this.db
      .prepare(`SELECT * FROM learning_ledger WHERE entry_id = ?`)
      .get(entryId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  public listEntries(filter?: {
    status?: LearningEntryStatus;
    kind?: LearningEntryKind;
    domain?: string;
    includeTombstones?: boolean;
    limit?: number;
  }): SelfLearningEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter?.domain) {
      clauses.push("domain = ?");
      params.push(filter.domain);
    }
    if (filter?.includeTombstones !== true && !filter?.kind) {
      clauses.push("kind != 'tombstone'");
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter?.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM learning_ledger ${whereSql} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(r: Record<string, unknown>): SelfLearningEntry {
    return {
      seq: Number(r["seq"]),
      entryId: String(r["entry_id"]),
      prevHash: String(r["prev_hash"]),
      entryHash: String(r["entry_hash"]),
      timestampMs: Number(r["timestamp_ms"]),
      sourceEvent: String(r["source_event"]) as LearningSourceEvent,
      kind: String(r["kind"]) as LearningEntryKind,
      domain: String(r["domain"]),
      cue: String(r["cue"]),
      lesson: String(r["lesson"]),
      evidence: String(r["evidence"]),
      forbiddenPattern: r["forbidden_pattern"] ? String(r["forbidden_pattern"]) : undefined,
      glob: r["glob"] ? String(r["glob"]) : undefined,
      scanVerdict: String(r["scan_verdict"]) as SkillVerdict,
      status: String(r["status"]) as LearningEntryStatus,
      confidence: Number(r["confidence"]),
      appliedCount: Number(r["applied_count"]),
      helpedCount: Number(r["helped_count"]),
      regressedCount: Number(r["regressed_count"]),
      targetEntryId: r["target_entry_id"] ? String(r["target_entry_id"]) : undefined
    };
  }
}
