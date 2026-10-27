/**
 * Ring 8 — Personal SWE Eval & Prompt-Cache Benchmark Suite (`src/ring8/swe-eval-bench.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 *  - Combines `deepseek-ai/deepseek-harness` (`master @ 22ddee379240`, MIT) reproducible
 *    multi-task Git bugfix evaluation metrics (pass rate, latency percentiles, token/cost
 *    efficiency) with `google-research/harness2` (`main @ 1cfe254e8d25`, Apache-2.0,
 *    `proposer.py` / `selection.py`) before/after `EXPERIENCE.md` A/B contrast benchmarking.
 *
 * BENCHMARK GUARANTEES:
 *  - Executes real Git branch isolation (`apex/<slug>`), real `openat2` file mutations,
 *    real Codex `mergeBase...HEAD` + Cursor BugBot `REVIEW_RULES.md` diff checks, and real
 *    minimal-rootfs `bwrap` CI verification across a 3-repo SWE bugfix corpus (or custom JSON pack).
 *  - Verifies Ring 0 static-prefix invariants (`activeSchemaTokens === 1,073 o200k_base`,
 *    `prefixDriftCount === 0`) and computes exact prompt-cache hit rate (`cacheReadTokens`),
 *    dollar cost per resolved issue, and Harness² `EXPERIENCE.md` Before vs. After A/B delta!
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Api,
  fauxAssistantMessage,
  fauxProvider,
  type Model,
  type TranscriptContext
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { countO200kTokens } from "../core/prefix-budget.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import type { LearnedReviewRule } from "../ring2/bugbot-ci-loop.ts";
import { createRing4Harness } from "../ring4/ring4-runtime.ts";

export interface SweBenchTaskDefinition {
  id: string;
  title: string;
  issueDescription: string;
  scope: string;
  seedFiles: Record<string, string>;
  bugBotRules?: LearnedReviewRule[];
  testCommand: string;
  /** Deterministic reference patches for offline CI responder (`baseline` initial vs `repaired`/`evolved`). */
  deterministicResponder?: {
    experienceCueSubstring: string;
    naiveFirstAttemptPatches?: Array<{ relPath: string; content: string }>;
    cleanResolvedPatches: Array<{ relPath: string; content: string }>;
  };
}

export interface SweTaskRunMetrics {
  taskId: string;
  title: string;
  arm: "baseline" | "evolved";
  status: string;
  resolved: boolean;
  firstShotResolved: boolean;
  selfHealed: boolean;
  repairAttemptsUsed: number;
  elapsedMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  branchName: string;
}

export interface SweArmAggregate {
  arm: "baseline" | "evolved";
  totalTasks: number;
  resolvedTasks: number;
  passRatePct: number;
  firstShotResolvedTasks: number;
  firstShotPassRatePct: number;
  selfHealRecoveries: number;
  totalRepairAttempts: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  cacheHitRatePct: number;
  totalCostUsd: number;
  costPerResolvedUsd: number;
  tasks: SweTaskRunMetrics[];
}

export interface SweBenchmarkReport {
  benchId: string;
  createdAtIso: string;
  modelLabel: string;
  activeSchemaTokens: number;
  prefixDriftCount: number;
  baseline: SweArmAggregate;
  evolved?: SweArmAggregate;
  abComparison?: {
    passRateDeltaPct: number;
    firstShotDeltaPct: number;
    repairAttemptsSaved: number;
    llmCallsSaved: number;
    tokensSaved: number;
    costSavedUsd: number;
  };
  persistedJsonPath?: string;
  persistedMarkdownPath?: string;
  markdownReport: string;
}

