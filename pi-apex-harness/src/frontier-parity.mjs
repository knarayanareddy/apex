/**
 * Pi-Apex Frontier Parity Subsystems (v1.2)
 * Closes the architectural gaps identified in the 5-way comparative audit against:
 *   1. Cursor 3.5     -> MerkleCodeIndex + Path-Scoped .mdc Rules + Learned BugBot Rules + Shadow Edit Check
 *   2. Google Antigravity 2.0 -> TrustArtifactManager (Plan/Task/Walkthrough + Inline Anchored Comments)
 *   3. Cognition Devin 2.x    -> InteractivePreFlightGate + Worktree Dependency Snapshotter + PR/CI Autofix Loop
 *   4. OpenAI Codex 0.162     -> Hierarchical AGENTS.md Cascade + Worktree .git Mount Fix + 3-Tier ApprovalPolicy
 *   5. Claude Cowork (2026)   -> Safe Unattended Scheduled Routines + Outcomes Rubric Grader
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ============================================================================
// 1. CURSOR + DEVIN: Incremental Merkle-Tree Codebase Index + Symbol Repo-Map
// ============================================================================
export class MerkleCodeIndex {
  constructor(rootDir, ignoreDirs = new Set([".git", "node_modules", ".harness", "dist", "build"])) {
    this.rootDir = rootDir;
    this.ignoreDirs = ignoreDirs;
    this.fileHashes = new Map();     // relPath -> sha256
    this.dirHashes = new Map();      // relDir  -> merkle sha256
    this.chunks = new Map();         // relPath -> Array<{ symbol, kind, startLine, endLine, text, tokens }>
    this.symbolGraph = new Map();    // symbol  -> { definedIn, referencedIn: Set<relPath> }
  }

  /**
   * Incrementally syncs the workspace using directory Merkle hashes.
   * Only re-chunks files whose SHA-256 changed since the last sync.
   */
  sync() {
    const seenFiles = new Set();
    let reindexedFiles = 0;
    let skippedUnchangedFiles = 0;

    const walk = (absDir, relDir = "") => {
      const entries = fs.readdirSync(absDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      const childHashes = [];

      for (const entry of entries) {
        if (this.ignoreDirs.has(entry.name)) continue;
        const absPath = path.join(absDir, entry.name);
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          const subHash = walk(absPath, relPath);
          childHashes.push(`D:${entry.name}:${subHash}`);
        } else if (entry.isFile() && /\.(m?js|ts|tsx|py|rs|go|md)$/i.test(entry.name)) {
          seenFiles.add(relPath);
          const content = fs.readFileSync(absPath, "utf8");
          const fHash = sha256(content);
          childHashes.push(`F:${entry.name}:${fHash}`);

          if (this.fileHashes.get(relPath) === fHash) {
            skippedUnchangedFiles += 1;
          } else {
            this.fileHashes.set(relPath, fHash);
            this.chunks.set(relPath, this._extractAstLikeChunks(relPath, content));
            reindexedFiles += 1;
          }
        }
      }

      const merkleHash = sha256(childHashes.join("\n"));
      this.dirHashes.set(relDir || ".", merkleHash);
      return merkleHash;
    };

    const rootMerkleHash = walk(this.rootDir, "");

    // Evict deleted files
    let deletedFiles = 0;
    for (const oldPath of [...this.fileHashes.keys()]) {
      if (!seenFiles.has(oldPath)) {
        this.fileHashes.delete(oldPath);
        this.chunks.delete(oldPath);
        deletedFiles += 1;
      }
    }

    this._rebuildSymbolGraph();
    return { rootMerkleHash, reindexedFiles, skippedUnchangedFiles, deletedFiles };
  }

  _extractAstLikeChunks(relPath, content) {
    const lines = content.split("\n");
    const extracted = [];
    const declRe = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|def|fn|struct|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/;

    let current = null;
    lines.forEach((line, idx) => {
      const m = line.match(declRe);
      if (m) {
        if (current && current.lines.length > 0) {
          extracted.push(this._finalizeChunk(relPath, current, idx));
        }
        current = { symbol: m[1], kind: "symbol", startLine: idx + 1, lines: [line] };
      } else {
        if (!current) {
          current = { symbol: path.basename(relPath), kind: "module", startLine: idx + 1, lines: [] };
        }
        current.lines.push(line);
      }
    });
    if (current && current.lines.length > 0) {
      extracted.push(this._finalizeChunk(relPath, current, lines.length));
    }
    return extracted;
  }

  _finalizeChunk(relPath, raw, endLine) {
    const text = raw.lines.join("\n");
    const tokens = new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2)
    );
    return { relPath, symbol: raw.symbol, kind: raw.kind, startLine: raw.startLine, endLine, text, tokens };
  }

  _rebuildSymbolGraph() {
    this.symbolGraph.clear();
    for (const [relPath, fileChunks] of this.chunks.entries()) {
      for (const c of fileChunks) {
        if (c.kind === "symbol") {
          this.symbolGraph.set(c.symbol, { definedIn: relPath, startLine: c.startLine, referencedIn: new Set() });
        }
      }
    }
    for (const [relPath, fileChunks] of this.chunks.entries()) {
      const fullText = fileChunks.map((c) => c.text).join("\n");
      for (const [sym, node] of this.symbolGraph.entries()) {
        if (node.definedIn !== relPath && new RegExp(`\\b${sym}\\b`).test(fullText)) {
          node.referencedIn.add(relPath);
        }
      }
    }
  }

  /**
   * Hybrid identifier-split BM25-like + call-graph ranker (mounted behind Codemode -> 0 prefix tokens).
   */
  search(query, topK = 5) {
    const qTokens = query
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);

    const scored = [];
    for (const fileChunks of this.chunks.values()) {
      for (const chunk of fileChunks) {
        let score = 0;
        for (const qt of qTokens) {
          if (chunk.tokens.has(qt)) score += 2.0;
          if (chunk.symbol.toLowerCase().includes(qt)) score += 3.5;
        }
        const graphNode = this.symbolGraph.get(chunk.symbol);
        if (graphNode && score > 0) {
          score += graphNode.referencedIn.size * 0.75; // Centrality boost (Aider/DeepWiki style)
        }
        if (score > 0) {
          scored.push({
            relPath: chunk.relPath,
            symbol: chunk.symbol,
            lines: `${chunk.startLine}-${chunk.endLine}`,
            score: Number(score.toFixed(2))
          });
        }
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  generateDeepWikiMap() {
    const rankedSymbols = [...this.symbolGraph.entries()]
      .sort((a, b) => b[1].referencedIn.size - a[1].referencedIn.size);
    const lines = ["# Auto-Generated Repo Map (DeepWiki-Lite)", ""];
    for (const [sym, info] of rankedSymbols) {
      const refs = [...info.referencedIn];
      lines.push(`- \`${sym}\` (${info.definedIn}:${info.startLine}) <- referenced by [${refs.join(", ") || "entry/leaf"}]`);
    }
    return lines.join("\n");
  }
}

// ============================================================================
// 2. GOOGLE ANTIGRAVITY + DEVIN 2.0: Trust Artifacts, Inline Comments & Pre-Flight Gate
// ============================================================================
export class TrustArtifactManager {
  constructor(artifactDir, reviewPolicy = "agent_decides") {
    this.artifactDir = artifactDir;
    this.reviewPolicy = reviewPolicy; // "always_proceed" | "agent_decides" | "request_review"
    this.comments = [];               // Anchored Google-Docs-style inline comments
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  /**
   * Devin 2.0 Interactive Pre-Flight Gate: scores ambiguity/blast-radius before autonomous edits.
   */
  evaluatePreFlight({ taskPrompt, touchedFilesEstimate, touchesAuthOrSchema = false, confidence = 0.85 }) {
    const needsHumanPlanApproval =
      this.reviewPolicy === "request_review" ||
      (this.reviewPolicy === "agent_decides" &&
        (touchesAuthOrSchema || touchedFilesEstimate > 6 || confidence < 0.75));

    return {
      requiresApprovalBeforeEdit: needsHumanPlanApproval,
      confidence,
      reason: needsHumanPlanApproval
        ? "High blast-radius or low confidence; pausing on implementation_plan.md artifact"
        : "Clear bounded scope; auto-proceeding to execution"
    };
  }

  writeImplementationPlan({ title, filesToModify, steps, verificationPlan }) {
    const md = [
      `# Implementation Plan: ${title}`,
      "",
      "## Files to Modify",
      ...filesToModify.map((f) => `- \`${f}\``),
      "",
      "## Execution Steps",
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "## Verification Plan",
      ...verificationPlan.map((v) => `- [ ] ${v}`)
    ].join("\n");
    const target = path.join(this.artifactDir, "implementation_plan.md");
    fs.writeFileSync(target, md, "utf8");
    return { artifactPath: target, sha256: sha256(md) };
  }

  /**
   * Antigravity Inline Commenting: attaches user feedback to a specific artifact line/section
   * and converts it into a mid-flight Reconciler steering payload without restarting the run.
   */
  addInlineComment({ artifactName, lineNumber, selectedText, comment }) {
    const entry = {
      id: `cmt_${this.comments.length + 1}`,
      artifactName,
      lineNumber,
      selectedText,
      comment,
      resolved: false
    };
    this.comments.push(entry);
    return {
      steerMessage: `[INLINE ARTIFACT COMMENT on ${artifactName}:L${lineNumber} ("${selectedText}")]: ${comment}. Incorporate this adjustment in-place without restarting completed work.`
    };
  }

  writeWalkthrough({ summary, gitDiffStat, testCommand, testPassed, screenshots = [], recordingPath = null }) {
    const md = [
      "# Verification Walkthrough",
      "",
      `## Summary\n${summary}`,
      "",
      `## Diff Summary\n\`${gitDiffStat}\``,
      "",
      `## Automated Verification\n- Command: \`${testCommand}\`\n- Status: **${testPassed ? "PASS" : "FAIL"}**`,
      "",
      "## Visual Evidence",
      ...(screenshots.length ? screenshots.map((s) => `- Screenshot: \`${s}\``) : ["- None (headless/backend change)"]),
      ...(recordingPath ? [`- Browser Recording: \`${recordingPath}\``] : [])
    ].join("\n");
    const target = path.join(this.artifactDir, "walkthrough.md");
    fs.writeFileSync(target, md, "utf8");
    return { artifactPath: target, verified: Boolean(testPassed) };
  }
}

// ============================================================================
// 3. CODEX + CURSOR: Cache-Safe Hierarchical AGENTS.md + Path-Globbed .mdc Rules
//    + Worktree .git Metadata Mount + CoW Dependency Bootstrapper
// ============================================================================
export class ScopedRulesAndWorktreeManager {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.injectedRuleKeys = new Set(); // Deduplicates dynamic tail injections per session
    this.globRules = [];               // Array<{ id, patternRe, content }>
  }

  registerMdcRule({ id, globPattern, content }) {
    // Convert simple glob (e.g. "src/db/**/*.ts") to RegExp
    const escaped = globPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(?:.+/)?")
      .replace(/\*/g, "[^/]*");
    this.globRules.push({ id, globPattern, patternRe: new RegExp(`^${escaped}$`), content });
  }

  /**
   * Resolves subdirectory AGENTS.md cascade + matching .mdc glob rules when a file is touched.
   * Returns tail-injection blocks ONLY once per session so the static system-prompt prefix NEVER mutates!
   */
  resolveTailRulesForFile(relFilePath) {
    const normalized = relFilePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const injections = [];

    // 1. Subdirectory AGENTS.md cascade (excluding root AGENTS.md which lives in frozen boot prefix)
    const parts = normalized.split("/");
    parts.pop(); // drop filename
    let accum = "";
    for (const dirPart of parts) {
      accum = accum ? `${accum}/${dirPart}` : dirPart;
      for (const candidateName of ["AGENTS.override.md", "AGENTS.md"]) {
        const relAgents = `${accum}/${candidateName}`;
        const absAgents = path.join(this.repoRoot, relAgents);
        if (fs.existsSync(absAgents) && !this.injectedRuleKeys.has(`agents:${relAgents}`)) {
          this.injectedRuleKeys.add(`agents:${relAgents}`);
          injections.push(`[SCOPED DIRECTORY RULE ${relAgents}]:\n${fs.readFileSync(absAgents, "utf8").trim()}`);
        }
      }
    }

    // 2. Cursor-style path-globbed .mdc rules
    for (const rule of this.globRules) {
      if (rule.patternRe.test(normalized) && !this.injectedRuleKeys.has(`mdc:${rule.id}`)) {
        this.injectedRuleKeys.add(`mdc:${rule.id}`);
        injections.push(`[SCOPED PATH RULE ${rule.id} (${rule.globPattern})]:\n${rule.content.trim()}`);
      }
    }

    return injections;
  }

  /**
   * Solves TWO notorious real-world git-worktree bugs (Codex #11 + Devin Snapshots):
   *  1. Inside a worktree, `.git` points to `<mainRepo>/.git/worktrees/<wtName>`. Sandbox MUST allow
   *     writes to that metadata subdir while keeping `<mainRepo>/.git/hooks` strictly read-only.
   *  2. Fresh worktrees lack untracked `node_modules`/`.venv`; bootstraps instant symlink/CoW snapshot.
   */
  prepareWorktreeEnvironment({ mainRepoDir, worktreeDir, worktreeName }) {
    const mainGitDir = path.join(mainRepoDir, ".git");
    const worktreeGitMetaDir = path.join(mainGitDir, "worktrees", worktreeName);
    const mainHooksDir = path.join(mainGitDir, "hooks");

    const linkedDeps = [];
    for (const depDirName of ["node_modules", ".venv"]) {
      const srcDep = path.join(mainRepoDir, depDirName);
      const dstDep = path.join(worktreeDir, depDirName);
      if (fs.existsSync(srcDep) && !fs.existsSync(dstDep)) {
        fs.symlinkSync(srcDep, dstDep, "dir");
        linkedDeps.push(depDirName);
      }
    }

    return {
      writableMounts: [worktreeDir, worktreeGitMetaDir],
      readOnlyMounts: [mainGitDir, mainHooksDir],
      linkedDependencySnapshots: linkedDeps
    };
  }
}

// ============================================================================
// 4. CURSOR BUGBOT + DEVIN REVIEW: Self-Learning Reviewer + Closed-Loop CI Autofix
// ============================================================================
export class AdaptiveReviewAndCiController {
  constructor(rulesFilePath) {
    this.rulesFilePath = rulesFilePath;
    this.learnedRules = [];
    this.dismissalCounts = new Map(); // patternKey -> count
  }

  /**
   * Cursor BugBot Learned Rules pattern: tracks human reactions to review findings.
   * Repeated false-positive dismissals synthesize an explicit suppression/calibration rule;
   * confirmed catches promote an invariant rule into REVIEW_RULES.md.
   */
  recordReviewFeedback({ patternKey, humanAction, explanation }) {
    if (humanAction === "dismissed_false_positive") {
      const next = (this.dismissalCounts.get(patternKey) || 0) + 1;
      this.dismissalCounts.set(patternKey, next);
      if (next >= 2) {
        const rule = `SUPPRESS_FALSE_POSITIVE [${patternKey}]: ${explanation}`;
        if (!this.learnedRules.includes(rule)) this.learnedRules.push(rule);
      }
    } else if (humanAction === "accepted_real_bug") {
      const rule = `ENFORCE_INVARIANT [${patternKey}]: ${explanation}`;
      if (!this.learnedRules.includes(rule)) this.learnedRules.push(rule);
    }
    this._persist();
    return { learnedRulesCount: this.learnedRules.length, rules: [...this.learnedRules] };
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.rulesFilePath), { recursive: true });
    fs.writeFileSync(
      this.rulesFilePath,
      ["# Learned Review Rules (BugBot-Style)", "", ...this.learnedRules.map((r) => `- ${r}`)].join("\n"),
      "utf8"
    );
  }

  /**
   * Devin Review / CI Autofix Loop: polls CI status & PR review threads, dispatches targeted autofix turns,
   * and halts cleanly on green checks or maxAttempts circuit breaker.
   */
  async runCiAutofixLoop({ pollCiFn, applyFixFn, maxAttempts = 3 }) {
    const history = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ci = await pollCiFn(attempt);
      history.push({ attempt, status: ci.status, failingCheck: ci.failingCheck || null });
      if (ci.status === "success") {
        return { converged: true, attempts: attempt, history };
      }
      await applyFixFn({ attempt, failingCheck: ci.failingCheck, logExcerpt: ci.logExcerpt });
    }
    const finalCheck = await pollCiFn(maxAttempts + 1);
    history.push({ attempt: maxAttempts + 1, status: finalCheck.status, failingCheck: finalCheck.failingCheck || null });
    return { converged: finalCheck.status === "success", attempts: maxAttempts + 1, history };
  }
}

