/**
 * Ring 3 — Offline `Harness²` Contrastive `Propose–Probe–Compose` Self-Evolution Engine
 * & Domain Experience Library (`experience_evolver`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - `google-research/harness2` @ `1cfe254e8d25` (Apache-2.0 License, Google LLC):
 *      - `harness2/core/library.py`: `Library` (`<root>/<domain>/INDEX.md` +
 *        `harnesses/<slug>/EXPERIENCE.md`), `has_experience` (`cue`, `lesson`, `evidence`,
 *        `confidence`, `edits`), `forget`, `retain`, `rebuild_index`, `_slug`.
 *      - `harness2/core/selection.py`: `assign_ids` (deterministic SHA-1 seeded anonymization
 *        `A..Z, AA..`), `selection_pool`, `_CHOICE`, `_WHY`, `_EXP`, `_EDITS` parsers, and
 *        neutral `base` fallback on selector failure.
 *      - `harness2/core/context.py`: `GRADER_VERDICT_MARKERS` and
 *        `assert_tree_has_no_grader_verdicts` benchmark/grader leak tripwire.
 *  - `deepseek-ai/deepseek-harness` (`dsh`) 4-gate promotion philosophy + `Harness²` Issue #94 fix:
 *      - Self-evolution is strictly confined to `surfaces/EXPERIENCE.md` and `.harness/library/`.
 *        `surfaces-immutable/GUARDRAILS.yaml`, `surfaces/SYSTEM.md`, `surfaces/TOOL_GUIDANCE.md`,
 *        `src/**`, and `.git/**` are mechanically untouchable (`IMMUTABLE_SURFACE_VIOLATION`), and
 *        `loadVerifiedGuardrails()` verifies `COMPILED_GUARDRAILS_SHA256` before and after every pass.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadVerifiedGuardrails } from "../core/guardrail-pin.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { countO200kTokens } from "../core/prefix-budget.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import type { DurabilityMode } from "../types.ts";
import { scanSkillBundle } from "./skills-guard-quarantine.ts";

/**
 * Ported directly from `google-research/harness2` `harness2/core/context.py` (`GRADER_VERDICT_MARKERS`).
 */
export const GRADER_VERDICT_MARKERS: readonly string[] = [
  "grader_verdict",
  "grader_output",
  "deterministic_eval_summary",
  "deterministic_eval_result",
  "judge_scope_and_deterministic_status",
  "Judge findings on the rendered result",
  '"passed_count"',
  '"pass_rate"',
  '"test_pass_rate"'
];

const MARKER_SCAN_SUFFIXES = new Set([
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".log",
  ".py",
  ".js",
  ".ts",
  ".sh",
  ".xml",
  ".ini",
  ".toml",
  ".patch",
  ".diff",
  ""
]);

/**
 * Ported directly from `google-research/harness2` `harness2/core/context.py`
 * (`assert_tree_has_no_grader_verdicts`).
 */
export function assertTreeHasNoGraderVerdicts(
  tree: Readonly<Record<string, string>>,
  markers: readonly string[] = GRADER_VERDICT_MARKERS
): void {
  for (const rel of Object.keys(tree).sort()) {
    for (const m of markers) {
      if (rel.includes(m)) {
        throw new Error(
          `GRADER_VERDICT_LEAK: Harness file '${rel}' contains grader-verdict marker '${m}' in its NAME.`
        );
      }
    }
    const ext = path.extname(rel).toLowerCase();
    if (!MARKER_SCAN_SUFFIXES.has(ext)) continue;
    const body = String(tree[rel] ?? "");
    for (const m of markers) {
      const where = body.indexOf(m);
      if (where >= 0) {
        const snippet = body.slice(Math.max(0, where - 40), where + 80);
        throw new Error(
          `GRADER_VERDICT_LEAK: Harness file '${rel}' contains grader-verdict marker '${m}' at offset ${where} (${JSON.stringify(snippet)}).`
        );
      }
    }
  }
}