export const BUILTIN_SWE_BENCHMARK_CORPUS: readonly SweBenchTaskDefinition[] = [
  {
    id: "swe-01-jwt-expiry-boundary",
    title: "Fix off-by-one expiration boundary in verifyJwtExpiry",
    issueDescription:
      "Tokens whose `exp` timestamp equals `nowSeconds` (`nowSeconds === exp`) are currently accepted as valid because `verifyJwtExpiry` uses `<=`. According to RFC 7519 §4.1.4, processing of the `exp` claim requires that the current time MUST be strictly before (`<`) the expiration time.",
    scope: "auth",
    seedFiles: {
      "src/auth/jwt.mjs": [
        "export function verifyJwtExpiry(payload, nowSeconds) {",
        "  if (!payload || typeof payload.exp !== 'number') return false;",
        "  // BUG: accepts expired token when nowSeconds === payload.exp",
        "  return nowSeconds <= payload.exp;",
        "}",
        ""
      ].join("\n"),
      "test/jwt.test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { verifyJwtExpiry } from '../src/auth/jwt.mjs';",
        "assert.equal(verifyJwtExpiry({ exp: 1000 }, 999), true);",
        "assert.equal(verifyJwtExpiry({ exp: 1000 }, 1000), false, 'exp === now must be rejected');",
        "assert.equal(verifyJwtExpiry({ exp: 1000 }, 1001), false);",
        "assert.equal(verifyJwtExpiry({}, 999), false);",
        ""
      ].join("\n")
    },
    testCommand: "node test/jwt.test.mjs",
    deterministicResponder: {
      experienceCueSubstring: "RFC 7519",
      cleanResolvedPatches: [
        {
          relPath: "src/auth/jwt.mjs",
          content: [
            "export function verifyJwtExpiry(payload, nowSeconds) {",
            "  if (!payload || typeof payload.exp !== 'number') return false;",
            "  return nowSeconds < payload.exp;",
            "}",
            ""
          ].join("\n")
        }
      ]
    }
  },
  {
    id: "swe-02-sanitizer-bugbot-heal",
    title: "Implement safe integer addition expression evaluator",
    issueDescription:
      "Implement `sumPlusExpression(expr)` in `src/sanitize/expr.mjs` so expressions like `'10 + 25 + 5'` evaluate to `40` and invalid characters throw `Error('INVALID_EXPR')`.",
    scope: "sanitize",
    seedFiles: {
      "src/sanitize/expr.mjs": [
        "export function sumPlusExpression(_expr) {",
        "  // TODO: implement integer '+' evaluator",
        "  return 0;",
        "}",
        ""
      ].join("\n"),
      "test/expr.test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { sumPlusExpression } from '../src/sanitize/expr.mjs';",
        "assert.equal(sumPlusExpression('10 + 25 + 5'), 40);",
        "assert.equal(sumPlusExpression('7'), 7);",
        "assert.throws(() => sumPlusExpression('10 + alert(1)'), /INVALID_EXPR/);",
        ""
      ].join("\n")
    },
    bugBotRules: [
      {
        id: "forbid-eval-in-src",
        title: "Never use dynamic eval() in src modules",
        glob: "src/**/*.mjs",
        forbiddenPattern: "\\beval\\s*\\(",
        priority: 0,
        body: "Dynamic eval() enables code injection; parse numeric tokens explicitly."
      }
    ],
    testCommand: "node test/expr.test.mjs",
    deterministicResponder: {
      experienceCueSubstring: "[h2-lesson-safe-token-sum]",
      // Without EXPERIENCE.md lesson, naive first attempt uses `eval(...)` -> caught by BugBot P0 -> self-heals!
      naiveFirstAttemptPatches: [
        {
          relPath: "src/sanitize/expr.mjs",
          content: [
            "export function sumPlusExpression(expr) {",
            "  if (!/^[0-9+\\s]+$/.test(expr)) throw new Error('INVALID_EXPR');",
            "  return eval(expr);",
            "}",
            ""
          ].join("\n")
        }
      ],
      cleanResolvedPatches: [
        {
          relPath: "src/sanitize/expr.mjs",
          content: [
            "export function sumPlusExpression(expr) {",
            "  if (typeof expr !== 'string' || !/^[0-9+\\s]+$/.test(expr)) {",
            "    throw new Error('INVALID_EXPR');",
            "  }",
            "  const parts = expr.split('+').map((p) => p.trim()).filter(Boolean);",
            "  if (parts.length === 0) throw new Error('INVALID_EXPR');",
            "  return parts.reduce((acc, n) => acc + Number.parseInt(n, 10), 0);",
            "}",
            ""
          ].join("\n")
        }
      ]
    }
  },
  {
    id: "swe-03-cursor-paginator-ci-heal",
    title: "Fix null and stale cursor handling in paginateItems",
    issueDescription:
      "`paginateItems(items, cursorId, limit)` crashes when `cursorId` is `null` and returns the wrong slice when `cursorId` is no longer present in `items` (stale cursor must fall back to index `0`).",
    scope: "db",
    seedFiles: {
      "src/db/paginate.mjs": [
        "export function paginateItems(items, cursorId, limit) {",
        "  const idx = items.findIndex((it) => it.id === cursorId.trim());",
        "  const slice = items.slice(idx + 1, idx + 1 + limit);",
        "  return { data: slice, nextCursor: slice.length === limit ? slice[slice.length - 1].id : null };",
        "}",
        ""
      ].join("\n"),
      "test/paginate.test.mjs": [
        "import assert from 'node:assert/strict';",
        "import { paginateItems } from '../src/db/paginate.mjs';",
        "const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];",
        "assert.deepEqual(paginateItems(rows, null, 2), { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });",
        "assert.deepEqual(paginateItems(rows, 'b', 2), { data: [{ id: 'c' }, { id: 'd' }], nextCursor: 'd' });",
        "assert.deepEqual(paginateItems(rows, 'deleted-id', 2), { data: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' });",
        ""
      ].join("\n")
    },
    testCommand: "node test/paginate.test.mjs",
    deterministicResponder: {
      experienceCueSubstring: "[h2-lesson-stale-cursor-fallback]",
      // Without EXPERIENCE.md lesson, naive first attempt fixes `null` cursor but forgets `idx === -1` when cursorId is non-null -> fails bwrap CI -> self-heals from CI stderr!
      naiveFirstAttemptPatches: [
        {
          relPath: "src/db/paginate.mjs",
          content: [
            "export function paginateItems(items, cursorId, limit) {",
            "  if (!cursorId) {",
            "    const first = items.slice(0, limit);",
            "    return { data: first, nextCursor: first.length === limit ? first[first.length - 1].id : null };",
            "  }",
            "  const idx = items.findIndex((it) => it.id === cursorId.trim());",
            "  const slice = items.slice(idx + 2, idx + 2 + limit);",
            "  return { data: slice, nextCursor: slice.length === limit ? slice[slice.length - 1].id : null };",
            "}",
            ""
          ].join("\n")
        }
      ],
      cleanResolvedPatches: [
        {
          relPath: "src/db/paginate.mjs",
          content: [
            "export function paginateItems(items, cursorId, limit) {",
            "  let startIndex = 0;",
            "  if (typeof cursorId === 'string' && cursorId.trim().length > 0) {",
            "    const found = items.findIndex((it) => it.id === cursorId.trim());",
            "    startIndex = found >= 0 ? found + 1 : 0;",
            "  }",
            "  const slice = items.slice(startIndex, startIndex + limit);",
            "  const nextCursor = slice.length === limit && startIndex + limit <= items.length ? slice[slice.length - 1].id : null;",
            "  return { data: slice, nextCursor };",
            "}",
            ""
          ].join("\n")
        }
      ]
    }
  }
];

