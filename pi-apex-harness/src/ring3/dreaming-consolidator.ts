/**
 * Ring 3 — `Dreaming` Offline Episodic Memory Consolidator (`dream_memory`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - `NousResearch/hermes-agent` @ `765c6463009f` (MIT License):
 *      - `agent/memory_manager.py` (`_redact_for_provider`, lines 95-133): Two-pass learned-token
 *        egress/persistence secret scrubber (Hermes PR #115104 fix — harvests secret values from
 *        key=value / Bearer / sk-* / ghp_* shapes on Pass 1, then scrubs any unlabelled repeat of
 *        the same value ≥8 chars on Pass 2!) + `_StuckCallGate` circuit breaker.
 *  - Claude Cowork `Dreaming` offline consolidation pattern + Ring 0 `Invariant I-01`:
 *      - Consolidates SQLite FTS5 `episodes` into `surfaces/MEMORY.md` strictly bounded by
 *        `guardrails.prefix_caps_o200k.memory_md` (<= 300 `o200k_base` tokens).
 *      - Because Ring 0's `BootPinnedPrefix` snapshots `MEMORY.md` in RAM at `session_start`,
 *        writing `surfaces/MEMORY.md` during an idle/dreaming pass produces ZERO mid-session
 *        `prefixSha256` drift and takes effect cleanly on the NEXT session boot!
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { countO200kTokens } from "../core/prefix-budget.ts";
import type { StateDb } from "../core/state-db.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import type { DurabilityMode, GuardrailsConfig } from "../types.ts";
import { scanSkillBundle } from "./skills-guard-quarantine.ts";

/**
 * Ported directly from `NousResearch/hermes-agent` `agent/memory_manager.py` (`_redact_for_provider`,
 * PR #115104): Two-pass learned-token scrubber!
 *  - Pass 1 harvests secret values from `KEY=VALUE`, `Authorization: Bearer <tok>`, `sk-...`,
 *    `ghp_...`, `xoxb-...`, `AKIA...`, etc. AND runs Ring 0 `scrubSecretsInfallible`.
 *  - Pass 2 scrubs any bare repeat (>= 8 chars) of any harvested secret value anywhere in the batch,
 *    even when a later sentence repeats the raw token without its `API_KEY=` prefix!
 */
const HARVEST_PATTERNS: readonly RegExp[] = [
  /\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"',;}{]{8,})["']?/gi,
  /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi,
  /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g
];

export function redactWithLearnedTokens(texts: readonly string[]): string[] {
  const learnedValues = new Set<string>();

  for (const raw of texts) {
    if (!raw) continue;
    for (const pat of HARVEST_PATTERNS) {
      pat.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.exec(raw)) !== null) {
        const secretVal = m[1];
        if (secretVal && secretVal.length >= 8 && !secretVal.includes("REDACTED")) {
          learnedValues.add(secretVal);
        }
      }
    }
  }

  // Sort longest-first so substring replacements never leave partial suffixes
  const sortedLearned = [...learnedValues].sort((a, b) => b.length - a.length);

  return texts.map((raw) => {
    let stage1 = scrubSecretsInfallible(raw);
    // Scrub labelled `CUSTOM_API_KEY=value` assignments on Pass 1 as well
    stage1 = stage1.replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*([:=])\s*["']?([^\s"',;}{]{8,})["']?/gi,
      "$1$2[REDACTED_SECRET]"
    );
    for (const tok of sortedLearned) {
      if (stage1.includes(tok)) {
        stage1 = stage1.split(tok).join("[REDACTED_SECRET]");
      }
    }
    return stage1;
  });
}

/**
 * Ported from `NousResearch/hermes-agent` `agent/memory_manager.py` (`_StuckCallGate`):
 * Circuit breaker guarding background memory consolidation passes.
 */
export class DreamingCallGate {
  private stuckCount = 0;
  private inflightCount = 0;
  private readonly maxStuck: number;
  private readonly maxInflight: number;