export interface DistilledExperience {
  cue: string;
  lesson: string;
  evidence: string;
  confidence?: string;
  edits?: string;
}

/**
 * Ported from `google-research/harness2` `harness2/core/library.py` (`has_experience`).
 */
export function hasValidExperience(exp: Partial<DistilledExperience> | null | undefined): exp is DistilledExperience {
  if (!exp || typeof exp !== "object") return false;
  return Boolean(
    typeof exp.cue === "string" &&
      exp.cue.trim() &&
      typeof exp.lesson === "string" &&
      exp.lesson.trim() &&
      typeof exp.evidence === "string" &&
      exp.evidence.trim()
  );
}

/**
 * Ported from `google-research/harness2` `harness2/core/library.py` (`_slug`).
 */
export function slugifyHarnessEntry(text: string): string {
  const cleaned = text.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "entry").slice(0, 80);
}

/**
 * Deterministic SHA-1 seeded candidate ID anonymization (`A..Z, AA..AZ...`) ported directly from
 * `google-research/harness2` `harness2/core/selection.py` (`assign_ids` / `_anon_id`).
 */
export function anonIdFromIndex(index: number): string {
  let out = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    n = Math.floor((n - 1) / 26);
    out = String.fromCharCode(65 + rem) + out;
  }
  return out;
}

export function assignAnonymousCandidateIds(
  labels: readonly string[],
  seedKey = ""
): Record<string, string> {
  const ordered = [...labels].sort();
  // Deterministic PRNG seeded from SHA-1(seedKey | sorted labels), matching Harness² `selection.py`
  let stateHash = crypto
    .createHash("sha1")
    .update(`${seedKey}|${ordered.join(",")}`, "utf8")
    .digest();

  let byteCursor = 0;
  const nextUint32 = (): number => {
    if (byteCursor + 4 > stateHash.length) {
      stateHash = crypto.createHash("sha1").update(stateHash).digest();
      byteCursor = 0;
    }
    const val = stateHash.readUInt32BE(byteCursor);
    byteCursor += 4;
    return val;
  };

  // Fisher-Yates shuffle on `ordered`
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = nextUint32() % (i + 1);
    const tmp = ordered[i]!;
    ordered[i] = ordered[j]!;
    ordered[j] = tmp;
  }

  const out: Record<string, string> = {};
  for (let i = 0; i < ordered.length; i++) {
    out[anonIdFromIndex(i)] = ordered[i]!;
  }
  return out;
}

const CHOICE_BLOCK_RE = /```choice\s*\r?\n\s*(\S+)\s*\r?\n```/i;
const WHY_TAG_RE = /<why>([\s\S]*?)<\/why>/i;
const EXP_TAG_RE = /<experience>([\s\S]*?)<\/experience>/i;
const EDITS_TAG_RE = /<edits>([\s\S]*?)<\/edits>/i;

/**
 * Ported from `google-research/harness2` `harness2/core/selection.py` (`_CHOICE` + `_WHY`).
 */
export function parseSelectorChoiceAndWhy(replyText: string): {
  chosenAnonId: string | null;
  why: string;
} {
  const mChoice = CHOICE_BLOCK_RE.exec(replyText);
  const mWhy = WHY_TAG_RE.exec(replyText);
  return {
    chosenAnonId: mChoice ? mChoice[1]!.trim() : null,
    why: mWhy ? mWhy[1]!.trim() : ""
  };
}

/**
 * Ported from `google-research/harness2` `harness2/core/selection.py` (`_distil`: `_EXP` + `_EDITS`).
 */