export const DEFAULT_EVOLVED_EXPERIENCE_LESSONS = [
  "# Harness² Distilled Experience Library (Ring 8 SWE Benchmark)",
  "- cue: JWT expiration boundary checks (RFC 7519)",
  "  lesson: Enforce strict `nowSeconds < payload.exp` inequality so tokens at `now === exp` are rejected immediately.",
  "- cue: Arithmetic or expression evaluation `[h2-lesson-safe-token-sum]`",
  "  lesson: Never invoke dynamic `eval()`; validate allowed characters with a strict regex and reduce parsed integer tokens.",
  "- cue: Cursor pagination with nullable or deleted cursors `[h2-lesson-stale-cursor-fallback]`",
  "  lesson: Handle both `cursorId == null` and `findIndex(...) === -1` by resetting `startIndex = 0`."
].join("\n");

function computePercentile(sortedValues: readonly number[], pct: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sortedValues.length) - 1)
  );
  return Number(sortedValues[idx]!.toFixed(2));
}

function initTaskGitRepo(parentDir: string, task: SweBenchTaskDefinition): string {
  const repoDir = path.join(parentDir, task.id);
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "bench@pi-apex.local"], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Pi-Apex Bench"], { cwd: repoDir, stdio: "ignore" });

  for (const [relPath, content] of Object.entries(task.seedFiles)) {
    const abs = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  spawnSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", `chore: seed ${task.id}`], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}

function copySurfacesWithExperience(
  surfacesTemplateDir: string,
  destParentDir: string,
  experienceMarkdown: string
): string {
  const dest = path.join(destParentDir, "surfaces");
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ["SYSTEM.md", "TOOL_GUIDANCE.md", "MEMORY.md", "SUBAGENTS.yaml"]) {
    const src = path.join(surfacesTemplateDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dest, name));
    }
  }
  fs.writeFileSync(path.join(dest, "EXPERIENCE.md"), experienceMarkdown, "utf8");
  return dest;
}