// ============================================================================
// 5. CLAUDE COWORK + CODEX: 3-Tier Boundary Approval + Safe Unattended Routines + Outcomes Rubric
// ============================================================================
export class AutonomyGovernanceController {
  /**
   * @param {"untrusted"|"on-request"|"never"} approvalPolicy
   * @param {boolean} unattendedRoutine - True when triggered by scheduled cron/routine with user offline
   */
  constructor({ approvalPolicy = "on-request", unattendedRoutine = false } = {}) {
    this.approvalPolicy = approvalPolicy;
    this.unattendedRoutine = unattendedRoutine;
  }

  /**
   * Evaluates an action against sandbox/consequence boundaries:
   * - Inside sandbox allowlist -> ALLOW
   * - Crosses boundary (e.g., new npm install domain, git push, external API write):
   *   - In unattended scheduled routines: HARD BLOCK consequential external mutations (fixes Cowork unattended injection risk!)
   *   - In interactive `on-request`: PAUSE_FOR_APPROVAL (suspends turn cleanly for user Y/N on TUI or mobile)
   */
  authorizeBoundaryCrossing({ actionType, target, isInsideSandboxAllowlist, isExternalMutation = false }) {
    if (isInsideSandboxAllowlist && !isExternalMutation) {
      return { decision: "ALLOW", reason: "Within workspace sandbox & egress allowlist" };
    }

    if (this.unattendedRoutine && (isExternalMutation || !isInsideSandboxAllowlist)) {
      return {
        decision: "DENY_UNATTENDED",
        reason: `Unattended routine blocked consequential/boundary action (${actionType} -> ${target}); queued for morning digest`
      };
    }

    if (this.approvalPolicy === "on-request") {
      return {
        decision: "PAUSE_FOR_USER_APPROVAL",
        approvalRequest: { actionType, target },
        reason: `Action crosses sandbox boundary (${actionType}); awaiting one-tap user approval`
      };
    }

    if (this.approvalPolicy === "untrusted") {
      return { decision: "DENY", reason: "Strict untrusted policy blocks all boundary crossings" };
    }

    return { decision: "ALLOW", reason: "Explicit full-auto container override" };
  }

  /**
   * Claude Managed Agents "Outcomes" Rubric Evaluator: grades deliverable against explicit acceptance criteria.
   */
  evaluateOutcomeRubric(rubricItems, evidence) {
    const results = rubricItems.map((item) => ({
      id: item.id,
      criterion: item.criterion,
      passed: Boolean(item.check(evidence))
    }));
    return {
      passedAll: results.every((r) => r.passed),
      score: `${results.filter((r) => r.passed).length}/${results.length}`,
      results
    };
  }
}