export function parseDistilledExperienceReply(replyText: string): DistilledExperience | null {
  const mExp = EXP_TAG_RE.exec(replyText);
  if (!mExp) return null;

  const fields: Partial<DistilledExperience> = {};
  for (const rawLine of mExp[1]!.trim().split(/\r?\n/)) {
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = rawLine.slice(0, colonIdx).trim().toLowerCase();
    const val = rawLine.slice(colonIdx + 1).trim();
    if (key === "cue" || key === "lesson" || key === "evidence" || key === "confidence") {
      fields[key] = val;
    }
  }
  if (!hasValidExperience(fields)) {
    return null;
  }
  const mEdits = EDITS_TAG_RE.exec(replyText);
  if (mEdits && mEdits[1]!.trim()) {
    fields.edits = mEdits[1]!.trim();
  }
  assertTreeHasNoGraderVerdicts({ "EXPERIENCE.md": JSON.stringify(fields) });
  return fields;
}

// ---------------------------------------------------------------------------
// Harness² Domain `Library` (`harness2/core/library.py`)
// ---------------------------------------------------------------------------

export interface DomainLibraryEntry {
  slug: string;
  domain: string;
  experience: DistilledExperience;
  createdAtMs: number;
}

export class ExperienceDomainLibrary {
  readonly rootDir: string;
  private readonly workspaceRoot: string;
  private readonly durabilityMode: DurabilityMode;