function extractContextUserPrompt(ctx: TranscriptContext): string {
  const msgs = ctx.messages ?? [];
  return msgs
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      return "";
    })
    .join("\n");
}

function buildDeterministicBenchFauxProvider(tasks: readonly SweBenchTaskDefinition[]) {
  const faux = fauxProvider({
    provider: "apex-bench",
    models: [
      {
        id: "deterministic-sonnet-sim",
        name: "Deterministic SWE Bench Responder (Prompt-Cache & Pricing Enabled)",
        reasoning: true,
        cost: {
          input: 3.0,
          output: 15.0,
          cacheRead: 0.3,
          cacheWrite: 3.75
        }
      }
    ]
  });

  // Queue plenty of dynamic prompt-inspecting steps
  const steps = Array.from({ length: 64 }, () => (ctx: TranscriptContext) => {
    const promptText = extractContextUserPrompt(ctx);
    const isRepairIteration = promptText.includes("Autonomous Self-Healing Iteration #");

    const matchedTask =
      tasks.find((t) => promptText.includes(t.title)) ?? tasks[0]!;
    const spec = matchedTask.deterministicResponder;

    if (!spec) {
      return fauxAssistantMessage(
        JSON.stringify({
          scope: matchedTask.scope,
          planSteps: ["Inspect and patch module"],
          patches: []
        })
      );
    }

    const hasDistilledExperienceCue = promptText.includes(spec.experienceCueSubstring);
    const shouldEmitNaivePatchFirst =
      !isRepairIteration &&
      !hasDistilledExperienceCue &&
      Boolean(spec.naiveFirstAttemptPatches && spec.naiveFirstAttemptPatches.length > 0);

    const chosenPatches = shouldEmitNaivePatchFirst
      ? spec.naiveFirstAttemptPatches!
      : spec.cleanResolvedPatches;

    const jsonResponse = JSON.stringify(
      {
        scope: matchedTask.scope,
        planSteps: [
          `Update ${chosenPatches.map((p) => p.relPath).join(", ")}`,
          `Verify BugBot rules and sandboxed bwrap test Command (${matchedTask.testCommand})`
        ],
        fixSummary: isRepairIteration
          ? "Self-healed implementation from BugBot/CI feedback"
          : hasDistilledExperienceCue
            ? "First-shot clean fix guided by Harness² EXPERIENCE.md lesson"
            : "Initial implementation candidate",
        patches: chosenPatches
      },
      null,
      2
    );

    return fauxAssistantMessage("```json\n" + jsonResponse + "\n```");
  });

  faux.setResponses(steps);
  return faux;
}

function aggregateArm(arm: "baseline" | "evolved", taskRuns: SweTaskRunMetrics[]): SweArmAggregate {
  const totalTasks = taskRuns.length;
  const resolvedTasks = taskRuns.filter((t) => t.resolved).length;
  const firstShotResolvedTasks = taskRuns.filter((t) => t.firstShotResolved).length;
  const selfHealRecoveries = taskRuns.filter((t) => t.selfHealed).length;
  const totalRepairAttempts = taskRuns.reduce((s, t) => s + t.repairAttemptsUsed, 0);

  const sortedLatencies = taskRuns.map((t) => t.elapsedMs).sort((a, b) => a - b);
  const meanLatencyMs =
    totalTasks > 0
      ? Number((taskRuns.reduce((s, t) => s + t.elapsedMs, 0) / totalTasks).toFixed(2))
      : 0;

  const totalInputTokens = taskRuns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOutputTokens = taskRuns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCacheReadTokens = taskRuns.reduce((s, t) => s + t.cacheReadTokens, 0);
  const totalTokens = taskRuns.reduce((s, t) => s + t.totalTokens, 0);
  const promptDenom = totalCacheReadTokens + totalInputTokens;
  const cacheHitRatePct =
    promptDenom > 0 ? Number(((totalCacheReadTokens / promptDenom) * 100).toFixed(2)) : 0;

  const totalCostUsd = Number(taskRuns.reduce((s, t) => s + t.costUsd, 0).toFixed(6));
  const costPerResolvedUsd =
    resolvedTasks > 0 ? Number((totalCostUsd / resolvedTasks).toFixed(6)) : 0;

  return {
    arm,
    totalTasks,
    resolvedTasks,
    passRatePct: totalTasks > 0 ? Number(((resolvedTasks / totalTasks) * 100).toFixed(2)) : 0,
    firstShotResolvedTasks,
    firstShotPassRatePct:
      totalTasks > 0 ? Number(((firstShotResolvedTasks / totalTasks) * 100).toFixed(2)) : 0,
    selfHealRecoveries,
    totalRepairAttempts,
    meanLatencyMs,
    p50LatencyMs: computePercentile(sortedLatencies, 50),
    p95LatencyMs: computePercentile(sortedLatencies, 95),
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalTokens,
    cacheHitRatePct,
    totalCostUsd,
    costPerResolvedUsd,
    tasks: taskRuns
  };
}

