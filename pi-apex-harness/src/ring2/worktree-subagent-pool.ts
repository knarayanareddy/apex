/**
 * Ring 2 — 5-Role 1-Level Disjoint `git worktree` Subagent Pool
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/subagent/index.ts`
 *    & `examples/extensions/subagent/agents.ts` (MIT License, Earendil Works):
 *    - `mapWithConcurrencyLimit`, `parseToolList`, `discoverProjectAgentConfigs`,
 *      `getFinalOutput`, `truncateParallelOutput`, and single / parallel / chain (`{previous}`)
 *      delegation modes.
 * 2. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/git-merge-and-resolve.ts`
 *    (MIT License, Earendil Works):
 *    - `ConflictBlock`, `findConflictsInText`, `formatConflicts` (`<<<<<<<` / `=======` / `>>>>>>>`).
 * 3. `anomalyco/opencode` @ `7c16f4ac3ea5` — `packages/core/src/git.ts` (lines 1296-1363)
 *    & `packages/core/src/worktree.ts` (MIT License, Anomaly / OpenCode):
 *    - `gitWorktreeCreate` (`git worktree add --detach -- <directory> <ref>`),
 *      `gitWorktreeRemove` (`git worktree remove [--force] <directory>`),
 *      `gitWorktreeList` (`git worktree list --porcelain`), `forceRequired` dirty detection,
 *      PLUS the fix from OpenCode Issue #14648 / PR #14649 (`cleanupWorktreeGuaranteed` +
 *      `git worktree prune` in `finally` so failed/aborted workers never leak orphaned worktrees).
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
  parseFrontmatter,
  type ExtensionFactory,
  type ModelRuntime
} from "@earendil-works/pi-coding-agent";
import type { DurabilityMode, SandboxMode } from "../types.ts";
import { GuardDeniedError } from "../core/monotonic-guard.ts";
import {
  readWorkspaceFileSafe,
  unlinkSafeBeneathWorkspace
} from "../core/safe-path.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import { createRing1Harness } from "../ring1/ring1-extension.ts";

export type SubagentRole = "explore" | "plan" | "execute" | "verify" | "review";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface RolePolicy {
  role: SubagentRole;
  allowedBuiltInTools: string[];
  readOnly: boolean;
  requiresIsolatedWorktree: boolean;
  requiresOwnedPaths: boolean;
  defaultSystemGuidance: string;
}

export const FIVE_ROLE_POLICIES: Record<SubagentRole, RolePolicy> = {
  explore: {
    role: "explore",
    allowedBuiltInTools: ["read"],
    readOnly: true,
    requiresIsolatedWorktree: false,
    requiresOwnedPaths: false,
    defaultSystemGuidance:
      "Role: EXPLORE (read-only). Map symbols, files, and call paths concisely. Do not mutate files."
  },
  plan: {
    role: "plan",
    allowedBuiltInTools: ["read"],
    readOnly: true,
    requiresIsolatedWorktree: false,
    requiresOwnedPaths: false,
    defaultSystemGuidance:
      "Role: PLAN (read-only). Produce a concrete numbered Plan: with target file paths and verification criteria."
  },
  execute: {
    role: "execute",
    allowedBuiltInTools: ["read", "write", "edit", "bash"],
    readOnly: false,
    requiresIsolatedWorktree: true,
    requiresOwnedPaths: true,
    defaultSystemGuidance:
      "Role: EXECUTE (isolated git worktree). Modify ONLY files matching your assigned ownedPaths."
  },
  verify: {
    role: "verify",
    allowedBuiltInTools: ["read", "bash"],
    readOnly: true,
    requiresIsolatedWorktree: true,
    requiresOwnedPaths: false,
    defaultSystemGuidance:
      "Role: VERIFY (isolated git worktree). Run test/lint verification commands and report exact exit codes and diagnostics."
  },
  review: {
    role: "review",
    allowedBuiltInTools: ["read"],
    readOnly: true,
    requiresIsolatedWorktree: false,
    requiresOwnedPaths: false,
    defaultSystemGuidance:
      "Role: REVIEW (read-only). Audit diffs for discrete, actionable bugs and security regressions."
  }
};

// ============================================================================
// Upstream `@earendil-works/pi-coding-agent` (`subagent/index.ts` & `agents.ts`)
// ============================================================================

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const texts: string[] = [];
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) {
          texts.push(part.text);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }
  }
  return "";
}

export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

export interface DiscoveredAgentProfile {
  name: string;
  role: SubagentRole;
  description: string;
  tools?: string[];
  systemPrompt: string;
  relPath: string;
}

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

export function discoverProjectAgentProfiles(workspaceRoot: string): DiscoveredAgentProfile[] {
  const profiles: DiscoveredAgentProfile[] = [];
  for (const relDir of [".pi/agents", ".agents/subagents"]) {
    const absDir = path.join(workspaceRoot, relDir);
    if (!fs.existsSync(absDir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const relPath = path.posix.join(relDir, entry.name);
      try {
        const rawBuf = readWorkspaceFileSafe({
          workspaceRoot,
          candidatePath: relPath
        });
        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
          rawBuf.toString("utf8")
        );
        const roleRaw = typeof frontmatter.role === "string" ? frontmatter.role : "explore";
        const role: SubagentRole =
          roleRaw in FIVE_ROLE_POLICIES ? (roleRaw as SubagentRole) : "explore";
        if (typeof frontmatter.name === "string" && typeof frontmatter.description === "string") {
          profiles.push({
            name: frontmatter.name,
            role,
            description: frontmatter.description,
            tools: parseToolList(frontmatter.tools),
            systemPrompt: body.trim(),
            relPath
          });
        }
      } catch {
        continue;
      }
    }
  }
  return profiles;
}

// ============================================================================
// Upstream `@earendil-works/pi-coding-agent` (`git-merge-and-resolve.ts`)
// ============================================================================

export interface ConflictBlock {
  file: string;
  startLine: number;
  separatorLine: number;
  endLine: number;
}

export function findConflictsInText(file: string, content: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  const lines = content.split("\n");
  let blockStart: number | undefined;
  let separatorLine: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (line.startsWith("<<<<<<<")) {
      blockStart = lineNo;
      separatorLine = undefined;
    } else if (line.startsWith("=======") && blockStart !== undefined) {
      separatorLine = lineNo;
    } else if (line.startsWith(">>>>>>>") && blockStart !== undefined && separatorLine !== undefined) {
      blocks.push({ file, startLine: blockStart, separatorLine, endLine: lineNo });
      blockStart = undefined;
      separatorLine = undefined;
    }
  }
  return blocks;
}

export function formatConflicts(ref: string, blocks: ConflictBlock[]): string {
  const formatRange = (start: number, end: number) =>
    start > end ? "empty" : start === end ? `${start}` : `${start}-${end}`;
  const lines = [`Merged ${ref} with conflicts:`, ""];
  for (const b of blocks) {
    const ours = formatRange(b.startLine + 1, b.separatorLine - 1);
    const theirs = formatRange(b.separatorLine + 1, b.endLine - 1);
    lines.push(`  ${b.file}:${b.startLine}-${b.endLine} (ours ${ours}, theirs ${theirs})`);
  }
  return lines.join("\n");
}

// ============================================================================
// Upstream `anomalyco/opencode` (`packages/core/src/git.ts` + PR #14649 fix)
// ============================================================================

export interface LinkedWorktreeEntry {
  directory: string;
  kind: "main" | "linked";
}

function runGitChecked(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? ""
  };
}

export function gitWorktreeList(repoRoot: string): LinkedWorktreeEntry[] {
  const out = runGitChecked(repoRoot, ["worktree", "list", "--porcelain"]);
  if (out.exitCode !== 0) {
    throw new Error(`GIT_WORKTREE_LIST_FAILED: ${out.stderr.trim() || out.stdout.trim()}`);
  }
  return out.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line, index) => ({
      directory: path.resolve(repoRoot, line.slice("worktree ".length).trim()),
      kind: index === 0 ? "main" : "linked"
    }));
}

export function gitWorktreeCreateDetached(params: {
  repoRoot: string;
  worktreeDir: string;
  ref?: string;
}): string {
  const targetDir = path.resolve(params.worktreeDir);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
  const out = runGitChecked(params.repoRoot, [
    "worktree",
    "add",
    "--detach",
    "--",
    targetDir,
    params.ref ?? "HEAD"
  ]);
  if (out.exitCode !== 0) {
    // OpenCode PR #14649 fix: never leave partial directory or unpruned git worktree entry behind!
    cleanupWorktreeGuaranteed(params.repoRoot, targetDir);
    throw new Error(
      `GIT_WORKTREE_CREATE_FAILED (${targetDir}): ${out.stderr.trim() || out.stdout.trim()}`
    );
  }
  return fs.realpathSync(targetDir);
}

export function cleanupWorktreeGuaranteed(repoRoot: string, worktreeDir: string): void {
  const targetDir = path.resolve(worktreeDir);
  runGitChecked(repoRoot, ["worktree", "remove", "--force", targetDir]);
  try {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort filesystem cleanup before git worktree prune
  }
  runGitChecked(repoRoot, ["worktree", "prune"]);
}

// ============================================================================
// Disjoint `ownedPaths` Matcher & Parallel Overlap Validator
// ============================================================================

function normalizeOwnedPrefix(pattern: string): string {
  const posix = pattern.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!posix || posix === "." || posix === "**" || posix === "*") {
    return "";
  }
  return posix.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
}

export function pathMatchesOwnedPatterns(relPosixPath: string, ownedPaths: string[]): boolean {
  const cleanRel = relPosixPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  for (const rawPat of ownedPaths) {
    const prefix = normalizeOwnedPrefix(rawPat);
    if (prefix === "") return true;
    if (cleanRel === prefix || cleanRel.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function patternsCanOverlap(patA: string, patB: string): boolean {
  const a = normalizeOwnedPrefix(patA);
  const b = normalizeOwnedPrefix(patB);
  if (a === "" || b === "") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function assertDisjointOwnedPaths(
  tasks: ReadonlyArray<{ id?: string; role: SubagentRole; ownedPaths?: string[] }>
): void {
  const execTasks = tasks.filter((t) => t.role === "execute");
  for (let i = 0; i < execTasks.length; i++) {
    const ti = execTasks[i];
    if (!ti.ownedPaths || ti.ownedPaths.length === 0) {
      throw new Error(
        `MISSING_OWNED_PATHS: 'execute' subagent task #${i + 1} MUST declare non-empty ownedPaths.`
      );
    }
    for (let j = i + 1; j < execTasks.length; j++) {
      const tj = execTasks[j];
      if (!tj.ownedPaths || tj.ownedPaths.length === 0) {
        throw new Error(
          `MISSING_OWNED_PATHS: 'execute' subagent task #${j + 1} MUST declare non-empty ownedPaths.`
        );
      }
      for (const pa of ti.ownedPaths) {
        for (const pb of tj.ownedPaths) {
          if (patternsCanOverlap(pa, pb)) {
            throw new Error(
              `OVERLAPPING_OWNED_PATHS: parallel execute tasks #${i + 1} ('${pa}') and #${j + 1} ('${pb}') overlap. Partition ownedPaths disjointly.`
            );
          }
        }
      }
    }
  }
}

// ============================================================================
// Subagent Pool Executor (Depth-1 Hard Cap +Shared Host `ModelRuntime`)
// ============================================================================

export interface SubagentTaskSpec {
  role: SubagentRole;
  task: string;
  ownedPaths?: string[];
  applyChangesToWorkspace?: boolean;
}

export interface SubagentSingleResult {
  role: SubagentRole;
  task: string;
  output: string;
  turns: number;
  usedIsolatedWorktree: boolean;
  harvestedFiles: string[];
  deletedFiles: string[];
  appliedToWorkspace: boolean;
  exitStatus: "ok" | "error";
  errorMessage?: string;
}

export interface SubagentDispatchResult {
  mode: "single" | "parallel" | "chain";
  depth: number;
  results: SubagentSingleResult[];
}

export class WorktreeSubagentPool {
  private readonly workspaceRoot: string;
  private readonly surfacesDir: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly model: Model<Api>;
  private readonly currentDepth: number;
  private readonly worktreeBaseDir: string;
  private readonly childSandboxMode: SandboxMode;
  private readonly childAllowUnsandboxedDev: boolean;
  private readonly durabilityMode: DurabilityMode;

  constructor(opts: {
    workspaceRoot: string;
    surfacesDir: string;
    modelRuntime: ModelRuntime;
    model: Model<Api>;
    currentDepth?: number;
    worktreeBaseDir?: string;
    childSandboxMode?: SandboxMode;
    childAllowUnsandboxedDev?: boolean;
    durabilityMode?: DurabilityMode;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.surfacesDir = path.resolve(opts.surfacesDir);
    this.modelRuntime = opts.modelRuntime;
    this.model = opts.model;
    this.currentDepth = opts.currentDepth ?? 0;
    this.childSandboxMode = opts.childSandboxMode ?? "workspace-write";
    this.childAllowUnsandboxedDev = opts.childAllowUnsandboxedDev ?? true;
    this.durabilityMode = opts.durabilityMode ?? "crash-safe";
    this.worktreeBaseDir =
      opts.worktreeBaseDir ??
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-wtpool-"));
  }

  public getDepth(): number {
    return this.currentDepth;
  }

  public async dispatch(input: {
    mode?: "single" | "parallel" | "chain";
    role?: SubagentRole;
    task?: string;
    ownedPaths?: string[];
    applyChangesToWorkspace?: boolean;
    tasks?: SubagentTaskSpec[];
    chain?: SubagentTaskSpec[];
  }): Promise<SubagentDispatchResult> {
    // Hard Depth-1 Non-Recursive Cap (`SPEC_BIBLE.md` Ring 2 Invariant)
    if (this.currentDepth >= 1) {
      throw new Error(
        `MAX_SUBAGENT_DEPTH_EXCEEDED: subagents at depth=${this.currentDepth} cannot recursively spawn child subagents (max depth = 1).`
      );
    }

    if (input.chain && input.chain.length > 0) {
      const results: SubagentSingleResult[] = [];
      let previousOutput = "";
      for (const item of input.chain) {
        if (item.role === "execute" && (!item.ownedPaths || item.ownedPaths.length === 0)) {
          throw new Error(`MISSING_OWNED_PATHS: chain execute step requires non-empty ownedPaths.`);
        }
        const hydratedTask = item.task.replace(/\{previous\}/g, previousOutput);
        const stepRes = await this.runSingleWorker({
          ...item,
          task: hydratedTask
        });
        results.push(stepRes);
        if (stepRes.exitStatus === "error") break;
        previousOutput = stepRes.output;
      }
      return { mode: "chain", depth: 1, results };
    }

    if (input.tasks && input.tasks.length > 0) {
      if (input.tasks.length > MAX_PARALLEL_TASKS) {
        throw new Error(`TOO_MANY_SUBAGENT_TASKS: max parallel tasks is ${MAX_PARALLEL_TASKS}.`);
      }
      // Validate disjoint `ownedPaths` BEFORE spawning a single worktree!
      assertDisjointOwnedPaths(input.tasks);

      const results = await mapWithConcurrencyLimit(
        input.tasks,
        MAX_CONCURRENCY,
        async (spec) => await this.runSingleWorker(spec)
      );
      return { mode: "parallel", depth: 1, results };
    }

    if (!input.role || !input.task) {
      throw new Error(`INVALID_SUBAGENT_DISPATCH: provide either (role + task), tasks[], or chain[].`);
    }
    if (input.role === "execute" && (!input.ownedPaths || input.ownedPaths.length === 0)) {
      throw new Error(`MISSING_OWNED_PATHS: 'execute' subagent requires non-empty ownedPaths.`);
    }

    const single = await this.runSingleWorker({
      role: input.role,
      task: input.task,
      ownedPaths: input.ownedPaths,
      applyChangesToWorkspace: input.applyChangesToWorkspace
    });
    return { mode: "single", depth: 1, results: [single] };
  }

  private async runSingleWorker(spec: SubagentTaskSpec): Promise<SubagentSingleResult> {
    const policy = FIVE_ROLE_POLICIES[spec.role];
    if (!policy) {
      throw new Error(`UNKNOWN_SUBAGENT_ROLE: ${String(spec.role)}`);
    }

    const hasGitRepo =
      runGitChecked(this.workspaceRoot, ["rev-parse", "--verify", "HEAD"]).exitCode === 0;
    if (spec.role === "execute" && !hasGitRepo) {
      throw new Error(
        `GIT_HEAD_REQUIRED: 'execute' subagents require a committed Git HEAD to allocate an isolated git worktree.`
      );
    }

    const runSlug = `${spec.role}-${crypto.randomUUID().slice(0, 8)}`;
    const useWorktree = hasGitRepo;
    let isolatedFallbackDir: string | null = null;
    const worktreeDir = useWorktree
      ? gitWorktreeCreateDetached({
          repoRoot: this.workspaceRoot,
          worktreeDir: path.join(this.worktreeBaseDir, runSlug),
          ref: "HEAD"
        })
      : (() => {
          isolatedFallbackDir = path.join(this.worktreeBaseDir, `snap-${runSlug}`);
          fs.mkdirSync(isolatedFallbackDir, { recursive: true, mode: 0o700 });
          return isolatedFallbackDir;
        })();

    const allowedSet = new Set([
      ...policy.allowedBuiltInTools,
      "codemode",
      "tool_search",
      "repo_map",
      "lsp_query"
    ]);

    const roleGateExtension: ExtensionFactory = (pi) => {
      pi.on("tool_call", async (event) => {
        if (!allowedSet.has(event.toolName)) {
          return {
            block: true,
            reason: `SUBAGENT_ROLE_DENIED: tool '${event.toolName}' is forbidden for subagent role '${spec.role}'.`
          };
        }
        return undefined;
      });
    };

    // Child session is a Ring 1 harness (`createRing1Harness`), so it NEVER has `subagent_dispatch`
    // registered — enforcing the 1-level cap structurally as well as at runtime!
    let childHarness: Awaited<ReturnType<typeof createRing1Harness>> | null = null;
    try {
      childHarness = await createRing1Harness({
        workspaceRoot: worktreeDir,
        surfacesDir: this.surfacesDir,
        sandboxMode: policy.readOnly ? "read-only" : this.childSandboxMode,
        allowUnsandboxedDev: this.childAllowUnsandboxedDev,
        durabilityMode: this.durabilityMode,
        modelRuntime: this.modelRuntime,
        model: this.model,
        extraExtensions: [roleGateExtension]
      });

      const origPrompt = [
        `<subagent-contract role="${spec.role}" depth="1" read_only="${policy.readOnly}">`,
        policy.defaultSystemGuidance,
        spec.ownedPaths && spec.ownedPaths.length > 0
          ? `Assigned ownedPaths (exclusive write boundary): ${spec.ownedPaths.join(", ")}`
          : `Write boundary: NONE (strictly read-only).`,
        `</subagent-contract>`,
        spec.task
      ].join("\n");

      await childHarness.session.prompt(origPrompt);

      const messages = childHarness.session.messages as Message[];
      const turns = messages.filter((m) => m.role === "assistant").length;
      const rawOut = truncateParallelOutput(getFinalOutput(messages));

      const harvestedFiles: string[] = [];
      const deletedFiles: string[] = [];
      let appliedToWorkspace = false;

      if (useWorktree && spec.role === "execute") {
        const harvest = this.harvestWorktreeMutations(
          worktreeDir,
          spec.ownedPaths ?? [],
          spec.applyChangesToWorkspace !== false
        );
        harvestedFiles.push(...harvest.modifiedOrAdded);
        deletedFiles.push(...harvest.deleted);
        appliedToWorkspace = harvest.applied;
      }

      return {
        role: spec.role,
        task: spec.task,
        output: rawOut,
        turns,
        usedIsolatedWorktree: useWorktree,
        harvestedFiles,
        deletedFiles,
        appliedToWorkspace,
        exitStatus: "ok"
      };
    } catch (err) {
      return {
        role: spec.role,
        task: spec.task,
        output: "",
        turns: 0,
        usedIsolatedWorktree: useWorktree,
        harvestedFiles: [],
        deletedFiles: [],
        appliedToWorkspace: false,
        exitStatus: "error",
        errorMessage: (err as Error).message
      };
    } finally {
      if (childHarness) {
        await childHarness.disposeAsync();
      }
      if (useWorktree) {
        cleanupWorktreeGuaranteed(this.workspaceRoot, worktreeDir);
      } else if (isolatedFallbackDir && fs.existsSync(isolatedFallbackDir)) {
        fs.rmSync(isolatedFallbackDir, { recursive: true, force: true });
      }
    }
  }

  private harvestWorktreeMutations(
    worktreeDir: string,
    ownedPaths: string[],
    applyToRoot: boolean
  ): { modifiedOrAdded: string[]; deleted: string[]; applied: boolean } {
    const status = runGitChecked(worktreeDir, ["status", "--porcelain", "-uall"]);
    if (status.exitCode !== 0) {
      throw new Error(`WORKTREE_STATUS_FAILED: ${status.stderr.trim()}`);
    }

    const modifiedOrAdded: string[] = [];
    const deleted: string[] = [];

    for (const rawLine of status.stdout.split("\n")) {
      if (!rawLine || rawLine.length < 4) continue;
      const xy = rawLine.slice(0, 2);
      const rawRel = rawLine.slice(3).trim();
      const relPaths = rawRel.includes(" -> ")
        ? rawRel.split(" -> ").map((s) => s.trim())
        : [rawRel];

      for (const rel of relPaths) {
        const posixRel = rel.replace(/^"+|"+$/g, "").replace(/\\/g, "/");
        if (posixRel === ".harness" || posixRel.startsWith(".harness/")) {
          continue;
        }
        if (!pathMatchesOwnedPatterns(posixRel, ownedPaths)) {
          throw new Error(
            `UNOWNED_PATH_MUTATION: execute subagent modified '${posixRel}' outside assigned ownedPaths [${ownedPaths.join(", ")}].`
          );
        }
      }

      const finalRel = relPaths[relPaths.length - 1].replace(/^"+|"+$/g, "").replace(/\\/g, "/");
      if (finalRel === ".harness" || finalRel.startsWith(".harness/")) continue;

      if (xy.includes("D")) {
        deleted.push(finalRel);
      } else {
        // Check for unresolved Git merge conflict markers (`git-merge-and-resolve.ts`)
        const rawBuf = readWorkspaceFileSafe({
          workspaceRoot: worktreeDir,
          candidatePath: finalRel
        });
        const conflicts = findConflictsInText(finalRel, rawBuf.toString("utf8"));
        if (conflicts.length > 0) {
          throw new Error(
            `WORKTREE_CONFLICT_MARKERS: ${formatConflicts("HEAD", conflicts)}`
          );
        }
        modifiedOrAdded.push(finalRel);
      }
    }

    if (applyToRoot) {
      if (this.childSandboxMode === "read-only") {
        throw new GuardDeniedError("Cannot apply subagent changes to workspace in read-only sandbox mode");
      }
      for (const delRel of deleted) {
        unlinkSafeBeneathWorkspace({ workspaceRoot: this.workspaceRoot, relPath: delRel });
      }
      for (const modRel of modifiedOrAdded) {
        const rawBuf = readWorkspaceFileSafe({
          workspaceRoot: worktreeDir,
          candidatePath: modRel
        });
        const st = fs.lstatSync(path.join(worktreeDir, modRel));
        writeFileDurable(path.join(this.workspaceRoot, modRel), rawBuf, this.durabilityMode, {
          workspaceRoot: this.workspaceRoot,
          mode: st.mode & 0o777
        });
      }
    }

    return { modifiedOrAdded, deleted, applied: applyToRoot };
  }

  public dispose(): void {
    try {
      if (fs.existsSync(this.worktreeBaseDir)) {
        fs.rmSync(this.worktreeBaseDir, { recursive: true, force: true });
      }
      runGitChecked(this.workspaceRoot, ["worktree", "prune"]);
    } catch {
      // Ignore cleanup errors on dispose
    }
  }
}
