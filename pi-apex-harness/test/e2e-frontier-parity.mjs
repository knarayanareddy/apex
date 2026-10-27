import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MerkleCodeIndex,
  TrustArtifactManager,
  ScopedRulesAndWorktreeManager,
  AdaptiveReviewAndCiController,
  AutonomyGovernanceController
} from "../src/frontier-parity.mjs";

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-frontier-"));
  const results = [];

  try {
    // 1. Cursor + Devin: Incremental Merkle-Tree Code Index + DeepWiki Repo Map
    const srcAuthDir = path.join(tmpRoot, "src", "auth");
    const srcApiDir = path.join(tmpRoot, "src", "api");
    fs.mkdirSync(srcAuthDir, { recursive: true });
    fs.mkdirSync(srcApiDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcAuthDir, "sessionGrant.ts"),
      `export function rotateSessionGrant(userId: string) {\n  return "grant_" + userId;\n}\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(srcApiDir, "middleware.ts"),
      `import { rotateSessionGrant } from "../auth/sessionGrant";\nexport function verifyRequest(u: string) {\n  return rotateSessionGrant(u);\n}\n`,
      "utf8"
    );

    const codeIndex = new MerkleCodeIndex(tmpRoot);
    const sync1 = codeIndex.sync();
    assert.equal(sync1.reindexedFiles, 2);
    assert.equal(sync1.skippedUnchangedFiles, 0);

    // Modify only 1 file -> Merkle sync must skip unchanged file
    fs.appendFileSync(path.join(srcApiDir, "middleware.ts"), `\n// updated comment\n`, "utf8");
    const sync2 = codeIndex.sync();
    assert.equal(sync2.reindexedFiles, 1);
    assert.equal(sync2.skippedUnchangedFiles, 1);

    const hits = codeIndex.search("session grant rotate");
    assert.equal(hits[0].symbol, "rotateSessionGrant");
    const wiki = codeIndex.generateDeepWikiMap();
    assert.ok(wiki.includes("`rotateSessionGrant`") && wiki.includes("src/api/middleware.ts"));
    results.push("1. MerkleCodeIndex + DeepWiki symbol centrality map: PASS");

    // 2. Antigravity + Devin 2.0: Pre-Flight Interactive Plan + Trust Artifacts + Inline Comments
    const artifactMgr = new TrustArtifactManager(path.join(tmpRoot, ".harness", "artifacts"), "agent_decides");
    const gateHighRisk = artifactMgr.evaluatePreFlight({
      taskPrompt: "Migrate auth tokens",
      touchedFilesEstimate: 4,
      touchesAuthOrSchema: true,
      confidence: 0.82
    });
    assert.equal(gateHighRisk.requiresApprovalBeforeEdit, true);

    const plan = artifactMgr.writeImplementationPlan({
      title: "JWT Refresh Rotation",
      filesToModify: ["src/auth/sessionGrant.ts", "src/api/middleware.ts"],
      steps: ["Add refresh token rotation", "Update middleware header parser"],
      verificationPlan: ["npm test", "QA browser login flow"]
    });
    assert.ok(fs.existsSync(plan.artifactPath));

    const inlineSteer = artifactMgr.addInlineComment({
      artifactName: "implementation_plan.md",
      lineNumber: 7,
      selectedText: "Update middleware header parser",
      comment: "Preserve backward compatibility with legacy X-Session-Token header"
    });
    assert.ok(inlineSteer.steerMessage.includes("X-Session-Token"));

    const walkthrough = artifactMgr.writeWalkthrough({
      summary: "Implemented dual-header JWT rotation",
      gitDiffStat: "2 files changed, 34 insertions(+), 4 deletions(-)",
      testCommand: "npm test",
      testPassed: true,
      screenshots: [".harness/media/login_after.png"]
    });
    assert.equal(walkthrough.verified, true);
    results.push("2. Antigravity Trust Artifacts + Inline Comment Steering + Devin Pre-Flight Gate: PASS");

    // 3. Codex + Cursor: Cache-Safe Scoped AGENTS.md / .mdc Rules + Worktree .git & Dependency Bootstrap
    fs.writeFileSync(path.join(srcAuthDir, "AGENTS.md"), "Never log raw session tokens in src/auth.", "utf8");
    const scopedMgr = new ScopedRulesAndWorktreeManager(tmpRoot);
    scopedMgr.registerMdcRule({
      id: "strict-ts-api",
      globPattern: "src/api/**/*.ts",
      content: "All API handlers must validate inputs with Zod."
    });

    const authRules1 = scopedMgr.resolveTailRulesForFile("src/auth/sessionGrant.ts");
    const authRules2 = scopedMgr.resolveTailRulesForFile("src/auth/sessionGrant.ts");
    assert.equal(authRules1.length, 1);
    assert.equal(authRules2.length, 0, "Must deduplicate tail rule injection to prevent context bloat");

    const apiRules = scopedMgr.resolveTailRulesForFile("src/api/middleware.ts");
    assert.equal(apiRules.length, 1);
    assert.ok(apiRules[0].includes("Zod"));

    // Verify worktree .git mount + node_modules symlink snapshot
    fs.mkdirSync(path.join(tmpRoot, ".git", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".git", "worktrees", "wt-1"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "node_modules", "zod"), { recursive: true });
    const wtDir = path.join(tmpRoot, ".worktrees", "wt-1");
    fs.mkdirSync(wtDir, { recursive: true });

    const wtEnv = scopedMgr.prepareWorktreeEnvironment({
      mainRepoDir: tmpRoot,
      worktreeDir: wtDir,
      worktreeName: "wt-1"
    });
    assert.ok(wtEnv.writableMounts.some((p) => p.endsWith(".git/worktrees/wt-1")));
    assert.ok(wtEnv.readOnlyMounts.some((p) => p.endsWith(".git/hooks")));
    assert.deepEqual(wtEnv.linkedDependencySnapshots, ["node_modules"]);
    assert.ok(fs.lstatSync(path.join(wtDir, "node_modules")).isSymbolicLink());
    results.push("3. Cache-Safe Scoped AGENTS.md/.mdc Rules + Worktree .git & CoW Dep Snapshot: PASS");

    // 4. Cursor BugBot + Devin Review: Self-Learning Review Rules + Closed-Loop CI Autofix
    const reviewCtrl = new AdaptiveReviewAndCiController(path.join(tmpRoot, "surfaces", "REVIEW_RULES.md"));
    reviewCtrl.recordReviewFeedback({
      patternKey: "intentional-sync-fs-in-cli-boot",
      humanAction: "dismissed_false_positive",
      explanation: "Sync fs.readFileSync at CLI startup is intentional."
    });
    const afterSecondDismissal = reviewCtrl.recordReviewFeedback({
      patternKey: "intentional-sync-fs-in-cli-boot",
      humanAction: "dismissed_false_positive",
      explanation: "Sync fs.readFileSync at CLI startup is intentional."
    });
    assert.equal(afterSecondDismissal.learnedRulesCount, 1);
    assert.ok(afterSecondDismissal.rules[0].startsWith("SUPPRESS_FALSE_POSITIVE"));

    let ciState = "failed";
    const ciLoop = await reviewCtrl.runCiAutofixLoop({
      pollCiFn: async () =>
        ciState === "failed"
          ? { status: "failed", failingCheck: "unit-tests", logExcerpt: "Expected 200, got 401" }
          : { status: "success" },
      applyFixFn: async () => {
        ciState = "success";
      }
    });
    assert.equal(ciLoop.converged, true);
    assert.equal(ciLoop.attempts, 2);
    results.push("4. BugBot Self-Learning Review Rules + Devin Closed-Loop CI Autofix: PASS");

    // 5. Claude Cowork + Codex: Boundary Escalation + Unattended Routine Guard + Outcomes Rubric
    const interactiveGov = new AutonomyGovernanceController({
      approvalPolicy: "on-request",
      unattendedRoutine: false
    });
    const pauseRes = interactiveGov.authorizeBoundaryCrossing({
      actionType: "network_egress",
      target: "registry.npmjs.org/new-pkg",
      isInsideSandboxAllowlist: false
    });
    assert.equal(pauseRes.decision, "PAUSE_FOR_USER_APPROVAL");

    const unattendedGov = new AutonomyGovernanceController({
      approvalPolicy: "on-request",
      unattendedRoutine: true
    });
    const cronBlock = unattendedGov.authorizeBoundaryCrossing({
      actionType: "external_mutation",
      target: "slack.postMessage(#announcements)",
      isInsideSandboxAllowlist: true,
      isExternalMutation: true
    });
    assert.equal(cronBlock.decision, "DENY_UNATTENDED");

    const rubric = interactiveGov.evaluateOutcomeRubric(
      [
        { id: "tests", criterion: "All unit tests pass", check: (ev) => ev.testsPassed === true },
        { id: "walkthrough", criterion: "Walkthrough artifact emitted", check: (ev) => Boolean(ev.walkthroughPath) }
      ],
      { testsPassed: true, walkthroughPath: walkthrough.artifactPath }
    );
    assert.equal(rubric.passedAll, true);
    assert.equal(rubric.score, "2/2");
    results.push("5. Cowork/Codex Boundary Approval + Unattended Cron Safety + Outcomes Rubric: PASS");

    console.log(JSON.stringify({ allFrontierParityPassed: true, checks: results }, null, 2));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
