import path from "node:path";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadVerifiedGuardrails } from "../core/guardrail-pin.ts";
import type { Ring0HarnessOptions } from "../core/ring0-session.ts";
import {
  createRing1Harness,
  type Ring1HarnessInstance,
  type Ring1Options
} from "../ring1/ring1-extension.ts";
import { AgentBrowserController } from "./agent-browser-ref.ts";
import { BugBotAndCiEngine, type ReviewTarget } from "./bugbot-ci-loop.ts";
import { TrustArtifactController, type TrustArtifactKind } from "./plan-trust-artifacts.ts";
import { PtyLeaseManager, UnattendedCronScheduler } from "./pty-cron-routines.ts";
import { WorktreeSubagentPool, type SubagentRole } from "./worktree-subagent-pool.ts";

export interface Ring2Options {
  initialPlanMode?: boolean;
  subagentDepth?: number;
  worktreeBaseDir?: string;
  useBwrapInCi?: boolean;
}

export interface Ring2HarnessInstance extends Ring1HarnessInstance {
  readonly trustArtifacts: TrustArtifactController;
  readonly subagentPool: WorktreeSubagentPool;
  readonly bugBotCi: BugBotAndCiEngine;
  readonly browserController: AgentBrowserController;
  readonly ptyManager: PtyLeaseManager;
  readonly cronScheduler: UnattendedCronScheduler;
  disposeAsync(): Promise<void>;
}

/**
 * Builds the `Ring 2` Extension Pack (`Invariant I-01`, `I-02`, `I-03`, `I-08`):
 *  1. Interactive Planning (`plan-mode/utils.ts` + `index.ts` from `@earendil-works/pi-coding-agent`),
 *     Structured Trust Artifacts (`plan` / `diff` / `verification`), & Inline Comment `steer()`
 *  2. 5-Role 1-Level Disjoint `git worktree` Subagent Pool (`explore`, `plan`, `execute`, `verify`, `review`
 *     adapted from Pi `subagent` + `git-merge-and-resolve` + OpenCode `git.worktree` + PR #14649 fix)
 *  3. Cursor BugBot `REVIEW_RULES.md` + OpenAI Codex `ReviewOutputEvent` (with Issues #8404/#17160 fix)
 *     + Automated CI/Test Verification Loop
 *  4. Vercel `agent-browser` `@e1` ARIA Accessibility-Ref Snapshotter (with Issues #1443/#2147 fixes)
 *     + Multimodal `ImageContent` PNG Screenshot Controller
 *  5. OpenCode 2 MiB Cursor PTY Leases + Nous Hermes `MAX_PROCESSES`/Watch-Breaker & `DENY_UNATTENDED` Cron Routines
 *
 * All 6 Ring 2 tools are registered with `exposure: "deferred"` (`+0` active schema tokens!).
 */