  constructor(params: {
    workspaceRoot: string;
    libraryDir?: string;
    durabilityMode?: DurabilityMode;
  }) {
    this.workspaceRoot = path.resolve(params.workspaceRoot);
    this.rootDir =
      params.libraryDir ?? path.join(this.workspaceRoot, ".harness", "experience-library");
    this.durabilityMode = params.durabilityMode ?? "crash-safe";
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o755 });
  }

  record(params: {
    domain: string;
    taskId: string;
    experience: DistilledExperience;
    nowMs?: number;
  }): DomainLibraryEntry {
    if (!hasValidExperience(params.experience)) {
      throw new Error("EXPERIENCE_INVALID: Entry must have non-empty cue, lesson, and evidence.");
    }
    const scrubbed: DistilledExperience = {
      cue: scrubSecretsInfallible(params.experience.cue),
      lesson: scrubSecretsInfallible(params.experience.lesson),
      evidence: scrubSecretsInfallible(params.experience.evidence),
      confidence: params.experience.confidence
        ? scrubSecretsInfallible(params.experience.confidence)
        : undefined,
      edits: params.experience.edits ? scrubSecretsInfallible(params.experience.edits) : undefined
    };
    assertTreeHasNoGraderVerdicts({ "EXPERIENCE.md": JSON.stringify(scrubbed) });

    const domainSlug = slugifyHarnessEntry(params.domain);
    const entrySlug = slugifyHarnessEntry(params.taskId);
    const entryDir = path.join(this.rootDir, domainSlug, "harnesses", entrySlug);
    fs.mkdirSync(entryDir, { recursive: true, mode: 0o755 });

    const mdLines = [
      `# ${entrySlug}`,
      "",
      `- **cue**: ${scrubbed.cue}`,
      `- **lesson**: ${scrubbed.lesson}`,
      `- **evidence**: ${scrubbed.evidence}`
    ];
    if (scrubbed.confidence) mdLines.push(`- **confidence**: ${scrubbed.confidence}`);
    if (scrubbed.edits) mdLines.push("", "## Edits", "", scrubbed.edits);

    const payload = {
      slug: entrySlug,
      domain: domainSlug,
      experience: scrubbed,
      createdAtMs: params.nowMs ?? Date.now()
    };

    writeFileDurable(
      path.join(entryDir, "EXPERIENCE.md"),
      mdLines.join("\n") + "\n",
      this.durabilityMode,
      { workspaceRoot: this.rootDir, mode: 0o644 }
    );
    writeFileDurable(
      path.join(entryDir, "experience.json"),
      JSON.stringify(payload, null, 2) + "\n",
      this.durabilityMode,
      { workspaceRoot: this.rootDir, mode: 0o644 }
    );

    this.rebuildIndex(domainSlug);
    return payload;
  }

  listEntries(domain: string): DomainLibraryEntry[] {
    const domainSlug = slugifyHarnessEntry(domain);
    const harnessesDir = path.join(this.rootDir, domainSlug, "harnesses");
    if (!fs.existsSync(harnessesDir)) return [];
    const entries: DomainLibraryEntry[] = [];
    for (const dirent of fs.readdirSync(harnessesDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const jsonPath = path.join(harnessesDir, dirent.name, "experience.json");
      if (!fs.existsSync(jsonPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as DomainLibraryEntry;
        if (hasValidExperience(parsed.experience)) {
          entries.push(parsed);
        }
      } catch {
        // Ignore malformed entry
      }
    }
    return entries.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Ported from `google-research/harness2` `harness2/core/library.py` (`rebuild_index`).
   */
  rebuildIndex(domain: string): string {
    const domainSlug = slugifyHarnessEntry(domain);
    const domainDir = path.join(this.rootDir, domainSlug);
    fs.mkdirSync(domainDir, { recursive: true, mode: 0o755 });
    const entries = this.listEntries(domainSlug);
    const lines: string[] = [
      `# Harness² Experience Index — ${domainSlug}`,
      ""
    ];
    for (const e of entries) {
      lines.push(
        `- **${e.slug}** [cue: ${e.experience.cue}] -> ${e.experience.lesson} _(evidence: ${e.experience.evidence}${
          e.experience.confidence ? `, confidence: ${e.experience.confidence}` : ""
        })_`
      );
    }
    const indexMd = lines.join("\n") + "\n";
    writeFileDurable(path.join(domainDir, "INDEX.md"), indexMd, this.durabilityMode, {
      workspaceRoot: this.rootDir,
      mode: 0o644
    });
    return indexMd;
  }

  /**
   * Ported from `google-research/harness2` `harness2/core/library.py` (`forget`).
   */
  forget(domain: string, slugsToRemove: readonly string[]): number {
    const domainSlug = slugifyHarnessEntry(domain);
    const harnessesDir = path.join(this.rootDir, domainSlug, "harnesses");
    if (!fs.existsSync(harnessesDir)) return 0;
    let removed = 0;
    for (const raw of slugsToRemove) {
      const s = slugifyHarnessEntry(raw);
      const target = path.join(harnessesDir, s);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        removed++;
      }
    }
    this.rebuildIndex(domainSlug);
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Contrastive `Propose–Probe–Compose` + 4-Gate Validator (`Harness²` Issue #94 Fix)
// ---------------------------------------------------------------------------

export interface CandidateRollout {
  label: string; // e.g. "base", "c1", "c2", "agg1"
  proposedTargetSurface: string; // MUST equal "surfaces/EXPERIENCE.md" to pass Gate 1!
  proposedExperience: DistilledExperience;
  answerText: string;
  probeScore: number; // e.g. [0.0 .. 1.0] empirical probe pass score
  probeRegressions: number; // MUST equal 0 for promotion
}

export interface FourGateValidationReport {
  passed: boolean;
  gate1ImmutableSurfacePin: { passed: boolean; detail: string };
  gate2SecurityAndGraderLeak: { passed: boolean; detail: string };
  gate3TokenBudget: { passed: boolean; tokens: number; maxTokens: number; detail: string };
  gate4EmpiricalProbe: {
    passed: boolean;
    baselineScore: number;
    candidateScore: number;
    regressions: number;
    detail: string;
  };
}

export interface ContrastiveEvolutionResult {
  adopted: boolean;
  chosenLabel: string;
  anonymousMap: Record<string, string>;
  why: string;
  gateReport: FourGateValidationReport | null;
  experienceMdTokens: number;
  guardrailsSha256Verified: string;
}

const ALLOWED_MUTABLE_EXPERIENCE_SURFACE = "surfaces/EXPERIENCE.md";
const DEFAULT_MAX_EXPERIENCE_TOKENS = 220;

export class Harness2ContrastiveEvolver {
  private readonly workspaceRoot: string;
  private readonly surfacesDir: string;
  private readonly guardrailsPath?: string;
  private readonly expectedGuardrailsSha256?: string;
  private readonly durabilityMode: DurabilityMode;
  private readonly maxExperienceTokens: number;
  private readonly db: DatabaseSync;
  readonly library: ExperienceDomainLibrary;

  constructor(params: {
    workspaceRoot: string;
    surfacesDir: string;
    db: DatabaseSync;
    guardrailsPath?: string;
    expectedGuardrailsSha256?: string;
    durabilityMode?: DurabilityMode;
    maxExperienceTokens?: number;
  }) {
    this.workspaceRoot = path.resolve(params.workspaceRoot);
    this.surfacesDir = path.resolve(params.surfacesDir);
    this.db = params.db;
    this.guardrailsPath = params.guardrailsPath;
    this.expectedGuardrailsSha256 = params.expectedGuardrailsSha256;
    this.durabilityMode = params.durabilityMode ?? "crash-safe";
    this.maxExperienceTokens = params.maxExperienceTokens ?? DEFAULT_MAX_EXPERIENCE_TOKENS;
    this.library = new ExperienceDomainLibrary({
      workspaceRoot: this.workspaceRoot,
      durabilityMode: this.durabilityMode
    });
    this._initSchema();
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ring3_evolution_runs (
        run_id            TEXT PRIMARY KEY,
        domain            TEXT NOT NULL,
        task_id           TEXT NOT NULL,
        chosen_label      TEXT NOT NULL,
        adopted           INTEGER NOT NULL,
        why               TEXT NOT NULL,
        gate_report_json  TEXT,
        created_at_ms     INTEGER NOT NULL
      );
    `);
  }

  readCurrentExperienceMd(): string {
    const p = path.join(this.surfacesDir, "EXPERIENCE.md");
    if (!fs.existsSync(p)) {
      return "# Harness Experience Library (Mutable Offline Surface)\n";
    }
    return fs.readFileSync(p, "utf8");
  }

  /**
   * Formats the composed `surfaces/EXPERIENCE.md` document by merging a newly validated
   * `DistilledExperience` lesson with existing entries while respecting `maxExperienceTokens`.
   */
  composeExperienceMarkdown(existingMd: string, nextLesson: DistilledExperience): string {
    const header = "# Harness Experience Library (Mutable Offline Surface)";
    const scrubbedBlock = [
      `- **cue**: ${scrubSecretsInfallible(nextLesson.cue)}`,
      `  **lesson**: ${scrubSecretsInfallible(nextLesson.lesson)}`,
      `  **evidence**: ${scrubSecretsInfallible(nextLesson.evidence)}`,
      `  **confidence**: ${scrubSecretsInfallible(nextLesson.confidence ?? "medium")}`
    ].join("\n");

    const rawBlocks = existingMd
      .split(/\n(?=- \*\*cue\*\*:)/)
      .map((b) => b.trim())
      .filter((b) => b.startsWith("- **cue**:"));

    // Deduplicate identical cues (newest wins at top)
    const cuePrefix = `- **cue**: ${scrubSecretsInfallible(nextLesson.cue)}`;
    const keptBlocks = [
      scrubbedBlock,
      ...rawBlocks.filter((b) => !b.startsWith(cuePrefix))
    ];

    // Trim oldest entries if needed to stay within `maxExperienceTokens`, UNLESS the single newest block itself exceeds budget
    while (keptBlocks.length > 1) {
      const candidateDoc = `${header}\n\n${keptBlocks.join("\n\n")}\n`;
      if (countO200kTokens(candidateDoc) <= this.maxExperienceTokens) {
        return candidateDoc;
      }
      keptBlocks.pop();
    }
    return `${header}\n\n${keptBlocks.join("\n\n")}\n`;
  }

  /**
   * Evaluates a proposed `EXPERIENCE.md` update through all 4 deterministic gates:
   *  - Gate 1: Immutable Surface & `COMPILED_GUARDRAILS_SHA256` Integrity (`Harness²` Issue #94 fix)
   *  - Gate 2: `skills-guard-v10` Security Scan + `GRADER_VERDICT_MARKERS` Leak Check
   *  - Gate 3: `o200k_base` Token Cap (`<= maxExperienceTokens`)
   *  - Gate 4: Empirical Probe Non-Regression (`candidate.probeScore >= baseline.probeScore && regressions === 0`)
   */
  validateCandidateFourGates(params: {
    baseline: CandidateRollout;
    candidate: CandidateRollout;
    composedExperienceMd: string;
  }): FourGateValidationReport {
    // Gate 1: Immutable surface boundary + Guardrails SHA-256 verification
    const guardrailsVerified = loadVerifiedGuardrails(
      this.guardrailsPath,
      this.expectedGuardrailsSha256
    );
    const normalizedTarget = path.posix.normalize(
      params.candidate.proposedTargetSurface.replace(/\\/g, "/").replace(/^\.\//, "")
    );
    const gate1Passed =
      normalizedTarget === ALLOWED_MUTABLE_EXPERIENCE_SURFACE && Boolean(guardrailsVerified.sha256);
    const gate1Detail = gate1Passed
      ? `Target strictly confined to '${ALLOWED_MUTABLE_EXPERIENCE_SURFACE}'; GUARDRAILS.yaml SHA-256 intact (${guardrailsVerified.sha256.slice(0, 12)}...).`
      : `IMMUTABLE_SURFACE_VIOLATION: Self-evolution attempted to target '${params.candidate.proposedTargetSurface}' (only '${ALLOWED_MUTABLE_EXPERIENCE_SURFACE}' is mutable; Harness² Issue #94 guard).`;

    // Gate 2: Security scan + Grader verdict leak tripwire
    let gate2Passed = true;
    let gate2Detail = "Clean skills-guard-v10 scan and zero grader-verdict markers.";
    try {
      assertTreeHasNoGraderVerdicts({
        "EXPERIENCE.md": params.composedExperienceMd
      });
      const secScan = scanSkillBundle({
        skillName: "experience-surface",
        files: { "EXPERIENCE.md": params.composedExperienceMd },
        source: "harness2-compose",
        trustLevel: "agent-created"
      });
      if (secScan.verdict !== "safe") {
        gate2Passed = false;
        gate2Detail = `SECURITY_GATE_BLOCKED: Experience update flagged '${secScan.verdict}' (${secScan.findings.map((f) => f.patternId).join(", ")}).`;
      }
    } catch (err) {
      gate2Passed = false;
      gate2Detail = err instanceof Error ? err.message : String(err);
    }

    // Gate 3: `o200k_base` token budget
    const tokens = countO200kTokens(params.composedExperienceMd);
    const gate3Passed = tokens <= this.maxExperienceTokens;
    const gate3Detail = gate3Passed
      ? `EXPERIENCE.md uses ${tokens}/${this.maxExperienceTokens} o200k_base tokens.`
      : `TOKEN_BUDGET_EXCEEDED: Composed EXPERIENCE.md uses ${tokens} tokens (> ${this.maxExperienceTokens} cap).`;

    // Gate 4: Empirical probe non-regression
    const gate4Passed =
      params.candidate.probeRegressions === 0 &&
      params.candidate.probeScore >= params.baseline.probeScore &&
      hasValidExperience(params.candidate.proposedExperience);
    const gate4Detail = gate4Passed
      ? `Probe score improved/held (${params.baseline.probeScore.toFixed(2)} -> ${params.candidate.probeScore.toFixed(2)}, 0 regressions).`
      : `PROBE_REGRESSION_BLOCKED: Candidate probeScore=${params.candidate.probeScore.toFixed(2)} vs baseline=${params.baseline.probeScore.toFixed(2)}, regressions=${params.candidate.probeRegressions}.`;

    return {
      passed: gate1Passed && gate2Passed && gate3Passed && gate4Passed,
      gate1ImmutableSurfacePin: { passed: gate1Passed, detail: gate1Detail },
      gate2SecurityAndGraderLeak: { passed: gate2Passed, detail: gate2Detail },
      gate3TokenBudget: {
        passed: gate3Passed,
        tokens,
        maxTokens: this.maxExperienceTokens,
        detail: gate3Detail
      },
      gate4EmpiricalProbe: {
        passed: gate4Passed,
        baselineScore: params.baseline.probeScore,
        candidateScore: params.candidate.probeScore,
        regressions: params.candidate.probeRegressions,
        detail: gate4Detail
      }
    };
  }

  /**
   * Runs one complete `Harness²` Contrastive `Propose–Probe–Compose` cycle:
   *  1. Builds anonymized candidate pool (`assignAnonymousCandidateIds`, dropping empty answers & excluding `base` from pool unless fallback).
   *  2. Selects winning candidate (either via explicit `selectorReplyText` `` ```choice <ANON_ID>``` `` or best non-regressing probe rollout).
   *  3. Validates winning candidate through the 4-Gate Validator.
   *  4. On 4-gate pass, persists lesson into `ExperienceDomainLibrary` AND updates `surfaces/EXPERIENCE.md`
   *     atomically for future sessions — re-verifying `COMPILED_GUARDRAILS_SHA256` afterwards!
   */
  runProposeProbeCompose(params: {
    domain: string;
    taskId: string;
    baseline: CandidateRollout;
    candidates: readonly CandidateRollout[];
    selectorReplyText?: string;
    nowMs?: number;
  }): ContrastiveEvolutionResult {
    // Pre-flight guardrail pin check
    const preGuardrails = loadVerifiedGuardrails(
      this.guardrailsPath,
      this.expectedGuardrailsSha256
    );

    // Filter out empty answers (Harness² `selection.py`: "Empty answers are dropped before anonymizing")
    const nonEmptyCandidates = params.candidates.filter(
      (c) => c.label !== "base" && Boolean(c.answerText && c.answerText.trim())
    );

    if (nonEmptyCandidates.length === 0) {
      return {
        adopted: false,
        chosenLabel: "base",
        anonymousMap: {},
        why: "No non-empty candidate rollouts; neutral fallback to base.",
        gateReport: null,
        experienceMdTokens: countO200kTokens(this.readCurrentExperienceMd()),
        guardrailsSha256Verified: preGuardrails.sha256
      };
    }

    const anonMap = assignAnonymousCandidateIds(
      nonEmptyCandidates.map((c) => c.label),
      `${params.domain}:${params.taskId}`
    );
    const byLabel = new Map(nonEmptyCandidates.map((c) => [c.label, c]));

    let chosenCandidate: CandidateRollout | undefined;
    let why = "";

    if (params.selectorReplyText) {
      const parsed = parseSelectorChoiceAndWhy(params.selectorReplyText);
      why = parsed.why;
      if (parsed.chosenAnonId && anonMap[parsed.chosenAnonId]) {
        chosenCandidate = byLabel.get(anonMap[parsed.chosenAnonId]!);
      }
    } else {
      // Deterministic contrastive probe selection when no external LLM selector transcript is supplied
      const sorted = [...nonEmptyCandidates].sort((a, b) => {
        if (b.probeScore !== a.probeScore) return b.probeScore - a.probeScore;
        return a.probeRegressions - b.probeRegressions;
      });
      chosenCandidate = sorted[0];
      why = `Contrastive probe winner '${chosenCandidate?.label}' (${chosenCandidate?.probeScore.toFixed(2)} vs base ${params.baseline.probeScore.toFixed(2)}).`;
    }

    // Harness² `selection.py`: neutral fallback to `base` if selector output didn't map to a valid candidate
    if (!chosenCandidate) {
      return {
        adopted: false,
        chosenLabel: "base",
        anonymousMap: anonMap,
        why: why || "Selector returned invalid/unknown anonymous ID; neutral fallback to base.",
        gateReport: null,
        experienceMdTokens: countO200kTokens(this.readCurrentExperienceMd()),
        guardrailsSha256Verified: preGuardrails.sha256
      };
    }

    const existingMd = this.readCurrentExperienceMd();
    const composedMd = this.composeExperienceMarkdown(
      existingMd,
      chosenCandidate.proposedExperience
    );
    const gateReport = this.validateCandidateFourGates({
      baseline: params.baseline,
      candidate: chosenCandidate,
      composedExperienceMd: composedMd
    });

    const nowMs = params.nowMs ?? Date.now();
    const runId = `evo-${crypto.randomUUID()}`;

    if (!gateReport.passed) {
      this.db
        .prepare(
          `INSERT INTO ring3_evolution_runs (run_id, domain, task_id, chosen_label, adopted, why, gate_report_json, created_at_ms)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          runId,
          params.domain,
          params.taskId,
          chosenCandidate.label,
          why,
          JSON.stringify(gateReport),
          nowMs
        );

      const postGuardrails = loadVerifiedGuardrails(
        this.guardrailsPath,
        this.expectedGuardrailsSha256
      );
      return {
        adopted: false,
        chosenLabel: chosenCandidate.label,
        anonymousMap: anonMap,
        why,
        gateReport,
        experienceMdTokens: countO200kTokens(existingMd),
        guardrailsSha256Verified: postGuardrails.sha256
      };
    }

    // All 4 gates passed -> Compose into `surfaces/EXPERIENCE.md` + `ExperienceDomainLibrary`
    writeFileDurable(
      path.join(this.surfacesDir, "EXPERIENCE.md"),
      composedMd,
      this.durabilityMode,
      { workspaceRoot: this.surfacesDir, mode: 0o644 }
    );

    this.library.record({
      domain: params.domain,
      taskId: params.taskId,
      experience: chosenCandidate.proposedExperience,
      nowMs
    });

    // Post-flight Guardrails cryptographic verification (`Harness²` Issue #94 post-condition!)
    const postGuardrails = loadVerifiedGuardrails(
      this.guardrailsPath,
      this.expectedGuardrailsSha256
    );

    this.db
      .prepare(
        `INSERT INTO ring3_evolution_runs (run_id, domain, task_id, chosen_label, adopted, why, gate_report_json, created_at_ms)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        runId,
        params.domain,
        params.taskId,
        chosenCandidate.label,
        why,
        JSON.stringify(gateReport),
        nowMs
      );

    return {
      adopted: true,
      chosenLabel: chosenCandidate.label,
      anonymousMap: anonMap,
      why,
      gateReport,
      experienceMdTokens: countO200kTokens(composedMd),
      guardrailsSha256Verified: postGuardrails.sha256
    };
  }

  /**
   * Recalls matching domain experiences at turn tail (`+0` static prefix tokens!).
   */
  recallRelevantExperiences(params: { domain: string; query?: string; limit?: number }): DomainLibraryEntry[] {
    const all = this.library.listEntries(params.domain);
    const q = (params.query ?? "").trim().toLowerCase();
    const filtered = !q
      ? all
      : all.filter(
          (e) =>
            e.experience.cue.toLowerCase().includes(q) ||
            e.experience.lesson.toLowerCase().includes(q) ||
            e.slug.toLowerCase().includes(q)
        );
    return filtered.slice(0, params.limit ?? 5);
  }
}