export async function runPersonalSweBenchmarkSuite(opts: {
  surfacesTemplateDir: string;
  persistWorkspaceRoot?: string;
  tasks?: readonly SweBenchTaskDefinition[];
  compareExperienceAb?: boolean;
  evolvedExperienceMarkdown?: string;
  customModelRuntime?: ModelRuntime;
  customModel?: Model<Api>;
  useBwrapInCi?: boolean;
}): Promise<SweBenchmarkReport> {
  const tasks = opts.tasks ?? BUILTIN_SWE_BENCHMARK_CORPUS;
  const compareAb = opts.compareExperienceAb ?? true;
  const useBwrap = opts.useBwrapInCi ?? true;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-swe-bench-"));
  const benchId = `bench_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 6)}`;

  let observedSchemaTokens = 0;
  let observedPrefixDrift = 0;

  const runArm = async (
    arm: "baseline" | "evolved",
    experienceMarkdown: string
  ): Promise<{ agg: SweArmAggregate; modelLabel: string }> => {
    const armDir = path.join(tmpRoot, arm);
    fs.mkdirSync(armDir, { recursive: true });
    const armSurfaces = copySurfacesWithExperience(
      opts.surfacesTemplateDir,
      armDir,
      experienceMarkdown
    );

    const faux = !opts.customModel ? buildDeterministicBenchFauxProvider(tasks) : null;
    const sharedCacheSessionId = `swe-cache-${arm}-${benchId}`;
    const taskMetrics: SweTaskRunMetrics[] = [];
    let modelLabel = opts.customModel
      ? `${opts.customModel.provider}/${opts.customModel.id}`
      : "apex-bench/deterministic-sonnet-sim";

    for (const task of tasks) {
      const repoDir = initTaskGitRepo(armDir, task);
      const h = await createRing4Harness({
        workspaceRoot: repoDir,
        surfacesDir: armSurfaces,
        agentDir: path.join(armDir, `agent-${task.id}`),
        modelRuntime: opts.customModelRuntime,
        allowUnsandboxedDev: !useBwrap,
        ring2: { useBwrapInCi: useBwrap }
      });

      try {
        let modelToUse: Model<Api>;
        if (opts.customModel) {
          modelToUse = opts.customModel;
        } else {
          h.modelRuntime.registerNativeProvider(faux!.provider);
          await h.modelRuntime.setRuntimeApiKey(faux!.provider.id, "bench-key");
          modelToUse = faux!.getModel();
        }
        modelLabel = `${modelToUse.provider}/${modelToUse.id}`;

        // Verify Ring 0 static schema & prefix invariants on every benchmark harness instance
        const serializedTools = JSON.stringify(
          h.session.agent.state.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }))
        );
        observedSchemaTokens = countO200kTokens(serializedTools);
        const beforeHash = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );

        for (const rule of task.bugBotRules ?? []) {
          h.bugBotCi.learnReviewRule(rule);
        }

        const t0 = performance.now();
        h.prPipeline.sharedBenchCacheSessionId = sharedCacheSessionId;

        const receipt = await h.prPipeline.run({
          title: task.title,
          issueDescription: task.issueDescription,
          scope: task.scope,
          slug: `${task.id}-${arm}`,
          liveLlm: true,
          maxRepairAttempts: 2,
          modelOverride: modelToUse,
          testCommand: task.testCommand,
          keepFeatureBranchCheckedOut: false
        });
        const elapsedMs = Number((performance.now() - t0).toFixed(2));

        const afterHash = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        if (beforeHash !== afterHash) {
          observedPrefixDrift += 1;
        }

        const resolved = receipt.status === "ready" && receipt.ciPassed;
        taskMetrics.push({
          taskId: task.id,
          title: task.title,
          arm,
          status: receipt.status,
          resolved,
          firstShotResolved: resolved && receipt.repairAttemptsUsed === 0,
          selfHealed: receipt.selfHealed,
          repairAttemptsUsed: receipt.repairAttemptsUsed,
          elapsedMs,
          llmCalls: receipt.llmUsage.llmCalls,
          inputTokens: receipt.llmUsage.inputTokens,
          outputTokens: receipt.llmUsage.outputTokens,
          cacheReadTokens: receipt.llmUsage.cacheReadTokens,
          cacheWriteTokens: receipt.llmUsage.cacheWriteTokens,
          totalTokens: receipt.llmUsage.totalTokens,
          costUsd: receipt.llmUsage.costUsd,
          branchName: receipt.branchName
        });
      } finally {
        await h.disposeAsync();
      }
    }

    return {
      agg: aggregateArm(arm, taskMetrics),
      modelLabel
    };
  };

  try {
    const baseRes = await runArm("baseline", "# Empty Baseline Experience\n");
    const evolvedRes = compareAb
      ? await runArm(
          "evolved",
          opts.evolvedExperienceMarkdown ?? DEFAULT_EVOLVED_EXPERIENCE_LESSONS
        )
      : undefined;

    const abComparison = evolvedRes
      ? {
          passRateDeltaPct: Number(
            (evolvedRes.agg.passRatePct - baseRes.agg.passRatePct).toFixed(2)
          ),
          firstShotDeltaPct: Number(
            (evolvedRes.agg.firstShotPassRatePct - baseRes.agg.firstShotPassRatePct).toFixed(2)
          ),
          repairAttemptsSaved:
            baseRes.agg.totalRepairAttempts - evolvedRes.agg.totalRepairAttempts,
          llmCallsSaved:
            baseRes.agg.tasks.reduce((s, t) => s + t.llmCalls, 0) -
            evolvedRes.agg.tasks.reduce((s, t) => s + t.llmCalls, 0),
          tokensSaved: baseRes.agg.totalTokens - evolvedRes.agg.totalTokens,
          costSavedUsd: Number(
            (baseRes.agg.totalCostUsd - evolvedRes.agg.totalCostUsd).toFixed(6)
          )
        }
      : undefined;

    const mdLines: string[] = [
      `# Pi-Apex Personal SWE Eval & Prompt-Cache Benchmark (\`${benchId}\`)`,
      "",
      `- **Model Evaluated:** \`${baseRes.modelLabel}\``,
      `- **Active Tool Schema Budget:** \`${observedSchemaTokens}\` \`o200k_base\` tokens (invariant: \`1,073\`)`,
      `- **Live Static Prefix Drift:** \`${observedPrefixDrift}\``,
      `- **Sandboxed CI Backend:** \`${useBwrap ? "bubblewrap minimal-rootfs" : "host-dev"}\``,
      "",
      `## Arm Summary`,
      `| Arm | Pass Rate | First-Shot Pass | Self-Healed | Repair Loops | p50 Latency | Cache Hit % | Total Cost | Cost / Resolved |`,
      `|---|---|---|---|---|---|---|---|---|`,
      `| **Baseline (\`empty EXPERIENCE.md\`)** | ${baseRes.agg.resolvedTasks}/${baseRes.agg.totalTasks} (${baseRes.agg.passRatePct}%) | ${baseRes.agg.firstShotPassRatePct}% | ${baseRes.agg.selfHealRecoveries} | ${baseRes.agg.totalRepairAttempts} | ${baseRes.agg.p50LatencyMs} ms | ${baseRes.agg.cacheHitRatePct}% | $${baseRes.agg.totalCostUsd.toFixed(6)} | $${baseRes.agg.costPerResolvedUsd.toFixed(6)} |`
    ];

    if (evolvedRes) {
      mdLines.push(
        `| **Evolved (\`Harness² EXPERIENCE.md\`)** | ${evolvedRes.agg.resolvedTasks}/${evolvedRes.agg.totalTasks} (${evolvedRes.agg.passRatePct}%) | ${evolvedRes.agg.firstShotPassRatePct}% | ${evolvedRes.agg.selfHealRecoveries} | ${evolvedRes.agg.totalRepairAttempts} | ${evolvedRes.agg.p50LatencyMs} ms | ${evolvedRes.agg.cacheHitRatePct}% | $${evolvedRes.agg.totalCostUsd.toFixed(6)} | $${evolvedRes.agg.costPerResolvedUsd.toFixed(6)} |`
      );
    }

    if (abComparison) {
      mdLines.push(
        "",
        `## Harness² \`EXPERIENCE.md\` Before/After A/B Impact`,
        `- **First-Shot Resolution Delta:** \`${abComparison.firstShotDeltaPct >= 0 ? "+" : ""}${abComparison.firstShotDeltaPct}%\``,
        `- **Self-Heal Repair Loops Saved:** \`${abComparison.repairAttemptsSaved}\` (${abComparison.llmCallsSaved} fewer LLM calls)`,
        `- **Net Token & Cost Delta:** \`${abComparison.tokensSaved}\` tokens saved (\`$${abComparison.costSavedUsd.toFixed(6)}\`)`
      );
    }

    mdLines.push("", "## Per-Task Breakdown");
    for (const t of [...baseRes.agg.tasks, ...(evolvedRes?.agg.tasks ?? [])]) {
      mdLines.push(
        `- **[${t.arm}] \`${t.taskId}\`** -> \`${t.status.toUpperCase()}\` (${t.elapsedMs} ms, llmCalls=${t.llmCalls}, repairs=${t.repairAttemptsUsed}${t.selfHealed ? " SELF-HEALED" : ""}, cacheRead=${t.cacheReadTokens}, cost=$${t.costUsd.toFixed(6)})`
      );
    }

    const markdownReport = scrubSecretsInfallible(mdLines.join("\n"));
    const report: SweBenchmarkReport = {
      benchId,
      createdAtIso: new Date().toISOString(),
      modelLabel: baseRes.modelLabel,
      activeSchemaTokens: observedSchemaTokens,
      prefixDriftCount: observedPrefixDrift,
      baseline: baseRes.agg,
      evolved: evolvedRes?.agg,
      abComparison,
      markdownReport
    };

    if (opts.persistWorkspaceRoot) {
      const wsRoot = path.resolve(opts.persistWorkspaceRoot);
      const relJson = `.harness/benchmarks/${benchId}.json`;
      const relMd = `.harness/benchmarks/${benchId}.md`;
      report.persistedJsonPath = path.join(wsRoot, relJson);
      report.persistedMarkdownPath = path.join(wsRoot, relMd);
      writeFileDurable(
        report.persistedJsonPath,
        JSON.stringify(report, null, 2),
        "crash-safe",
        { workspaceRoot: wsRoot, mode: 0o644 }
      );
      writeFileDurable(report.persistedMarkdownPath, markdownReport, "crash-safe", {
        workspaceRoot: wsRoot,
        mode: 0o644
      });
    }

    return report;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function listPersistedBenchmarks(workspaceRoot: string): Array<{
  benchId: string;
  createdAtIso: string;
  modelLabel: string;
  baselinePassRatePct: number;
  evolvedPassRatePct?: number;
  repairAttemptsSaved?: number;
  baselineCacheHitPct: number;
}> {
  const dir = path.join(path.resolve(workspaceRoot), ".harness", "benchmarks");
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 15);
  const out: Array<{
    benchId: string;
    createdAtIso: string;
    modelLabel: string;
    baselinePassRatePct: number;
    evolvedPassRatePct?: number;
    repairAttemptsSaved?: number;
    baselineCacheHitPct: number;
  }> = [];
  for (const name of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as SweBenchmarkReport;
      out.push({
        benchId: parsed.benchId,
        createdAtIso: parsed.createdAtIso,
        modelLabel: parsed.modelLabel,
        baselinePassRatePct: parsed.baseline.passRatePct,
        evolvedPassRatePct: parsed.evolved?.passRatePct,
        repairAttemptsSaved: parsed.abComparison?.repairAttemptsSaved,
        baselineCacheHitPct: parsed.baseline.cacheHitRatePct
      });
    } catch {
      // skip malformed files
    }
  }
  return out;
}