export async function createRing2Harness(
  opts: Ring0HarnessOptions & { ring1?: Ring1Options; ring2?: Ring2Options }
): Promise<Ring2HarnessInstance> {
  const { config: guardrails } = loadVerifiedGuardrails(
    opts.guardrailsPath,
    opts.expectedGuardrailsSha256
  );

  let trustArtifactsRef: TrustArtifactController | null = null;
  let subagentPoolRef: WorktreeSubagentPool | null = null;
  let bugBotCiRef: BugBotAndCiEngine | null = null;
  let cronSchedulerRef: UnattendedCronScheduler | null = null;

  const browserController = new AgentBrowserController({
    workspaceRoot: opts.workspaceRoot
  });
  const ptyManager = new PtyLeaseManager({
    workspaceRoot: opts.workspaceRoot,
    guardrails
  });

  const SubagentTaskSchema = Type.Object({
    role: Type.Union([
      Type.Literal("explore"),
      Type.Literal("plan"),
      Type.Literal("execute"),
      Type.Literal("verify"),
      Type.Literal("review")
    ]),
    task: Type.String(),
    ownedPaths: Type.Optional(Type.Array(Type.String())),
    applyChangesToWorkspace: Type.Optional(Type.Boolean())
  });

  const ring2Extension: ExtensionFactory = (pi) => {
    // 1. `trust_artifact` (`exposure: "deferred"` -> +0 active schema tokens)
    pi.registerTool({
      name: "trust_artifact",
      label: "Trust Artifacts & Plan Mode",
      description:
        "Creates, updates, approves, or lists structured Trust Artifacts (plan, diff, verification) and toggles read-only Plan Mode.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("propose_plan"),
          Type.Literal("record_diff"),
          Type.Literal("record_verification"),
          Type.Literal("approve_plan"),
          Type.Literal("set_plan_mode"),
          Type.Literal("list")
        ]),
        artifactId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        markdown: Type.Optional(Type.String()),
        kind: Type.Optional(
          Type.Union([Type.Literal("plan"), Type.Literal("diff"), Type.Literal("verification")])
        ),
        enabled: Type.Optional(Type.Boolean())
      }),
      exposure: "deferred",
      async execute(_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
        if (!trustArtifactsRef) throw new Error("TrustArtifactController not initialized");
        switch (params.action) {
          case "propose_plan":
          case "record_diff":
          case "record_verification": {
            const kind: TrustArtifactKind =
              params.action === "propose_plan"
                ? "plan"
                : params.action === "record_diff"
                  ? "diff"
                  : "verification";
            const art = trustArtifactsRef.createOrUpdateArtifact({
              artifactId: params.artifactId,
              kind,
              title: params.title ?? `${kind.toUpperCase()} Artifact`,
              markdown: params.markdown ?? ""
            });
            return {
              content: [{ type: "text", text: JSON.stringify(art, null, 2) }],
              details: art
            };
          }
          case "approve_plan": {
            if (!params.artifactId) throw new Error("artifactId required for approve_plan");
            const art = trustArtifactsRef.approvePlanArtifact(params.artifactId, true);
            return {
              content: [{ type: "text", text: JSON.stringify(art, null, 2) }],
              details: art
            };
          }
          case "set_plan_mode": {
            trustArtifactsRef.setPlanMode(Boolean(params.enabled));
            const out = { planModeActive: trustArtifactsRef.isPlanModeActive() };
            return {
              content: [{ type: "text", text: JSON.stringify(out) }],
              details: out
            };
          }
          case "list": {
            const list = trustArtifactsRef.listArtifacts(params.kind);
            return {
              content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
              details: { count: list.length, artifacts: list }
            };
          }
        }
      }
    });

    // 2. `subagent_dispatch` (`exposure: "deferred"` -> +0 active schema tokens)
    pi.registerTool({
      name: "subagent_dispatch",
      label: "5-Role Disjoint Worktree Subagent Pool",
      description:
        "Delegates tasks to depth-1 subagents (explore, plan, execute, verify, review) in single, parallel (disjoint ownedPaths), or chain ({previous}) mode.",
      parameters: Type.Object({
        role: Type.Optional(
          Type.Union([
            Type.Literal("explore"),
            Type.Literal("plan"),
            Type.Literal("execute"),
            Type.Literal("verify"),
            Type.Literal("review")
          ])
        ),
        task: Type.Optional(Type.String()),
        ownedPaths: Type.Optional(Type.Array(Type.String())),
        applyChangesToWorkspace: Type.Optional(Type.Boolean()),
        tasks: Type.Optional(Type.Array(SubagentTaskSchema)),
        chain: Type.Optional(Type.Array(SubagentTaskSchema))
      }),
      exposure: "deferred",
      async execute(_id, params) {
        if (!subagentPoolRef) throw new Error("WorktreeSubagentPool not initialized");
        const out = await subagentPoolRef.dispatch({
          role: params.role as SubagentRole | undefined,
          task: params.task,
          ownedPaths: params.ownedPaths,
          applyChangesToWorkspace: params.applyChangesToWorkspace,
          tasks: params.tasks,
          chain: params.chain
        });
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          details: out
        };
      }
    });

    // 3. `code_review_ci` (`exposure: "deferred"` -> +0 active schema tokens)
    pi.registerTool({
      name: "code_review_ci",
      label: "BugBot Learned PR Review & CI Verification Loop",
      description:
        "Runs REVIEW_RULES.md learned diff review (uncommittedChanges, baseBranch via merge-base...HEAD, commit) or bounded CI test verification loops.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("review"),
          Type.Literal("learn_rule"),
          Type.Literal("suppress_false_positive"),
          Type.Literal("run_ci_loop")
        ]),
        targetType: Type.Optional(
          Type.Union([
            Type.Literal("uncommittedChanges"),
            Type.Literal("baseBranch"),
            Type.Literal("commit")
          ])
        ),
        branch: Type.Optional(Type.String()),
        sha: Type.Optional(Type.String()),
        ruleId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
        forbiddenPattern: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Number()),
        relPath: Type.Optional(Type.String()),
        lineSnippet: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        maxAttempts: Type.Optional(Type.Number({ minimum: 1, maximum: 5 }))
      }),
      exposure: "deferred",
      async execute(_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
        if (!bugBotCiRef) throw new Error("BugBotAndCiEngine not initialized");
        switch (params.action) {
          case "review": {
            let target: ReviewTarget = { type: "uncommittedChanges" };
            if (params.targetType === "baseBranch") {
              if (!params.branch) throw new Error("branch required for baseBranch review");
              target = { type: "baseBranch", branch: params.branch };
            } else if (params.targetType === "commit") {
              if (!params.sha) throw new Error("sha required for commit review");
              target = { type: "commit", sha: params.sha };
            }
            const res = bugBotCiRef.reviewTarget(target);
            return {
              content: [{ type: "text", text: res.renderedText }],
              details: res
            };
          }
          case "learn_rule": {
            if (!params.ruleId || !params.title || !params.forbiddenPattern) {
              throw new Error("ruleId, title, and forbiddenPattern are required for learn_rule");
            }
            const out = bugBotCiRef.learnReviewRule({
              id: params.ruleId,
              title: params.title,
              glob: params.glob ?? "**/*",
              forbiddenPattern: params.forbiddenPattern,
              body: params.body ?? params.title,
              priority: params.priority ?? 1
            });
            return {
              content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
              details: out
            };
          }
          case "suppress_false_positive": {
            if (!params.ruleId || !params.relPath || !params.lineSnippet) {
              throw new Error("ruleId, relPath, and lineSnippet required for suppress_false_positive");
            }
            const fingerprint = bugBotCiRef.suppressFalsePositive({
              ruleId: params.ruleId,
              relPath: params.relPath,
              lineSnippet: params.lineSnippet,
              reason: params.reason ?? "confirmed false positive"
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ fingerprint }) }],
              details: { fingerprint }
            };
          }
          case "run_ci_loop": {
            if (!params.command) throw new Error("command required for run_ci_loop");
            const res = await bugBotCiRef.runCiVerificationLoop({
              command: params.command,
              maxAttempts: params.maxAttempts ?? 2
            });
            return {
              content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
              details: res
            };
          }
        }
      }
    });

    // 4. `browser_control` (`exposure: "deferred"` -> +0 active schema tokens)
    pi.registerTool({
      name: "browser_control",
      label: "ARIA @e1 Snapshot & Multimodal Browser Controller",
      description:
        "Navigates pages, captures compact @e1 ARIA accessibility snapshots, clicks/fills validated refs (blocking stale refs after DOM mutation), and captures PNG screenshots.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("load_html"),
          Type.Literal("navigate"),
          Type.Literal("snapshot"),
          Type.Literal("click"),
          Type.Literal("fill"),
          Type.Literal("get_text"),
          Type.Literal("screenshot"),
          Type.Literal("close_cdp")
        ]),
        backend: Type.Optional(
          Type.Union([Type.Literal("virtual"), Type.Literal("cdp")], {
            description: "Browser backend ('cdp' uses real Headless Chromium; default 'virtual' unless CDP active)"
          })
        ),
        url: Type.Optional(Type.String()),
        html: Type.Optional(Type.String()),
        ref: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        expectedSnapshotId: Type.Optional(Type.String()),
        interactiveOnly: Type.Optional(Type.Boolean()),
        compact: Type.Optional(Type.Boolean()),
        includeUrls: Type.Optional(Type.Boolean()),
        depth: Type.Optional(Type.Number()),
        selector: Type.Optional(Type.String())
      }),
      exposure: "deferred",
      async execute(_id, params): Promise<{
        content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
        details: unknown;
      }> {
        const useCdp =
          params.backend === "cdp" ||
          (params.backend === undefined && browserController.isCdpActive());

        switch (params.action) {
          case "close_cdp": {
            await browserController.closeCdp();
            return {
              content: [{ type: "text", text: JSON.stringify({ closed: true }) }],
              details: { closed: true }
            };
          }
          case "load_html": {
            if (params.backend === "cdp") {
              const dataUrl = `data:text/html,${encodeURIComponent(params.html ?? "")}`;
              const out = await browserController.navigateCdp(dataUrl);
              return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
            }
            const out = browserController.loadHtmlDocument(
              params.url ?? "about:srcdoc",
              params.html ?? ""
            );
            return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
          }
          case "navigate": {
            if (!params.url) throw new Error("url required for navigate");
            const out = useCdp
              ? await browserController.navigateCdp(params.url)
              : await browserController.navigate(params.url);
            return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
          }
          case "snapshot": {
            const snapOpts = {
              interactive: params.interactiveOnly,
              compact: params.compact ?? true,
              urls: params.includeUrls,
              depth: params.depth,
              selector: params.selector
            };
            const snap = useCdp
              ? await browserController.snapshotCdp(snapOpts)
              : browserController.snapshot(snapOpts);
            return {
              content: [
                {
                  type: "text",
                  text: `[snapshotId=${snap.snapshotId} rev=${snap.domRevision} url=${snap.url}]\n${snap.snapshot}`
                }
              ],
              details: snap
            };
          }
          case "click": {
            if (!params.ref) throw new Error("ref required for click");
            const out = useCdp
              ? await browserController.clickCdp(params.ref, {
                  expectedSnapshotId: params.expectedSnapshotId
                })
              : browserController.click(params.ref, {
                  expectedSnapshotId: params.expectedSnapshotId
                });
            return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
          }
          case "fill": {
            if (!params.ref) throw new Error("ref required for fill");
            const out = useCdp
              ? await browserController.fillCdp(params.ref, params.text ?? "", {
                  expectedSnapshotId: params.expectedSnapshotId
                })
              : browserController.fill(params.ref, params.text ?? "", {
                  expectedSnapshotId: params.expectedSnapshotId
                });
            return { content: [{ type: "text", text: JSON.stringify(out) }], details: out };
          }
          case "get_text": {
            if (!params.ref) throw new Error("ref required for get_text");
            const textVal = useCdp
              ? await browserController.getTextCdp(params.ref, {
                  expectedSnapshotId: params.expectedSnapshotId
                })
              : browserController.getText(params.ref, {
                  expectedSnapshotId: params.expectedSnapshotId
                });
            return { content: [{ type: "text", text: textVal }], details: { text: textVal } };
          }
          case "screenshot": {
            const img = useCdp
              ? await browserController.screenshotCdp()
              : browserController.screenshot();
            return {
              content: [
                { type: "text", text: `Captured PNG screenshot of ${params.url ?? "active page"}` },
                img
              ],
              details: {
                backend: useCdp ? "cdp" : "virtual",
                mimeType: img.mimeType,
                byteLength: Buffer.from(img.data, "base64").length
              }
            };
          }
        }
      }
    });

    // 5. `pty_session` (`exposure: "deferred"` -> +0 active schema tokens)
    pi.registerTool({
      name: "pty_session",
      label: "Background PTY Lease Manager",
      description:
        "Starts, polls (via incremental OpenCode cursor), writes stdin, stops, or lists leased background terminal processes.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("start"),
          Type.Literal("poll"),
          Type.Literal("write_stdin"),
          Type.Literal("stop"),
          Type.Literal("list")
        ]),
        id: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        leaseMs: Type.Optional(Type.Number()),
        cursor: Type.Optional(Type.Number()),
        stdinData: Type.Optional(Type.String()),
        watchPatterns: Type.Optional(Type.Array(Type.String()))
      }),
      exposure: "deferred",
      async execute(_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
        switch (params.action) {
          case "start": {
            if (!params.command) throw new Error("command required for pty_session.start");
            const info = ptyManager.start({
              command: params.command,
              title: params.title,
              leaseMs: params.leaseMs,
              watchPatterns: params.watchPatterns
            });
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], details: info };
          }
          case "poll": {
            if (!params.id) throw new Error("id required for pty_session.poll");
            const out = ptyManager.poll(params.id, params.cursor);
            return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
          }
          case "write_stdin": {
            if (!params.id) throw new Error("id required for pty_session.write_stdin");
            ptyManager.writeStdin(params.id, params.stdinData ?? "");
            return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
          }
          case "stop": {
            if (!params.id) throw new Error("id required for pty_session.stop");
            const out = ptyManager.stop(params.id);
            return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
          }
          case "list": {
            const list = ptyManager.list();
            return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }], details: list };
          }
        }
      }
    });

    // 6. `cron_routine` (`exposure: "deferred"` -> +0 active schema tokens)
    pi.registerTool({
      name: "cron_routine",
      label: "Unattended Cron Routines (DENY_UNATTENDED)",
      description:
        "Creates, lists, pauses, resumes, removes, or ticks unattended scheduled routines gated by Ring 0 DENY_UNATTENDED.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("create"),
          Type.Literal("list"),
          Type.Literal("pause"),
          Type.Literal("resume"),
          Type.Literal("remove"),
          Type.Literal("tick"),
          Type.Literal("pause_all"),
          Type.Literal("resume_all")
        ]),
        jobId: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        intervalMs: Type.Optional(Type.Number()),
        command: Type.Optional(Type.String()),
        targetPaths: Type.Optional(Type.Array(Type.String())),
        nowMs: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String())
      }),
      exposure: "deferred",
      async execute(_id, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
        if (!cronSchedulerRef) throw new Error("UnattendedCronScheduler not initialized");
        switch (params.action) {
          case "create": {
            if (!params.name || !params.command || !params.intervalMs) {
              throw new Error("name, intervalMs, and command required for cron_routine.create");
            }
            const job = cronSchedulerRef.createRoutine({
              name: params.name,
              intervalMs: params.intervalMs,
              command: params.command,
              targetPaths: params.targetPaths,
              nowMs: params.nowMs
            });
            return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }], details: job };
          }
          case "list": {
            const jobs = cronSchedulerRef.listRoutines();
            return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }], details: jobs };
          }
          case "pause": {
            if (!params.jobId) throw new Error("jobId required");
            const job = cronSchedulerRef.pauseRoutine(params.jobId, params.nowMs);
            return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }], details: job };
          }
          case "resume": {
            if (!params.jobId) throw new Error("jobId required");
            const job = cronSchedulerRef.resumeRoutine(params.jobId, params.nowMs);
            return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }], details: job };
          }
          case "remove": {
            if (!params.jobId) throw new Error("jobId required");
            const removed = cronSchedulerRef.removeRoutine(params.jobId);
            return {
              content: [{ type: "text", text: JSON.stringify({ removed }) }],
              details: { removed }
            };
          }
          case "tick": {
            const receipts = cronSchedulerRef.tick(params.nowMs);
            return {
              content: [{ type: "text", text: JSON.stringify(receipts, null, 2) }],
              details: receipts
            };
          }
          case "pause_all": {
            cronSchedulerRef.pauseAll(params.reason);
            return {
              content: [{ type: "text", text: JSON.stringify(cronSchedulerRef.isGloballyPaused()) }],
              details: cronSchedulerRef.isGloballyPaused()
            };
          }
          case "resume_all": {
            cronSchedulerRef.resumeAll();
            return {
              content: [{ type: "text", text: JSON.stringify(cronSchedulerRef.isGloballyPaused()) }],
              details: cronSchedulerRef.isGloballyPaused()
            };
          }
        }
      }
    });

    // Plan Mode read-only tool gate (`plan-mode/index.ts` + Ring 0 monotonic shell guard)
    pi.on("tool_call", async (event) => {
      if (!trustArtifactsRef) return undefined;
      const verdict = trustArtifactsRef.evaluatePlanModeToolCall(event.toolName, event.input);
      if (verdict.block) {
        return { block: true, reason: verdict.reason };
      }
      return undefined;
    });

    // Track `[DONE:n]` markers in assistant messages against active Plan Trust Artifacts
    pi.on("turn_end", async (event) => {
      if (!trustArtifactsRef) return undefined;
      const msg = event.message as AssistantMessage | undefined;
      if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        if (text) {
          trustArtifactsRef.recordAssistantTurnMarkers(text);
        }
      }
      return undefined;
    });
  };

  const ring1 = await createRing1Harness({
    ...opts,
    extraExtensions: [ring2Extension, ...(opts.extraExtensions ?? [])]
  });

  const resolvedSurfacesDir =
    opts.surfacesDir ?? path.join(path.resolve(opts.workspaceRoot), "surfaces");

  const trustArtifacts = new TrustArtifactController({
    db: ring1.stateDb.db,
    workspaceRoot: opts.workspaceRoot,
    guardrails,
    durabilityMode: opts.durabilityMode ?? "crash-safe",
    initialPlanMode: opts.ring2?.initialPlanMode ?? false
  });
  trustArtifacts.bindSession(ring1.session);

  const subagentPool = new WorktreeSubagentPool({
    workspaceRoot: opts.workspaceRoot,
    surfacesDir: resolvedSurfacesDir,
    modelRuntime: ring1.session.modelRuntime,
    model: ring1.session.state.model!,
    currentDepth: opts.ring2?.subagentDepth ?? 0,
    worktreeBaseDir: opts.ring2?.worktreeBaseDir,
    childSandboxMode: opts.sandboxMode ?? "workspace-write",
    childAllowUnsandboxedDev: opts.allowUnsandboxedDev ?? true,
    durabilityMode: opts.durabilityMode ?? "crash-safe"
  });

  const bugBotCi = new BugBotAndCiEngine({
    workspaceRoot: opts.workspaceRoot,
    db: ring1.stateDb.db,
    guardrails,
    durabilityMode: opts.durabilityMode ?? "crash-safe",
    bashOps: ring1.bashOps,
    sandboxMode: opts.sandboxMode ?? "workspace-write",
    artifacts: trustArtifacts
  });

  const cronScheduler = new UnattendedCronScheduler({
    db: ring1.stateDb.db,
    workspaceRoot: opts.workspaceRoot,
    guardrails
  });

  trustArtifactsRef = trustArtifacts;
  subagentPoolRef = subagentPool;
  bugBotCiRef = bugBotCi;
  cronSchedulerRef = cronScheduler;

  return {
    ...ring1,
    trustArtifacts,
    subagentPool,
    bugBotCi,
    browserController,
    ptyManager,
    cronScheduler,
    dispose() {
      void browserController.closeCdp().catch(() => {});
      ptyManager.dispose();
      subagentPool.dispose();
      ring1.dispose();
    },
    async disposeAsync() {
      await browserController.closeCdp().catch(() => {});
      ptyManager.dispose();
      subagentPool.dispose();
      await ring1.disposeAsync();
    }
  };
}