  constructor(maxStuck = 4, maxInflight = 4) {
    this.maxStuck = maxStuck;
    this.maxInflight = maxInflight;
  }

  tryAcquire(): { acquired: boolean; reason?: string } {
    if (this.stuckCount >= this.maxStuck) {
      return {
        acquired: false,
        reason: `DREAMING_CIRCUIT_OPEN: ${this.stuckCount} stuck dreaming passes reached threshold (${this.maxStuck}).`
      };
    }
    if (this.inflightCount >= this.maxInflight) {
      return {
        acquired: false,
        reason: `DREAMING_INFLIGHT_CAP: ${this.inflightCount} concurrent passes active.`
      };
    }
    this.inflightCount += 1;
    return { acquired: true };
  }

  releaseSuccess(): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
  }

  releaseStuckOrFailed(): void {
    this.inflightCount = Math.max(0, this.inflightCount - 1);
    this.stuckCount += 1;
  }
}

export interface DreamingConsolidationResult {
  updated: boolean;
  episodesConsidered: number;
  bulletsRetained: number;
  rejectedPoisonedEpisodes: number;
  memoryMdTokens: number;
  maxMemoryTokens: number;
  memoryMdSha256: string;
  memoryMdPath: string;
  appliesOnNextSessionBoot: true;
}

interface RawEpisodeRow {
  id: number;
  session_id: string;
  summary: string;
  files_touched: string;
  outcome: string;
  created_at_ms: number;
}

export class DreamingMemoryConsolidator {
  private readonly stateDb: StateDb;
  private readonly workspaceRoot: string;
  private readonly surfacesDir: string;
  private readonly maxMemoryTokens: number;
  private readonly durabilityMode: DurabilityMode;
  readonly callGate = new DreamingCallGate();

  constructor(params: {
    stateDb: StateDb;
    workspaceRoot: string;
    surfacesDir: string;
    guardrails: GuardrailsConfig;
    durabilityMode?: DurabilityMode;
  }) {
    this.stateDb = params.stateDb;
    this.workspaceRoot = path.resolve(params.workspaceRoot);
    this.surfacesDir = path.resolve(params.surfacesDir);
    this.maxMemoryTokens = params.guardrails.prefix_caps_o200k.memory_md;
    this.durabilityMode = params.durabilityMode ?? "crash-safe";
  }

  readDiskMemoryMd(): string {
    const p = path.join(this.surfacesDir, "MEMORY.md");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }

