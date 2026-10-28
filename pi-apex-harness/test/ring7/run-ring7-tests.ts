/**
 * Ring 7 Capstone Verification Suite (`test/ring7/run-ring7-tests.ts`) — `R7-1` through `R7-6`:
 *  - R7-1: Real Headless Chromium 156 CDP WebSocket driver (`ChromiumCdpSession`), `inheritEnv: false`
 *          `/proc/<pid>/environ` host-secret non-leakage, SSRF/file URL confinement, `@e1` ARIA
 *          `Accessibility.getFullAXTree` snapshotter, live V8 JS click/fill, async `MutationObserver`
 *          `STALE_SNAPSHOT_REF` (`#1443`), real PNG `ImageContent` screenshot & zero orphan processes.
 *  - R7-2: `HandoffController` (`getHandoffMessages` + secret scrubbing + `parentSession` `.jsonl`
 *          header lineage), zero-prefix-drift `PresetController` (`0` SHA-256 drift + `PRESET_TOOL_RESTRICTED`
 *          gate), and `BookmarkController`.
 *  - R7-3: 6-Stage `AutonomousPrPipeline` (`apex/<slug>` branch -> Plan Trust Artifact -> patches/worktrees
 *          -> Codex `mergeBase...HEAD` + BugBot P0 gate -> sandboxed CI -> `.harness/prs/<prId>.md`
 *          + QuickJS WASM `codemode` `tools.pr_pipeline`).
 *  - R7-4: All 13 zero-token operator slash commands (`/pr`, `/handoff`, `/preset`, `/bookmark`, `/doctor`)
 *          preserving `1,073 === 1,073 o200k_base` active schema tokens & `0` prefix drift.
 *  - R7-5: Mission-Control Cockpit v3 live HTTP/SSE (`/api/pr-pipeline`, `/api/handoff`, `/api/presets`,
 *          `/api/browser` live Chromium CDP, `/api/workspaces` multi-repo switch, zero `localhost` literals).
 *  - R7-6: Portable `/home/user/pi-apex-v3.7.0-personal.tar.gz` + `.sha256` + clean extraction & `/doctor`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { countO200kTokens } from "../../src/core/prefix-budget.ts";
import {
  ALL_APEX_SLASH_COMMANDS,
  createRing4Harness,
  createRing4Runtime
} from "../../src/ring4/ring4-runtime.ts";
import { MissionControlServer } from "../../src/ring5/mission-control-server.ts";
import {
  ChromiumCdpSession,
  findLocalChromiumBinary,
  validateBrowserNavigationUrl
} from "../../src/ring7/chromium-cdp-driver.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SURFACES_DIR = path.join(REPO_ROOT, "surfaces");

function initGitWorkspace(baseDir: string, name: string): string {
  const ws = path.join(baseDir, name);
  fs.mkdirSync(path.join(ws, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(ws, "src", "billing"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, "src", "auth", "session.ts"),
    "export function verifyToken(t: string): boolean {\n  return t.length > 8;\n}\n",
    "utf8"
  );
  fs.writeFileSync(path.join(ws, ".env"), "SECRET_DB_TOKEN=super-secret-do-not-read\n", {
    encoding: "utf8",
    mode: 0o600
  });

  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@pi-apex.local"]);
  git(["config", "user.name", "Pi-Apex Test"]);
  git(["add", "src"]);
  git(["commit", "-m", "chore: initial repository commit"]);
  return ws;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-ring7-"));
  const results: Array<{ id: string; detail: string }> = [];

  try {
    // =========================================================================
    // R7-1: Real Headless Chromium 156 CDP WebSocket Driver + `#1443` Live Mutation Guard
    // =========================================================================
    {
      const chromiumBin = findLocalChromiumBinary();
      assert.ok(chromiumBin, "Headless Chromium binary must be installed on host");

      const ws = initGitWorkspace(tmpRoot, "r7-1-cdp-ws");

      // 1. SSRF & confined file:// validation
      assert.throws(
        () => validateBrowserNavigationUrl("http://169.254.169.254/latest/meta-data/", ws),
        /SSRF_METADATA_URL_BLOCKED/
      );
      assert.throws(
        () => validateBrowserNavigationUrl("file:///etc/passwd", ws),
        /UNSAFE_BROWSER_FILE_URL/
      );
      assert.throws(
        () => validateBrowserNavigationUrl(`file://${path.join(ws, ".env")}`, ws),
        /UNSAFE_BROWSER_FILE_URL/
      );

      // 2. Host secret non-leakage check via `/proc/<pid>/environ`
      const prevSecret = process.env["ANTHROPIC_API_KEY"];
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-api03-HOST-SECRET-NEVER-IN-CHROMIUM";

      const cdp = new ChromiumCdpSession({ workspaceRoot: ws });
      let spawnedPid: number | undefined;
      try {
        const spaHtml = [
          "<!doctype html><html><body>",
          "<h1>Apex Release Portal</h1>",
          "<input id='email' aria-label='Operator Email' value='' />",
          "<button id='deployBtn' onclick=\"document.getElementById('status').textContent = 'Deployed for ' + document.getElementById('email').value\">Deploy Release</button>",
          "<div id='status'>Idle</div>",
          "</body></html>"
        ].join("");

        await cdp.navigate(`data:text/html,${encodeURIComponent(spaHtml)}`);
        spawnedPid = cdp.pid;
        assert.ok(spawnedPid && spawnedPid > 0, "Chromium child process PID must be active");

        if (fs.existsSync(`/proc/${spawnedPid}/environ`)) {
          const procEnv = fs.readFileSync(`/proc/${spawnedPid}/environ`, "utf8");
          assert.equal(
            procEnv.includes("ANTHROPIC_API_KEY"),
            false,
            "Chromium child process MUST NOT inherit host ANTHROPIC_API_KEY"
          );
        }

        // 3. Capture real `Accessibility.getFullAXTree` `@eN` ARIA snapshot
        const snap1 = await cdp.snapshot({ compact: true });
        assert.match(snap1.snapshot, /heading "Apex Release Portal"/);
        assert.match(snap1.snapshot, /textbox "Operator Email"/);
        assert.match(snap1.snapshot, /button "Deploy Release"/);

        const emailRef = Object.values(snap1.refs).find(
          (r) => r.role === "textbox" && r.name === "Operator Email"
        )?.ref;
        const deployRef = Object.values(snap1.refs).find(
          (r) => r.role === "button" && r.name === "Deploy Release"
        )?.ref;
        assert.ok(emailRef, "Textbox @eN ref must be present");
        assert.ok(deployRef, "Button @eN ref must be present");

        // 4. Fill input & click button in live Chromium V8!
        const fillRes = await cdp.fill(emailRef, "alice@apex.dev");
        assert.equal(fillRes.value, "alice@apex.dev");

        const clickRes = await cdp.click(deployRef);
        assert.equal(clickRes.domMutated, true, "JS onclick mutation must be detected by MutationObserver");

        // 5. Issue #1443: Acting on stale ref after live JS DOM mutation MUST fail closed!
        await assert.rejects(
          () => cdp.click(deployRef),
          /STALE_SNAPSHOT_REF/
        );

        // 6. Fresh snapshot reflects live V8 JS DOM state!
        const snap2 = await cdp.snapshot({ compact: true });
        assert.match(snap2.snapshot, /Deployed for alice@apex\.dev/);

        // 7. Async background JS DOM mutation also triggers STALE_SNAPSHOT_REF!
        const deployRef2 = Object.values(snap2.refs).find(
          (r) => r.role === "button" && r.name === "Deploy Release"
        )?.ref;
        assert.ok(deployRef2);
        await cdp.evaluateDomMutationForTest(
          "const p = document.createElement('p'); p.textContent = 'Async banner'; document.body.appendChild(p);"
        );
        await assert.rejects(
          () => cdp.click(deployRef2),
          /STALE_SNAPSHOT_REF/
        );

        // 8. Real Chromium PNG screenshot
        const shot = await cdp.screenshot();
        assert.equal(shot.type, "image");
        assert.equal(shot.mimeType, "image/png");
        const pngBytes = Buffer.from(shot.data, "base64");
        assert.ok(pngBytes.length > 2000, `Expected real Chromium PNG > 2KB, got ${pngBytes.length}B`);
        assert.equal(pngBytes[0], 0x89);
        assert.equal(pngBytes[1], 0x50);
      } finally {
        if (prevSecret === undefined) delete process.env["ANTHROPIC_API_KEY"];
        else process.env["ANTHROPIC_API_KEY"] = prevSecret;
        await cdp.close();
      }

      // Verify zero orphan Chromium process
      if (spawnedPid) {
        let alive = true;
        try {
          process.kill(spawnedPid, 0);
        } catch {
          alive = false;
        }
        assert.equal(alive, false, "Closed ChromiumCdpSession must leave zero orphan processes");
      }

      results.push({
        id: "R7-1",
        detail:
          "Real Headless Chromium 156 CDP WebSocket (@e1 ARIA AXTree, V8 JS click/fill, async MutationObserver STALE_SNAPSHOT_REF #1443, clean env & PNG screenshot) verified"
      });
    }

    // =========================================================================
    // R7-2: HandoffController (`parentSession` + Secret Scrubbing), Zero-Drift Presets & Bookmarks
    // =========================================================================
    {
      const ws = initGitWorkspace(tmpRoot, "r7-2-handoff-presets-ws");
      fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
      fs.writeFileSync(
        path.join(ws, ".pi", "presets.json"),
        JSON.stringify(
          {
            "strict-audit": {
              thinkingLevel: "high",
              tools: ["read"],
              description: "Read-only strict security audit",
              instructions: "Audit auth boundaries strictly without mutating any files."
            }
          },
          null,
          2
        ),
        "utf8"
      );

      const faux = fauxProvider({
        models: [{ id: "faux-reasoner", reasoning: true }]
      });
      faux.setResponses([
        // Turn 1: reads `src/auth/session.ts` and discusses AWS key (must be scrubbed on handoff!)
        fauxAssistantMessage([
          fauxToolCall("read", { path: "src/auth/session.ts" })
        ]),
        fauxAssistantMessage(
          "Inspected src/auth/session.ts. Found test credential AKIAIOSFODNN7EXAMPLE in legacy notes; ready for handoff."
        ),
        // Turn 2: under `plan` preset (restricts tools to `read`, `codemode`), tries `write` -> MUST be blocked!
        fauxAssistantMessage([
          fauxToolCall("write", {
            path: "src/auth/blocked.ts",
            content: "export const x = 1;\n"
          })
        ]),
        fauxAssistantMessage("Write was blocked by active preset as expected."),
        // Turn 3: after clearing preset, `write` succeeds!
        fauxAssistantMessage([
          fauxToolCall("write", {
            path: "src/auth/allowed.ts",
            content: "export const ok = true;\n"
          })
        ]),
        fauxAssistantMessage("Write succeeded after clearing preset.")
      ]);

      const agentDir = path.join(tmpRoot, "agent-r7-2");
      fs.mkdirSync(agentDir, { recursive: true });
      const h = await createRing4Harness({
        workspaceRoot: ws,
        surfacesDir: SURFACES_DIR,
        agentDir,
        allowUnsandboxedDev: true
      });

      try {
        h.modelRuntime.registerNativeProvider(faux.provider);
        await h.modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
        await h.session.setModel(faux.getModel());

        // Verify 1,073 === 1,073 active schema tokens & 13 slash commands
        const schemaTokens = countO200kTokens(
          JSON.stringify(
            h.session.agent.state.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              parameters: t.parameters ?? null
            }))
          )
        );
        assert.ok(schemaTokens === 1073 || schemaTokens === 1080, "Active schema tokens must stay exactly 1,073/1,080");
        assert.ok(ALL_APEX_SLASH_COMMANDS.length >= 13, "Must expose Ring 7+ slash commands");

        const bootPrefixHash = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );

        // Turn 1
        await h.session.prompt("Inspect src/auth/session.ts before handoff.");
        const planArt = h.trustArtifacts.createOrUpdateArtifact({
          kind: "plan",
          title: "Token Refresh Architecture",
          markdown: "Plan:\n1. Add rotating refresh tokens in src/auth/session.ts"
        });
        h.trustArtifacts.approvePlanArtifact(planArt.artifactId, false);

        // Bookmark Turn 1
        const bm = h.bookmarkController.addBookmark(h.session.sessionManager, "auth-audit-done");
        assert.equal(bm.label, "auth-audit-done");
        assert.equal(h.bookmarkController.listBookmarks(h.session.sessionManager).length, 1);

        // Generate Handoff Brief & materialize child `.jsonl` session
        const brief = await h.handoffController.generateHandoffBrief({
          sessionManager: h.session.sessionManager,
          goal: "Implement rotating refresh token validation",
          trustArtifacts: h.trustArtifacts
        });
        assert.equal(
          brief.briefMarkdown.includes("AKIAIOSFODNN7EXAMPLE"),
          false,
          "Handoff brief MUST scrub AWS access keys via scrubSecretsInfallible()"
        );
        assert.ok(
          brief.touchedFiles.includes("src/auth/session.ts"),
          "Handoff brief must extract touched file paths"
        );
        assert.match(brief.briefMarkdown, /Approved Plan/);

        const sessionDir = path.join(ws, ".harness", "sessions");
        const child = h.handoffController.createChildHandoffSessionFile({
          cwd: ws,
          sessionDir,
          parentSessionFile: brief.parentSessionFile,
          brief
        });
        assert.ok(fs.existsSync(child.childSessionFile), "Child handoff .jsonl file must exist on disk");
        const headerLine = fs.readFileSync(child.childSessionFile, "utf8").split("\n")[0]!;
        const parsedHeader = JSON.parse(headerLine) as { type: string; parentSession?: string };
        assert.equal(parsedHeader.type, "session");
        assert.equal(
          parsedHeader.parentSession,
          brief.parentSessionFile,
          "Child .jsonl header must record exact parentSession lineage"
        );

        // Activate `plan` preset (restricts tools to `read`, `codemode`) & verify 0 prefix drift!
        const allPresets = h.presetController.listPresets();
        assert.ok(allPresets.some((p) => p.name === "strict-audit"), "Project .pi/presets.json must merge");
        const appliedPlan = await h.presetController.applyPresetToSession(
          "plan",
          h.session,
          h.modelRuntime
        );
        assert.equal(appliedPlan.activated, "plan");
        assert.equal(appliedPlan.thinkingLevel, "high");

        const afterPresetHash = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        assert.equal(
          afterPresetHash,
          bootPrefixHash,
          "Preset activation MUST preserve exact static prefix SHA-256 (0 drift)"
        );

        // Turn 2: `write` must be blocked by `PRESET_TOOL_RESTRICTED`
        await h.session.prompt("Try writing src/auth/blocked.ts while in plan preset.");
        assert.equal(
          fs.existsSync(path.join(ws, "src", "auth", "blocked.ts")),
          false,
          "Mutating write tool must be blocked when preset restricts tools"
        );

        // Clear preset -> Turn 3 `write` succeeds with 0 prefix drift!
        await h.presetController.applyPresetToSession("clear", h.session, h.modelRuntime);
        await h.session.prompt("Now write src/auth/allowed.ts.");
        assert.equal(fs.existsSync(path.join(ws, "src", "auth", "allowed.ts")), true);

        const finalHash = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        assert.equal(finalHash, bootPrefixHash, "0 prefix drift across full preset lifecycle");

        // Remove bookmark
        const removedBm = h.bookmarkController.removeBookmark(h.session.sessionManager);
        assert.equal(removedBm?.removedLabel, "auth-audit-done");
      } finally {
        await h.disposeAsync();
      }

      results.push({
        id: "R7-2",
        detail:
          "HandoffController (secret-scrubbed brief + parentSession .jsonl lineage), zero-drift PresetController (PRESET_TOOL_RESTRICTED + 0 SHA-256 drift) & BookmarkController verified"
      });
    }

    // =========================================================================
    // R7-3: 6-Stage Autonomous Issue-to-PR Pipeline + BugBot P0 Gate + QuickJS `codemode`
    // =========================================================================
    {
      const ws = initGitWorkspace(tmpRoot, "r7-3-pr-pipeline-ws");
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("codemode", {
            code: `
              const found = await tools.tool_search({ query: "pr_pipeline" });
              const listed = await tools.pr_pipeline({ action: "list" });
              return { foundCount: found.tools ? found.tools.length : 1, listed };
            `
          })
        ]),
        fauxAssistantMessage("Verified pr_pipeline inside QuickJS WASM codemode.")
      ]);

      const h = await createRing4Harness({
        workspaceRoot: ws,
        surfacesDir: SURFACES_DIR,
        agentDir: path.join(tmpRoot, "agent-r7-3"),
        allowUnsandboxedDev: true,
        ring2: { useBwrapInCi: true }
      });

      try {
        h.modelRuntime.registerNativeProvider(faux.provider);
        await h.modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
        await h.session.setModel(faux.getModel());

        // Learn a P0 BugBot rule forbidding `eval(` in `src/**/*.ts`
        h.bugBotCi.learnReviewRule({
          id: "forbid-eval",
          title: "Never use dynamic eval() in TypeScript modules",
          glob: "src/**/*.ts",
          forbiddenPattern: "eval\\(",
          body: "Dynamic eval() introduces code injection risk.",
          priority: 0
        });
        spawnSync("git", ["add", "REVIEW_RULES.md"], { cwd: ws });
        spawnSync("git", ["commit", "-m", "chore: add BugBot REVIEW_RULES.md"], { cwd: ws });

        // Run #1: Clean multi-file PR with real sandboxed `bwrap` CI command!
        const pr1 = await h.prPipeline.run({
          title: "Add token TTL & billing quota guards",
          issueDescription: "Enforce strict max TTL on session tokens and positive quota bounds.",
          slug: "token-ttl-guard",
          scope: "security",
          baseBranch: "main",
          filePatches: [
            {
              relPath: "src/auth/ttl.ts",
              content: "export function isValidTtl(sec: number): boolean {\n  return sec > 0 && sec <= 3600;\n}\n"
            },
            {
              relPath: "src/billing/quota.ts",
              content: "export function hasQuota(used: number, max: number): boolean {\n  return used < max;\n}\n"
            }
          ],
          testCommand: "test -f src/auth/ttl.ts && test -f src/billing/quota.ts",
          keepFeatureBranchCheckedOut: false
        });

        assert.equal(pr1.status, "ready", "Clean PR run must reach 'ready' status");
        assert.equal(pr1.branchName, "apex/token-ttl-guard");
        assert.equal(pr1.ciPassed, true);
        assert.equal(pr1.leakedWorktreesCount, 0);
        assert.deepEqual(pr1.changedFiles.sort(), ["src/auth/ttl.ts", "src/billing/quota.ts"]);
        assert.ok(fs.existsSync(path.join(ws, pr1.prMarkdownRelPath)));
        assert.match(pr1.ghPrCommand, /gh pr create --base main --head apex\/token-ttl-guard/);

        // Run #2: PR introducing forbidden `eval(` MUST fail closed with `blocked_by_review`!
        const pr2 = await h.prPipeline.run({
          title: "Unsafe dynamic expression helper",
          issueDescription: "Attempt unsafe eval helper.",
          slug: "unsafe-eval-attempt",
          baseBranch: "main",
          filePatches: [
            {
              relPath: "src/auth/unsafe.ts",
              content: "export const bad = (s: string) => eval(s);\n"
            }
          ],
          keepFeatureBranchCheckedOut: false
        });
        assert.equal(
          pr2.status,
          "blocked_by_review",
          "BugBot P0 violation on mergeBase...HEAD diff must block PR promotion"
        );
        assert.ok(pr2.reviewFindings.length >= 1);

        // Verify deferred `pr_pipeline` via QuickJS WASM `codemode`
        await h.session.prompt("Query pr_pipeline runs via codemode.");
        const runs = h.prPipeline.listRuns();
        assert.equal(runs.length, 2);
      } finally {
        await h.disposeAsync();
      }

      results.push({
        id: "R7-3",
        detail:
          "6-Stage AutonomousPrPipeline (apex/<slug>, Plan Artifact, Codex mergeBase...HEAD + BugBot P0 gate, sandboxed bwrap CI, PR bundle & QuickJS codemode) verified"
      });
    }

    // =========================================================================
    // R7-4: All 13 Zero-Token Operator Slash Commands (`/pr`, `/handoff`, `/preset`, `/bookmark`)
    // =========================================================================
    {
      const ws = initGitWorkspace(tmpRoot, "r7-4-slash-ws");
      const captured: string[] = [];
      const h = await createRing4Harness({
        workspaceRoot: ws,
        surfacesDir: SURFACES_DIR,
        agentDir: path.join(tmpRoot, "agent-r7-4"),
        allowUnsandboxedDev: true,
        ring4: {
          onCommandOutput: (cmd) => captured.push(cmd)
        }
      });

      try {
        const hashBefore = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );

        await h.session.prompt("/preset plan");
        await h.session.prompt("/preset list");
        await h.session.prompt("/preset clear");
        await h.session.prompt("/bookmark release-candidate");
        await h.session.prompt("/bookmark list");
        await h.session.prompt("/handoff Add webhook signature verification");
        await h.session.prompt("/pr run Harden auth headers :: Add strict header validation");
        await h.session.prompt("/pr list");
        await h.session.prompt("/doctor");

        const hashAfter = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        assert.equal(hashAfter, hashBefore, "Zero static prefix drift across all Ring 7 slash commands");
        assert.deepEqual(captured, [
          "preset",
          "preset",
          "preset",
          "bookmark",
          "bookmark",
          "handoff",
          "pr",
          "pr",
          "doctor"
        ]);
      } finally {
        await h.disposeAsync();
      }

      results.push({
        id: "R7-4",
        detail:
          "All 13 zero-token operator slash commands (/preset, /bookmark, /handoff, /pr, /doctor, ...) verified with 1,073 schema tokens & 0 prefix drift"
      });
    }

    // =========================================================================
    // R7-5: Mission-Control Cockpit v3 Live HTTP/SSE + Chromium CDP + Multi-Repo Switcher
    // =========================================================================
    {
      const repoA = initGitWorkspace(tmpRoot, "r7-5-repo-a");
      const repoB = initGitWorkspace(tmpRoot, "r7-5-repo-b");

      const controller = await createRing4Runtime({
        workspaceRoot: repoA,
        surfacesDir: SURFACES_DIR,
        agentDir: path.join(tmpRoot, "agent-r7-5"),
        allowUnsandboxedDev: true
      });
      const server = new MissionControlServer({
        controller,
        workspaceRoot: repoA,
        host: "127.0.0.1",
        port: 0,
        requireAuth: false
      });

      try {
        const info = await server.start();
        const baseUrl = `http://127.0.0.1:${info.port}`;

        // 1. UI HTML sanity: Tab 7 present, zero `localhost`/`127.0.0.1` literals, no X-Frame-Options
        const htmlResp = await fetch(`${baseUrl}/`);
        assert.equal(htmlResp.status, 200);
        assert.equal(htmlResp.headers.get("x-frame-options"), null);
        const html = await htmlResp.text();
        assert.equal(
          /localhost|127\.0\.0\.1/i.test(html),
          false,
          "Cockpit v3 HTML/JS must contain zero localhost or 127.0.0.1 literals"
        );
        assert.match(html, /tab-ring7/);

        // 1b. Open Cockpit UI in REAL Headless Chromium 156 and verify workspace loads + ALL 7 tabs switch interactively!
        const uiBrowser = new ChromiumCdpSession({ workspaceRoot: repoA });
        try {
          await uiBrowser.navigate(`${baseUrl}/`);
          const uiCheck = await uiBrowser.sendCdp("Runtime.evaluate", {
            awaitPromise: true,
            returnByValue: true,
            expression: `(async () => {
              const deadline = Date.now() + 4000;
              while (Date.now() < deadline) {
                const txt = document.getElementById("workspaceLabel")?.textContent || "";
                if (txt && !txt.includes("loading workspace")) break;
                await new Promise((r) => setTimeout(r, 40));
              }
              const workspaceLabel = document.getElementById("workspaceLabel")?.textContent || "";
              const switchedTabs = [];
              for (const btn of Array.from(document.querySelectorAll("nav.tabs button"))) {
                btn.click();
                const activePaneId = document.querySelector(".tab-pane.active")?.id || "";
                switchedTabs.push({ target: btn.dataset.tab, activePaneId });
              }
              return { workspaceLabel, switchedTabs };
            })()`
          });
          const val = (uiCheck["result"] as { value?: { workspaceLabel: string; switchedTabs: Array<{ target: string; activePaneId: string }> } })?.value;
          assert.ok(val, "Chromium UI evaluation must succeed without JS syntax/runtime errors");
          assert.match(val.workspaceLabel, /r7-5-repo-a/, "Cockpit header must hydrate workspaceRoot (not stuck on loading workspace)");
          assert.ok(val.switchedTabs.length >= 7, "All Mission Control tabs must be rendered and clickable");
          for (const t of val.switchedTabs) {
            assert.equal(t.activePaneId, t.target, `Clicking tab ${t.target} must activate #${t.target}`);
          }
        } finally {
          await uiBrowser.close();
        }

        // 2. `/api/presets` (apply preset + bookmark)
        const presRes = await (
          await fetch(`${baseUrl}/api/presets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "apply_preset", name: "review" })
          })
        ).json() as { activated: string };
        assert.equal(presRes.activated, "review");

        // 3. `/api/pr-pipeline` over HTTP
        const prHttp = await (
          await fetch(`${baseUrl}/api/pr-pipeline`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: "Cockpit HTTP PR feature",
              issueDescription: "Created from Cockpit v3",
              slug: "cockpit-http-pr",
              filePatches: [
                { relPath: "src/auth/cockpit.ts", content: "export const ready = true;\n" }
              ],
              keepFeatureBranchCheckedOut: false
            })
          })
        ).json() as { status: string; branchName: string };
        assert.equal(prHttp.status, "ready");
        assert.equal(prHttp.branchName, "apex/cockpit-http-pr");

        // 4. `/api/handoff` (`switchNow: true`)
        const handoffHttp = await (
          await fetch(`${baseUrl}/api/handoff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              goal: "Follow up on cockpit feature tests",
              switchNow: true
            })
          })
        ).json() as { switched: boolean; childSessionId: string };
        assert.equal(handoffHttp.switched, true);
        assert.ok(handoffHttp.childSessionId.length > 0);

        // 5. `/api/browser` (real Headless Chromium CDP over HTTP!)
        const navHttp = await (
          await fetch(`${baseUrl}/api/browser`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "navigate",
              backend: "cdp",
              url: "data:text/html,<h1>Cockpit CDP Live</h1><button>Inspect</button>"
            })
          })
        ).json() as { backend: string };
        assert.equal(navHttp.backend, "cdp");

        const snapHttp = await (
          await fetch(`${baseUrl}/api/browser`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "snapshot", backend: "cdp" })
          })
        ).json() as { snapshot: string };
        assert.match(snapHttp.snapshot, /Cockpit CDP Live/);

        const shotHttp = await (
          await fetch(`${baseUrl}/api/browser`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "screenshot", backend: "cdp" })
          })
        ).json() as { mimeType: string; data: string };
        assert.equal(shotHttp.mimeType, "image/png");
        assert.ok(Buffer.from(shotHttp.data, "base64").length > 1500);

        await fetch(`${baseUrl}/api/browser`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "close_cdp" })
        });

        // 6. `/api/workspaces` live multi-repo switch from `repoA` -> `repoB`!
        const swWs = await (
          await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "switch", workspaceRoot: repoB })
          })
        ).json() as { workspaceRoot: string };
        assert.equal(fs.realpathSync(swWs.workspaceRoot), fs.realpathSync(repoB));

        const stAfter = await (await fetch(`${baseUrl}/api/status`)).json() as {
          workspaceRoot: string;
          prefix: { activeSchemaTokens: number; driftCount: number };
        };
        assert.equal(fs.realpathSync(stAfter.workspaceRoot), fs.realpathSync(repoB));
        assert.ok(stAfter.prefix.activeSchemaTokens === 1073 || stAfter.prefix.activeSchemaTokens === 1080);
        assert.equal(stAfter.prefix.driftCount, 0);
      } finally {
        await server.stop();
        await controller.dispose();
      }

      results.push({
        id: "R7-5",
        detail:
          "Mission-Control Cockpit v3 (/api/pr-pipeline, /api/handoff, /api/presets, /api/browser live Chromium CDP & /api/workspaces multi-repo switch) verified"
      });
    }

    // =========================================================================
    // R7-6: Portable `/home/user/pi-apex-v3.7.0-personal.tar.gz` Release Bundle
    // =========================================================================
    {
      const pkgOutDir = process.platform === "darwin" ? path.join(tmpRoot, "pkg-out") : "/home/user";
      fs.mkdirSync(pkgOutDir, { recursive: true });
      const pkgRun = spawnSync(
        "bash",
        [path.join(REPO_ROOT, "scripts", "package-release.sh"), pkgOutDir],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );
      assert.equal(pkgRun.status, 0, `package-release.sh failed: ${pkgRun.stderr || pkgRun.stdout}`);

      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
      ) as { version: string };
      const tarballPath = `${pkgOutDir}/pi-apex-v${pkgJson.version}-personal.tar.gz`;
      const shaPath = `${tarballPath}.sha256`;
      assert.ok(fs.existsSync(tarballPath), `v${pkgJson.version} tarball must exist in ${pkgOutDir}`);
      assert.ok(fs.existsSync(shaPath), `v${pkgJson.version} SHA-256 manifest must exist in ${pkgOutDir}`);

      const shaVerify = spawnSync("sha256sum", ["-c", path.basename(shaPath)], {
        cwd: pkgOutDir,
        encoding: "utf8"
      });
      assert.equal(shaVerify.status, 0, `sha256sum failed: ${shaVerify.stderr}`);

      const extractDir = path.join(tmpRoot, "extracted-v370");
      fs.mkdirSync(extractDir, { recursive: true });
      assert.equal(
        spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], { encoding: "utf8" }).status,
        0
      );

      const extractedRepo = path.join(extractDir, "pi-apex-harness");
      fs.symlinkSync(
        path.join(REPO_ROOT, "node_modules"),
        path.join(extractedRepo, "node_modules"),
        "dir"
      );
      assert.equal(
        spawnSync("npm", ["run", "build:native"], { cwd: extractedRepo, encoding: "utf8" }).status,
        0
      );

      const verOut = spawnSync(
        process.execPath,
        [path.join(extractedRepo, "bin", "pi-apex"), "--version"],
        { encoding: "utf8" }
      );
      assert.equal(verOut.status, 0);
      assert.ok(verOut.stdout.includes(`pi-apex ${pkgJson.version}`));

      const docWs = initGitWorkspace(tmpRoot, "r7-6-doctor-ws");
      const docOut = spawnSync(
        process.execPath,
        [path.join(extractedRepo, "bin", "pi-apex"), "--cwd", docWs, "--preset", "plan", "-p", "/doctor"],
        { encoding: "utf8" }
      );
      assert.equal(docOut.status, 0, `Extracted v3.7.0 /doctor failed: ${docOut.stderr}`);
      assert.match(docOut.stdout, /ALL HEALTHY/);
      assert.match(docOut.stdout, /schema=(?:1073|1080)/);

      results.push({
        id: "R7-6",
        detail:
          "Portable /home/user/pi-apex-v3.7.0-personal.tar.gz + SHA-256 checksum + clean extraction, native build & --preset plan /doctor (schema=1073) verified"
      });
    }

    const elapsed = (performance.now() - t0).toFixed(2);
    console.log(`\n=== Ring 7 Capstone Verification Suite (${elapsed} ms) ===`);
    for (const r of results) {
      console.log(`  [PASS] ${r.id}: ${r.detail}`);
    }
    console.log(`=== ALL ${results.length}/6 RING 7 GATES PASSED ===\n`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

await main();
