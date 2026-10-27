import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from "@earendil-works/pi-ai";
import { countO200kTokens } from "../../src/core/prefix-budget.ts";
import { createRing0Harness, createSharedModelRuntime } from "../../src/core/ring0-session.ts";
import { createRing2Harness } from "../../src/ring2/ring2-extension.ts";
import { gitWorktreeList } from "../../src/ring2/worktree-subagent-pool.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SURFACES_SRC = path.join(REPO_ROOT, "surfaces");

function copySurfacesTo(destDir: string): string {
  const target = path.join(destDir, "surfaces");
  fs.mkdirSync(target, { recursive: true });
  for (const name of ["SYSTEM.md", "TOOL_GUIDANCE.md", "MEMORY.md"]) {
    fs.copyFileSync(path.join(SURFACES_SRC, name), path.join(target, name));
  }
  return target;
}

function runGitOrThrow(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((res.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? "").trim();
}

function countActiveToolSchemaTokens(tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>): number {
  return countO200kTokens(
    JSON.stringify(
      tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        parameters: t.parameters ?? null
      }))
    )
  );
}

async function runRing2Suite(): Promise<void> {
  const startedAt = performance.now();
  const checks: string[] = [];
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-ring2-"));

  const faux = fauxProvider();
  const sharedRuntime = await createSharedModelRuntime();
  sharedRuntime.registerNativeProvider(faux.provider);
  await sharedRuntime.setRuntimeApiKey(faux.provider.id, "faux-ring2-key");

  try {
    // Prepare Git-initialized workspace for Ring 2
    const ws = path.join(tmpBase, "ws");
    fs.mkdirSync(path.join(ws, "src", "billing"), { recursive: true });
    fs.mkdirSync(path.join(ws, "src", "shipping"), { recursive: true });
    const wsR0 = path.join(tmpBase, "ws-r0");
    fs.mkdirSync(wsR0, { recursive: true });
    const surfaces = copySurfacesTo(tmpBase);

    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Ring 2 Test Repo\n", "utf8");
    fs.writeFileSync(
      path.join(ws, "src", "billing", "invoice.ts"),
      `export function computeTotal(cents: number): number {\n  return cents;\n}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(ws, "src", "shipping", "rate.ts"),
      `export function shippingFee(kg: number): number {\n  return kg * 100;\n}\n`,
      "utf8"
    );
    fs.writeFileSync(path.join(ws, ".env"), "STRIPE_LIVE_SECRET=sk_live_never_touch\n", "utf8");

    runGitOrThrow(ws, ["init", "-b", "main"]);
    runGitOrThrow(ws, ["config", "user.email", "ring2@example.com"]);
    runGitOrThrow(ws, ["config", "user.name", "Ring 2 Test"]);
    runGitOrThrow(ws, ["add", "AGENTS.md", "src"]);
    runGitOrThrow(ws, ["commit", "-m", "initial commit"]);

    // =========================================================================
    // R2-1. Zero Active Schema Bloat (`Invariant I-01` & `I-03`: 1073 === 1073)
    //       + `tool_search` & QuickJS WASM `codemode` execution of Ring 2 tools
    // =========================================================================
    const r0Base = await createRing0Harness({
      workspaceRoot: wsR0,
      surfacesDir: surfaces,
      allowUnsandboxedDev: true,
      modelRuntime: sharedRuntime,
      model: faux.getModel()
    });
    const r0SchemaTokens = countActiveToolSchemaTokens(r0Base.session.agent.state.tools);
    r0Base.dispose();

    const r2 = await createRing2Harness({
      workspaceRoot: ws,
      surfacesDir: surfaces,
      allowUnsandboxedDev: true,
      modelRuntime: sharedRuntime,
      model: faux.getModel(),
      ring2: {
        initialPlanMode: true
      }
    });

    try {
      const r2SchemaTokens = countActiveToolSchemaTokens(r2.session.agent.state.tools);
      assert.ok(r2.session.systemPrompt.includes("Explicit browse/research requests or current facts"), "Boot prompt should explain when to use browser_control");
      assert.ok(r2.session.systemPrompt.includes("not guaranteed search/citation"), "Prompt must disclose browser limitations instead of implying guaranteed web search");
      assert.equal(
        r2SchemaTokens,
        r0SchemaTokens,
        "All 6 Ring 2 tools MUST have exposure='deferred' (+0 active schema tokens)!"
      );

      // Verify `tool_search` discovers Ring 2 deferred tools AND `codemode` calls `browser_control` inside QuickJS WASM!
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("tool_search", {
            query: "trust_artifact subagent_dispatch code_review_ci browser_control pty_session cron_routine",
            limit: 10
          })
        ]),
        fauxAssistantMessage([
          fauxToolCall("codemode", {
            code: `
              await tools.browser_control({
                action: "load_html",
                url: "https://codemode.example.test",
                html: "<main><button>CodemodeClick</button></main>"
              });
              const snap = await tools.browser_control({
                action: "snapshot",
                interactiveOnly: true,
                compact: true
              });
              return snap;
            `
          })
        ]),
        fauxAssistantMessage("Discovered and executed Ring 2 deferred tools via Codemode.")
      ]);
      await r2.session.prompt("Please browse for current information on the sample topic and use Ring 2 tools.");
      const searchOut = JSON.stringify(r2.session.messages);
      for (const toolName of [
        "trust_artifact",
        "subagent_dispatch",
        "code_review_ci",
        "browser_control",
        "pty_session",
        "cron_routine"
      ]) {
        assert.ok(searchOut.includes(toolName), `tool_search must discover ${toolName}`);
      }
      assert.ok(
        searchOut.includes("CodemodeClick") && searchOut.includes("ref=e1"),
        "QuickJS WASM Codemode must execute deferred Ring 2 browser_control tool!"
      );
      const nonBrowseStart=r2.session.messages.length;
      faux.setResponses([fauxAssistantMessage("This stable coding answer does not need browsing.")]);
      await r2.session.prompt("Explain this local TypeScript helper; no current information is needed.");
      const nonBrowseTrace=JSON.stringify(r2.session.messages.slice(nonBrowseStart));
      assert.ok(!nonBrowseTrace.includes("browser_control"),"A scripted non-browse fixture should not invoke browser_control");
      checks.push(
        `R2-1. Zero active schema bloat (${r2SchemaTokens} === ${r0SchemaTokens} o200k tokens across 8 Ring1+Ring2 deferred tools + Codemode): PASS`
      );

      // =========================================================================
      // R2-2. Pi Plan Mode Gate + Antigravity Trust Artifacts + Inline `steer()`
      // =========================================================================
      assert.equal(r2.trustArtifacts.isPlanModeActive(), true);

      // Attempt `write` AND compound shell bypass `cat AGENTS.md && rm -rf src` while in Plan Mode!
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "src/billing/hacked.ts", content: "bad" }, { id: "pm_w1" })
        ]),
        fauxAssistantMessage([
          fauxToolCall("bash", { command: "cat AGENTS.md && rm -rf src" }, { id: "pm_b1" })
        ]),
        fauxAssistantMessage([
          fauxToolCall("bash", { command: "git status --short" }, { id: "pm_ok1" })
        ]),
        fauxAssistantMessage("Plan mode read-only checks verified.")
      ]);
      await r2.session.prompt("Test Plan Mode enforcement");
      assert.equal(fs.existsSync(path.join(ws, "src", "billing", "hacked.ts")), false);
      const pmTranscript = JSON.stringify(r2.session.messages);
      assert.ok(pmTranscript.includes("PLAN_MODE_READ_ONLY"), "Plan Mode must block write and compound shell bypass!");

      // Create Plan Trust Artifact (`extractTodoItems` from Pi `plan-mode/utils.ts`)
      const planArtifact = r2.trustArtifacts.createOrUpdateArtifact({
        kind: "plan",
        title: "Billing & Shipping Upgrade Plan",
        markdown: [
          "# Upgrade Plan",
          "Plan:",
          "1. Add applyDiscount helper in src/billing/invoice.ts",
          "2. Add expressSurcharge helper in src/shipping/rate.ts"
        ].join("\n")
      });
      assert.equal(planArtifact.todos.length, 2);
      assert.equal(planArtifact.todos[0].completed, false);
      assert.ok(fs.existsSync(path.join(ws, planArtifact.diskRelPath)));

      // Attach Antigravity-style inline line-anchored comment (`L3-L3`) -> queued via Pi session steering!
      const inlineCmt = await r2.trustArtifacts.addInlineCommentAndSteer({
        artifactId: planArtifact.artifactId,
        lineStart: 3,
        lineEnd: 3,
        comment: "Clamp discount percentage to [0, 100] so totals never go negative.",
        author: "reviewer"
      });
      assert.ok(inlineCmt.selectedExcerpt.includes("applyDiscount"));
      assert.equal(r2.trustArtifacts.getArtifact(planArtifact.artifactId)?.status, "changes_requested");

      // Approve plan (exits Plan Mode) and execute turn emitting `[DONE:1] [DONE:2]`
      const approved = r2.trustArtifacts.approvePlanArtifact(planArtifact.artifactId, true);
      assert.equal(approved.status, "approved");
      assert.equal(r2.trustArtifacts.isPlanModeActive(), false);

      let sawInlineSteerInRequest = false;
      faux.setResponses([
        (ctx: Context) => {
          const serialized = JSON.stringify(ctx.messages);
          if (serialized.includes("<artifact-inline-steer") && serialized.includes("Clamp discount percentage")) {
            sawInlineSteerInRequest = true;
          }
          return fauxAssistantMessage(
            "Implemented clamped discount and express surcharge. [DONE:1] [DONE:2]"
          );
        }
      ]);
      await r2.session.prompt("Execute approved plan");
      assert.equal(sawInlineSteerInRequest, true, "Inline comment steer payload must arrive in turn context!");

      const completedPlan = r2.trustArtifacts.getArtifact(planArtifact.artifactId)!;
      assert.equal(completedPlan.todos.every((t) => t.completed), true, "[DONE:1] [DONE:2] must complete plan steps!");
      assert.equal(
        new Set(r2.observedPrefixHashes).size,
        1,
        "Inline steering and Plan Mode transitions MUST NOT mutate the frozen static prefix (Invariant I-01)!"
      );
      checks.push(
        "R2-2. Pi Plan Mode read-only gate + Trust Artifacts + inline L-anchored steer() + [DONE:n] tracking + 0 prefix drift: PASS"
      );

      // =========================================================================
      // R2-3. 5-Role 1-Level Disjoint `git worktree` Subagent Pool
      // =========================================================================
      // 3a. Overlapping `ownedPaths` in parallel `execute` MUST fail closed immediately!
      await assert.rejects(
        async () => {
          await r2.subagentPool.dispatch({
            tasks: [
              { role: "execute", task: "Edit billing", ownedPaths: ["src/billing"] },
              { role: "execute", task: "Edit tax", ownedPaths: ["src/billing/tax"] }
            ]
          });
        },
        /OVERLAPPING_OWNED_PATHS/
      );

      // 3b. Parallel disjoint `execute` subagents in separate detached `git worktree`s!
      // Use context-aware faux response so parallel workers stay deterministic regardless of scheduling order!
      const issuedWriteForRole = new Set<string>();
      faux.setResponses([
        (ctx: Context) => {
          const text = JSON.stringify(ctx.messages);
          if (text.includes("src/billing/discount.ts") && !issuedWriteForRole.has("billing")) {
            issuedWriteForRole.add("billing");
            return fauxAssistantMessage([
              fauxToolCall("write", {
                path: "src/billing/discount.ts",
                content:
                  "export function clampDiscount(pct: number): number {\n  return Math.max(0, Math.min(100, pct));\n}\n"
              })
            ]);
          }
          if (text.includes("src/shipping/express.ts") && !issuedWriteForRole.has("shipping")) {
            issuedWriteForRole.add("shipping");
            return fauxAssistantMessage([
              fauxToolCall("write", {
                path: "src/shipping/express.ts",
                content: "export function expressSurcharge(): number {\n  return 500;\n}\n"
              })
            ]);
          }
          return fauxAssistantMessage("Worker finished.");
        },
        (ctx: Context) => {
          const text = JSON.stringify(ctx.messages);
          if (text.includes("src/billing/discount.ts") && !issuedWriteForRole.has("billing")) {
            issuedWriteForRole.add("billing");
            return fauxAssistantMessage([
              fauxToolCall("write", {
                path: "src/billing/discount.ts",
                content:
                  "export function clampDiscount(pct: number): number {\n  return Math.max(0, Math.min(100, pct));\n}\n"
              })
            ]);
          }
          if (text.includes("src/shipping/express.ts") && !issuedWriteForRole.has("shipping")) {
            issuedWriteForRole.add("shipping");
            return fauxAssistantMessage([
              fauxToolCall("write", {
                path: "src/shipping/express.ts",
                content: "export function expressSurcharge(): number {\n  return 500;\n}\n"
              })
            ]);
          }
          return fauxAssistantMessage("Worker finished.");
        },
        fauxAssistantMessage("Worker finished."),
        fauxAssistantMessage("Worker finished.")
      ]);

      const parallelRes = await r2.subagentPool.dispatch({
        tasks: [
          { role: "execute", task: "Create src/billing/discount.ts", ownedPaths: ["src/billing"] },
          { role: "execute", task: "Create src/shipping/express.ts", ownedPaths: ["src/shipping"] }
        ]
      });
      assert.equal(parallelRes.mode, "parallel");
      assert.equal(parallelRes.results.length, 2);
      assert.equal(parallelRes.results[0].exitStatus, "ok", parallelRes.results[0].errorMessage);
      assert.equal(parallelRes.results[1].exitStatus, "ok", parallelRes.results[1].errorMessage);
      assert.equal(parallelRes.results[0].usedIsolatedWorktree, true);
      assert.equal(parallelRes.results[1].usedIsolatedWorktree, true);
      assert.ok(fs.existsSync(path.join(ws, "src", "billing", "discount.ts")));
      assert.ok(fs.existsSync(path.join(ws, "src", "shipping", "express.ts")));

      // Verify OpenCode PR #14649 fix: ZERO leaked linked worktrees remain after parallel execution!
      const worktreesAfterParallel = gitWorktreeList(ws);
      assert.equal(
        worktreesAfterParallel.length,
        1,
        "Only main worktree may remain; all ephemeral subagent worktrees must be pruned!"
      );

      // 3c. Execute worker touching a file OUTSIDE its `ownedPaths` MUST fail closed on harvest!
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", {
            path: "src/shipping/sneaky.ts",
            content: "export const bad = 1;\n"
          })
        ]),
        fauxAssistantMessage("Wrote outside ownedPaths.")
      ]);
      const rogueRes = await r2.subagentPool.dispatch({
        role: "execute",
        task: "Try writing outside ownedPaths",
        ownedPaths: ["src/billing"]
      });
      assert.equal(rogueRes.results[0].exitStatus, "error");
      assert.match(rogueRes.results[0].errorMessage ?? "", /UNOWNED_PATH_MUTATION/);
      assert.equal(fs.existsSync(path.join(ws, "src", "shipping", "sneaky.ts")), false);
      assert.equal(gitWorktreeList(ws).length, 1, "Failed rogue worktree must still be cleaned up!");

      // 3d. Read-only `explore` worker attempting `write` is denied by role gate!
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "src/billing/nope.ts", content: "nope" })
        ]),
        fauxAssistantMessage("Explore blocked from writing.")
      ]);
      const exploreRes = await r2.subagentPool.dispatch({
        role: "explore",
        task: "Inspect billing"
      });
      assert.equal(exploreRes.results[0].exitStatus, "ok");
      assert.equal(fs.existsSync(path.join(ws, "src", "billing", "nope.ts")), false);

      // 3e. Depth-1 Non-Recursive Cap (`currentDepth: 1` -> `MAX_SUBAGENT_DEPTH_EXCEEDED`)
      const wsDepth1 = path.join(tmpBase, "ws-depth1");
      fs.mkdirSync(wsDepth1, { recursive: true });
      const depth1Child = await createRing2Harness({
        workspaceRoot: wsDepth1,
        surfacesDir: surfaces,
        allowUnsandboxedDev: true,
        modelRuntime: sharedRuntime,
        model: faux.getModel(),
        ring2: { subagentDepth: 1 }
      });
      try {
        await assert.rejects(
          async () => {
            await depth1Child.subagentPool.dispatch({ role: "explore", task: "Nested!" });
          },
          /MAX_SUBAGENT_DEPTH_EXCEEDED/
        );
      } finally {
        await depth1Child.disposeAsync();
      }

      // Commit the harvested files cleanly on main before R2-4 branch test
      runGitOrThrow(ws, ["add", "src/billing/discount.ts", "src/shipping/express.ts"]);
      runGitOrThrow(ws, ["commit", "-m", "harvested parallel worktree changes"]);
      checks.push(
        "R2-3. 5-role 1-level disjoint git worktree subagent pool (parallel execute + unowned-path block + 0 leaked worktrees + depth-1 cap): PASS"
      );

      // =========================================================================
      // R2-4. BugBot `REVIEW_RULES.md` + Codex `ReviewOutputEvent` (#8404 Fix) + CI Loop
      // =========================================================================
      const learned = r2.bugBotCi.learnReviewRule({
        id: "NO_DYNAMIC_EVAL",
        title: "Never use eval() in TypeScript modules",
        glob: "src/**/*.ts",
        forbiddenPattern: "\\beval\\s*\\(",
        body: "Dynamic eval() breaks CSP and enables code injection.",
        priority: 1
      });
      assert.equal(learned.totalRules, 1);
      runGitOrThrow(ws, ["add", "REVIEW_RULES.md"]);
      runGitOrThrow(ws, ["commit", "-m", "add learned REVIEW_RULES.md"]);

      runGitOrThrow(ws, ["checkout", "-b", "feat/clean-branch"]);
      fs.writeFileSync(
        path.join(ws, "src", "billing", "safe_helper.ts"),
        "export const TAX_BPS = 2100;\n",
        "utf8"
      );
      runGitOrThrow(ws, ["add", "src/billing/safe_helper.ts"]);
      runGitOrThrow(ws, ["commit", "-m", "clean branch commit"]);

      // Now dirty a tracked/uncommitted file in the working tree with `eval("dirty()")`!
      // Under Codex Issue #8404 bug (`git diff mergeBase`), this working-tree dirt polluted `baseBranch` reviews!
      // With our `git diff mergeBase...HEAD` fix, `baseBranch` MUST report 0 findings!
      fs.writeFileSync(
        path.join(ws, "src", "billing", "invoice.ts"),
        `export function computeTotal(cents: number): number {\n  eval("dirty_working_tree_only()");\n  return cents;\n}\n`,
        "utf8"
      );
      const cleanBranchReview = r2.bugBotCi.reviewTarget({ type: "baseBranch", branch: "main" });
      assert.equal(
        cleanBranchReview.output.findings.length,
        0,
        "Codex #8404/#17160 fix: uncommitted working-tree dirt MUST NOT pollute baseBranch (mergeBase...HEAD) review!"
      );

      // Meanwhile `uncommittedChanges` target DOES catch the working-tree `eval(...)` on exact line 2!
      const uncommittedReview = r2.bugBotCi.reviewTarget({ type: "uncommittedChanges" });
      assert.equal(uncommittedReview.output.findings.length, 1);
      assert.equal(uncommittedReview.output.findings[0].code_location.line_range.start, 2);
      assert.ok(uncommittedReview.renderedText.includes("[NO_DYNAMIC_EVAL]"));

      // Suppress false positive and verify re-run yields 0 findings
      r2.bugBotCi.suppressFalsePositive({
        ruleId: "NO_DYNAMIC_EVAL",
        relPath: "src/billing/invoice.ts",
        lineSnippet: `eval("dirty_working_tree_only()");`,
        reason: "test fixture verification"
      });
      const afterSuppress = r2.bugBotCi.reviewTarget({ type: "uncommittedChanges" });
      assert.equal(afterSuppress.output.findings.length, 0);

      // Restore clean `invoice.ts` and test bounded CI verification + autofix loop!
      runGitOrThrow(ws, ["checkout", "--", "src/billing/invoice.ts"]);
      const brokenPath = path.join(ws, "src", "billing", "ci_check.ts");
      fs.writeFileSync(
        brokenPath,
        `const brokenAmount: number = "not_a_number";\nexport { brokenAmount };\n`,
        "utf8"
      );

      const tscBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
      const ciRes = await r2.bugBotCi.runCiVerificationLoop({
        command: `${tscBin} --noEmit --pretty false --strict "${brokenPath}"`,
        maxAttempts: 2,
        onFailureAutofix: async (failedAttempt) => {
          assert.ok(failedAttempt.diagnostics.length >= 1, "Must parse structured file(line,col) diagnostic!");
          assert.equal(failedAttempt.diagnostics[0].line, 1);
          fs.writeFileSync(
            brokenPath,
            `const brokenAmount: number = 4200;\nexport { brokenAmount };\n`,
            "utf8"
          );
        }
      });
      assert.equal(ciRes.passed, true);
      assert.equal(ciRes.attempts.length, 2);
      assert.equal(ciRes.verificationArtifact?.status, "verified");
      checks.push(
        "R2-4. BugBot REVIEW_RULES.md + Codex ReviewOutputEvent (#8404 mergeBase...HEAD fix) + 2-attempt CI autofix loop: PASS"
      );

      // =========================================================================
      // R2-5. Vercel `agent-browser` `@e1` ARIA Snapshotter (#1443 & #2147 Fixes) + PNG Screenshot
      // =========================================================================
      const initialHtml = [
        `<main>`,
        `  <h1>Checkout</h1>`,
        `  <p>Visible plaintext status: saved successfully</p>`,
        `  <input type="email" placeholder="Customer Email" />`,
        `  <button>Alpha</button>`,
        `  <button>Beta</button>`,
        `</main>`
      ].join("\n");
      r2.browserController.loadHtmlDocument("https://shop.example.test/checkout", initialHtml);

      // Check #2147 fix: `compact: true, interactive: false` retains visible `StaticText`!
      const fullCompactSnap = r2.browserController.snapshot({ compact: true, interactive: false });
      assert.ok(
        fullCompactSnap.snapshot.includes(`StaticText "Visible plaintext status: saved successfully"`),
        "Fix #2147: compact non-interactive snapshot MUST retain visible StaticText status!"
      );

      // Interactive `@eN` snapshot
      const snap1 = r2.browserController.snapshot({ compact: true, interactive: true });
      assert.equal(snap1.refs.e1.role, "textbox");
      assert.equal(snap1.refs.e2.name, "Alpha");
      assert.equal(snap1.refs.e3.name, "Beta");

      const fillRes = r2.browserController.fill("@e1", "alice@example.com");
      assert.equal(fillRes.value, "alice@example.com");

      // Multimodal PNG screenshot check
      const pngImg = r2.browserController.screenshot();
      assert.equal(pngImg.type, "image");
      assert.equal(pngImg.mimeType, "image/png");
      const pngBytes = Buffer.from(pngImg.data, "base64");
      assert.deepEqual(
        Array.from(pngBytes.subarray(0, 8)),
        [137, 80, 78, 71, 13, 10, 26, 10],
        "Screenshot MUST be a valid RFC-2083 PNG binary payload!"
      );

      // Reproduce `vercel-labs/agent-browser` Issue #1443:
      // Mutate DOM by prepending `<button>NEW</button>` before `Alpha` & `Beta`, then try clicking stale `@e3`!
      r2.browserController.loadHtmlDocument(
        "https://shop.example.test/checkout",
        [
          `<main>`,
          `  <button>NEW</button>`,
          `  <button>Alpha</button>`,
          `  <button>Beta</button>`,
          `</main>`
        ].join("\n")
      );
      assert.throws(
        () => r2.browserController.click("@e3"),
        /STALE_SNAPSHOT_REF/,
        "Fix #1443: stale @eN ref after DOM mutation MUST fail closed instead of clicking shifted element!"
      );

      // Re-snapshot (`snap_3`) -> `@e3` is now `Beta` and succeeds cleanly!
      const snapAfterMutation = r2.browserController.snapshot({ interactive: true, compact: true });
      assert.equal(snapAfterMutation.refs.e3.name, "Beta");
      const clickedBeta = r2.browserController.click("@e3", {
        expectedSnapshotId: snapAfterMutation.snapshotId
      });
      assert.equal(clickedBeta.name, "Beta");
      checks.push(
        "R2-5. Vercel agent-browser @e1 ARIA snapshotter (Fix #1443 stale-ref block + Fix #2147 StaticText + valid PNG ImageContent): PASS"
      );

      // =========================================================================
      // R2-6. OpenCode 2 MiB Cursor PTY Leases + Hermes Watch-Breaker & `DENY_UNATTENDED` Cron
      // =========================================================================
      const prevOpenAiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-host-secret-must-not-leak-to-pty";
      try {
        // 6a. Incremental cursor polling + zero secret env leak + Hermes rapid watch strike breaker
        const pty = r2.ptyManager.start({
          command:
            'printf "BOOT_READY api=%s\\n" "${OPENAI_API_KEY:-REDACTED}"; sleep 0.08; printf "BOOT_READY_2\\n"; sleep 0.05; printf "BOOT_READY_3\\n"; sleep 0.05; printf "BOOT_READY_4\\n"',
          title: "Dev Watcher",
          leaseMs: 5_000,
          watchPatterns: ["BOOT_READY"]
        });

        await new Promise((r) => setTimeout(r, 110));
        const poll1 = r2.ptyManager.poll(pty.id, 0);
        assert.ok(poll1.replay.includes("BOOT_READY api=REDACTED"), "Host OPENAI_API_KEY must NOT leak into PTY!");
        assert.ok(!poll1.replay.includes("sk-host-secret"));

        await new Promise((r) => setTimeout(r, 220));
        const poll2 = r2.ptyManager.poll(pty.id, poll1.cursor);
        assert.ok(
          !poll2.replay.includes("BOOT_READY api=REDACTED"),
          "Incremental OpenCode cursor poll MUST replay only new bytes after poll1.cursor!"
        );
        assert.ok(poll2.replay.includes("BOOT_READY_4"));
        assert.equal(
          poll2.watchDisabled,
          true,
          "Hermes watch-pattern circuit breaker MUST trip after 3 rapid matches inside cooldown!"
        );

        // 6b. Lease TTL expiry kills runaway background process group automatically
        const shortLease = r2.ptyManager.start({
          command: "sleep 30",
          leaseMs: 300
        });
        await new Promise((r) => setTimeout(r, 450));
        const expiredPoll = r2.ptyManager.poll(shortLease.id);
        assert.equal(expiredPoll.status, "lease_expired");
      } finally {
        if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevOpenAiKey;
      }

      // 6c. Hermes Cron Scheduler + Ring 0 `DENY_UNATTENDED` gate!
      const baseTime = 1_700_000_000_000;
      const safeCron = r2.cronScheduler.createRoutine({
        name: "Safe Git Status Check",
        intervalMs: 60_000,
        command: "git status --short",
        targetPaths: ["src/billing/invoice.ts"],
        nowMs: baseTime
      });
      const exfilCron = r2.cronScheduler.createRoutine({
        name: "Malicious Unattended Push",
        intervalMs: 60_000,
        command: "git push origin main",
        nowMs: baseTime
      });
      const secretPathCron = r2.cronScheduler.createRoutine({
        name: "Malicious Unattended .env Read",
        intervalMs: 60_000,
        command: "ls -la",
        targetPaths: [".env"],
        nowMs: baseTime
      });

      const tickReceipts = r2.cronScheduler.tick(baseTime + 60_001);
      assert.equal(tickReceipts.length, 3);
      const byJob = new Map(tickReceipts.map((r) => [r.jobId, r]));
      assert.equal(byJob.get(safeCron.jobId)?.status, "SUCCEEDED");
      assert.equal(
        byJob.get(exfilCron.jobId)?.status,
        "BLOCKED_DENY_UNATTENDED",
        "Unattended cron MUST block git push via Ring 0 DENY_UNATTENDED!"
      );
      assert.equal(
        byJob.get(secretPathCron.jobId)?.status,
        "BLOCKED_DENY_UNATTENDED",
        "Unattended cron MUST block .env access via Ring 0 DENY_UNATTENDED!"
      );

      // Pause/misfire/resume + remove + global pause emergency stop (Hermes `cron/jobs.py` semantics)
      assert.equal(r2.cronScheduler.removeRoutine(exfilCron.jobId), true);
      assert.equal(r2.cronScheduler.removeRoutine(secretPathCron.jobId), true);
      r2.cronScheduler.pauseRoutine(safeCron.jobId, baseTime + 130_000); // came due at +120_001 -> misfirePending = true!
      assert.equal(r2.cronScheduler.tick(baseTime + 135_000).length, 0);
      const resumed = r2.cronScheduler.resumeRoutine(safeCron.jobId, baseTime + 140_000);
      assert.equal(resumed.misfirePending, true);

      // Global emergency pause holds even misfire catch-up until `resumeAll()`
      r2.cronScheduler.pauseAll("maintenance window");
      assert.equal(r2.cronScheduler.tick(baseTime + 140_001).length, 0);
      r2.cronScheduler.resumeAll();
      const catchupReceipts = r2.cronScheduler.tick(baseTime + 140_001);
      assert.equal(catchupReceipts.some((r) => r.jobId === safeCron.jobId && r.status === "SUCCEEDED"), true);

      checks.push(
        "R2-6. OpenCode 2MiB cursor PTY leases + Hermes watch breaker & DENY_UNATTENDED cron scheduler: PASS"
      );
    } finally {
      await r2.disposeAsync();
    }

    const elapsedMs = Number((performance.now() - startedAt).toFixed(2));
    console.log(
      JSON.stringify(
        {
          ring2_allPassed: true,
          elapsedMs,
          checks
        },
        null,
        2
      )
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

await runRing2Suite();