  /**
   * Consolidates recent FTS5 episodes into `surfaces/MEMORY.md` strictly capped at
   * `<= maxMemoryTokens` (`300` `o200k_base` tokens), with:
   *  1. Hermes `#115104` two-pass learned-token secret scrubbing
   *  2. `skills-guard-v10` prompt-injection filtering (rejects poisoned episodes!)
   *  3. Deduplication + deterministic token trimming
   *  4. Zero mutation of the live session's boot-pinned in-RAM static prefix!
   */
  runDreamingPass(params?: {
    query?: string;
    limitEpisodes?: number;
    preserveHeaderBullets?: boolean;
  }): DreamingConsolidationResult {
    const gate = this.callGate.tryAcquire();
    if (!gate.acquired) {
      throw new Error(gate.reason);
    }

    try {
      const limit = params?.limitEpisodes ?? 25;
      const rows = params?.query
        ? (this.stateDb.db
            .prepare(
              `SELECT e.id, e.session_id, e.summary, e.files_touched, e.outcome, e.created_at_ms
               FROM episodes_fts f
               JOIN episodes e ON e.id = f.rowid
               WHERE episodes_fts MATCH ?
               ORDER BY bm25(episodes_fts), e.created_at_ms DESC
               LIMIT ?`
            )
            .all(params.query, limit) as unknown as RawEpisodeRow[])
        : (this.stateDb.db
            .prepare(
              `SELECT id, session_id, summary, files_touched, outcome, created_at_ms
               FROM episodes
               ORDER BY created_at_ms DESC, id DESC
               LIMIT ?`
            )
            .all(limit) as unknown as RawEpisodeRow[]);

      const existingDiskMd = this.readDiskMemoryMd();
      const existingBullets =
        params?.preserveHeaderBullets === false
          ? []
          : existingDiskMd
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => l.startsWith("- "));

      // Pass 1 + Pass 2 learned-token secret scrubbing across all episode summaries simultaneously
      const scrubbedSummaries = redactWithLearnedTokens(rows.map((r) => r.summary));

      const candidateBullets: string[] = [];
      let rejectedPoisonedEpisodes = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const cleanSummary = scrubbedSummaries[i]!
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        if (!cleanSummary) continue;

        let filesLabel = "";
        try {
          const parsedFiles = JSON.parse(row.files_touched) as string[];
          if (Array.isArray(parsedFiles) && parsedFiles.length > 0) {
            filesLabel = ` (${parsedFiles.slice(0, 3).join(", ")})`;
          }
        } catch {
          // ignore
        }

        const bullet = `- [${scrubSecretsInfallible(row.outcome)}] ${cleanSummary}${scrubSecretsInfallible(filesLabel)}`;

        // Screen each candidate bullet with `skills-guard-v10` so a poisoned episode can NEVER
        // smuggle prompt-injection or exfiltration directives into next-boot `MEMORY.md`!
        const secCheck = scanSkillBundle({
          skillName: `dream-ep-${row.id}`,
          files: { "MEMORY.md": bullet },
          source: "dreaming-episode",
          trustLevel: "community"
        });
        if (secCheck.verdict !== "safe") {
          rejectedPoisonedEpisodes += 1;
          continue;
        }
        candidateBullets.push(bullet);
      }

      // Deduplicate case-insensitively while keeping newest episodes first, followed by durable baseline bullets
      const seenNormalized = new Set<string>();
      const mergedBullets: string[] = [];
      for (const b of [...candidateBullets, ...existingBullets]) {
        const norm = b.toLowerCase().replace(/\s+/g, " ").trim();
        if (!norm || seenNormalized.has(norm)) continue;
        seenNormalized.add(norm);
        mergedBullets.push(b);
      }

      const header = "# Persistent Workspace Memory";
      const fittedBullets = [...mergedBullets];
      let nextMemoryMd =
        fittedBullets.length > 0
          ? `${header}\n\n${fittedBullets.join("\n")}\n`
          : `${header}\n`;

      // Strictly enforce `<= maxMemoryTokens` (`300` `o200k_base` tokens)
      while (countO200kTokens(nextMemoryMd) > this.maxMemoryTokens && fittedBullets.length > 0) {
        fittedBullets.pop();
        nextMemoryMd =
          fittedBullets.length > 0
            ? `${header}\n\n${fittedBullets.join("\n")}\n`
            : `${header}\n`;
      }

      const memoryPath = path.join(this.surfacesDir, "MEMORY.md");
      writeFileDurable(memoryPath, nextMemoryMd, this.durabilityMode, {
        workspaceRoot: this.surfacesDir,
        mode: 0o644
      });

      const tokens = countO200kTokens(nextMemoryMd);
      const sha256 = crypto.createHash("sha256").update(nextMemoryMd, "utf8").digest("hex");
      this.callGate.releaseSuccess();

      return {
        updated: nextMemoryMd !== existingDiskMd,
        episodesConsidered: rows.length,
        bulletsRetained: fittedBullets.length,
        rejectedPoisonedEpisodes,
        memoryMdTokens: tokens,
        maxMemoryTokens: this.maxMemoryTokens,
        memoryMdSha256: sha256,
        memoryMdPath: "surfaces/MEMORY.md",
        appliesOnNextSessionBoot: true
      };
    } catch (err) {
      this.callGate.releaseStuckOrFailed();
      throw err;
    }
  }
}
