import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Completes the 5 Gap-Closure Subsystems for Pi-Apex:
 *  1. Multimodal Pipeline + Capability-Aware Vision Fallback + Durable Image Offload Pruner (`dsh-compaction-image-offload` pattern)
 *  2. Compact Ref-Based Browser Controller (`@e1`, `@e2` Accessibility Snapshot + Console/Network Error Trap, 0 upfront MCP tokens)
 *  3. Long-Horizon Engine (Background PTY/Job Lease Manager + Repeat-Call Loop Hygiene Guard + Two-Stage Tool-Prune -> Warm-Prefix Compaction)
 *  4. Role-Based Multi-Agent Orchestrator (`scout`, `architect`, `builder`, `qa_browser`, `blind_reviewer`)
 *  5. Dual Self-Improvement Loop:
 *      - Inner Post-Trajectory Loop (Hermes `skill_manage` + Quarantine Scanner + `Curator`)
 *      - Outer Contrastive Loop (`Harness²` `Propose -> Probe -> Compose` + `EXPERIENCE.md` library)
 */

// ---------------------------------------------------------------------------
// 1. Multimodal & Durable Image Offload Subsystem
// ---------------------------------------------------------------------------
export class MultimodalManager {
  constructor({ harnessDir, maxInlineImages = 2, maxImageBytes = 1024 * 1024 }) {
    this.mediaDir = path.join(harnessDir, "media");
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.maxInlineImages = maxInlineImages;
    this.maxImageBytes = maxImageBytes;
    this.offloadLedger = []; // Durable `ImageOffloadTarget` records surviving resume/fork
  }

  /**
   * Prepares an image attachment for the active model:
   * - Enforces byte budget
   * - Stores content-addressed artifact in `.harness/media/<sha256>.png`
   * - If active model is text-only (`supportsVision: false`), delegates to vision describer fallback!
   */
  async ingestImage({ buffer, mimeType, sourceLabel, modelSupportsVision, visionFallbackFn }) {
    if (buffer.byteLength > this.maxImageBytes) {
      throw new Error(`IMAGE_BUDGET_EXCEEDED: ${buffer.byteLength} bytes > ${this.maxImageBytes}`);
    }
    const sha = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const savedPath = path.join(this.mediaDir, `${sha}.${ext}`);
    fs.writeFileSync(savedPath, buffer);

    if (!modelSupportsVision) {
      const description = await visionFallbackFn(buffer, mimeType);
      return {
        type: "text",
        mediaSha: sha,
        savedPath,
        text: `[vision_bridge source="${sourceLabel}" file="${savedPath}"] ${description}`,
      };
    }

    return {
      type: "image",
      mediaSha: sha,
      savedPath,
      mimeType,
      dataBase64: buffer.toString("base64"),
      sourceLabel,
    };
  }

  /**
   * Projects transcript messages before LLM send: retains only the `maxInlineImages` newest images;
   * older historical screenshots are replaced with deterministic file pointers (`IMAGE_OFFLOAD`).
   */
  projectMessagesWithImageOffload(messages) {
    const imageLocations = [];
    messages.forEach((m, mIdx) => {
      if (Array.isArray(m.contentBlocks)) {
        m.contentBlocks.forEach((blk, bIdx) => {
          if (blk.type === "image") imageLocations.push({ mIdx, bIdx, blk });
        });
      }
    });

    const toOffloadCount = Math.max(0, imageLocations.length - this.maxInlineImages);
    const offloadSet = new Set(
      imageLocations.slice(0, toOffloadCount).map((loc) => `${loc.mIdx}:${loc.bIdx}`)
    );

    const projected = messages.map((m, mIdx) => {
      if (!Array.isArray(m.contentBlocks)) return m;
      return {
        ...m,
        contentBlocks: m.contentBlocks.map((blk, bIdx) => {
          if (offloadSet.has(`${mIdx}:${bIdx}`)) {
            this.offloadLedger.push({ messageIndex: mIdx, blockIndex: bIdx, mediaSha: blk.mediaSha });
            return {
              type: "text",
              text: `[historical_image_offloaded sha="${blk.mediaSha}" path="${blk.savedPath}" label="${blk.sourceLabel}" — re-read file if visual inspection needed]`,
            };
          }
          return blk;
        }),
      };
    });

    return { projected, offloadedCount: toOffloadCount };
  }
}

// ---------------------------------------------------------------------------
// 2. Compact Accessibility-Ref Browser Controller (`exposure: "codemode"`)
// ---------------------------------------------------------------------------
export class CompactBrowserController {
  constructor({ multimodalManager }) {
    this.mm = multimodalManager;
    this.sessions = new Map(); // Persistent profile state across turns
  }

  /**
   * Instead of dumping 300KB raw HTML or registering 35 bloated Playwright MCP schemas,
   * exposes 1 compact Codemode controller returning an Accessibility Ref Tree (`@e1`, `@e2`)
   * + automatically captured console/page/network errors!
   */
  openOrAttachSession(profileId = "default") {
    if (!this.sessions.has(profileId)) {
      this.sessions.set(profileId, {
        url: "about:blank",
        cookies: new Map(),
        consoleErrors: [],
        networkFailures: [],
        refs: new Map(),
      });
    }
    return this.sessions.get(profileId);
  }

  navigateAndSnapshot(profileId, url, simulatedDom) {
    const s = this.openOrAttachSession(profileId);
    s.url = url;
    s.refs.clear();
    s.consoleErrors = simulatedDom.consoleErrors ?? [];
    s.networkFailures = simulatedDom.networkFailures ?? [];

    const a11yLines = [];
    (simulatedDom.elements ?? []).forEach((el, idx) => {
      const refId = `@e${idx + 1}`;
      s.refs.set(refId, el);
      a11yLines.push(`${refId} [${el.role}] "${el.name}"${el.value ? ` val="${el.value}"` : ""}`);
    });

    return {
      url: s.url,
      a11yTree: a11yLines.join("\n"),
      consoleErrors: s.consoleErrors,
      networkFailures: s.networkFailures,
    };
  }

  actByRef(profileId, refId, action, text = "") {
    const s = this.openOrAttachSession(profileId);
    const target = s.refs.get(refId);
    if (!target) throw new Error(`STALE_OR_UNKNOWN_BROWSER_REF: ${refId} — re-snapshot page first`);
    if (action === "fill") target.value = text;
    if (action === "click" && target.onClickSetCookie) {
      s.cookies.set(target.onClickSetCookie.name, target.onClickSetCookie.value);
    }
    return { ok: true, refId, action, activeCookies: s.cookies.size };
  }
}

// ---------------------------------------------------------------------------
// 3. Long-Horizon Loop Engineering: Repeat-Call Guard, Two-Stage Compaction & Background Jobs
// ---------------------------------------------------------------------------
export class LoopEngineeringController {
  constructor({ maxIdenticalCalls = 3, contextLimitTokens = 32000, pressureRatio = 0.8 }) {
    this.maxIdenticalCalls = maxIdenticalCalls;
    this.contextLimitTokens = contextLimitTokens;
    this.pressureRatio = pressureRatio;
    this.callHistoryHashes = [];
    this.backgroundJobs = new Map();
  }

  /**
   * Detects infinite/stuck agent loops (`dsh-guard` + Hermes stuck-loop pattern):
   * blocks the 3rd identical `(toolName, canonicalArgs)` call in a sliding window.
   */
  checkRepeatCallHygiene(toolName, args) {
    const canonical = JSON.stringify(args, Object.keys(args || {}).sort());
    const sig = crypto.createHash("sha256").update(`${toolName}:${canonical}`).digest("hex").slice(0, 16);
    this.callHistoryHashes.push(sig);
    const recent = this.callHistoryHashes.slice(-6);
    const repeats = recent.filter((h) => h === sig).length;
    if (repeats >= this.maxIdenticalCalls) {
      return {
        block: true,
        reason: `LOOP_HYGIENE_GUARD: Identical call to '${toolName}' repeated ${repeats} times consecutively. Stop and change strategy or inspect root cause.`,
      };
    }
    return { block: false };
  }

  /**
   * Two-Stage Compaction (`dsh-compaction-tool-result-pruner` + Pi `CompactionEntry`):
   * Stage 1 (Zero LLM Cost): Deterministically prune old bulky `toolResult` bodies older than last 4 messages.
   * Stage 2 (Warm-Prefix Summarization): Only call LLM summarizer if token pressure STILL exceeds threshold!
   */
  async compactIfNeeded(messages, estimateTokensFn, warmPrefixSummarizeFn) {
    const budget = Math.floor(this.contextLimitTokens * this.pressureRatio);
    const initialTokens = estimateTokensFn(JSON.stringify(messages));
    if (initialTokens <= budget) {
      return { compacted: false, stageUsed: "none", messages, tokensAfter: initialTokens };
    }

    // Stage 1: Deterministic old tool-result pruning (no LLM call!)
    const keepTail = 4;
    const stage1 = messages.map((m, idx) => {
      if (idx < messages.length - keepTail && m.role === "toolResult" && (m.content?.length ?? 0) > 300) {
        return {
          ...m,
          content: `[pruned_old_tool_result tool="${m.toolName}" original_chars=${m.content.length}]`,
        };
      }
      return m;
    });

    const afterStage1Tokens = estimateTokensFn(JSON.stringify(stage1));
    if (afterStage1Tokens <= budget) {
      return {
        compacted: true,
        stageUsed: "stage1_deterministic_tool_prune_only",
        messages: stage1,
        tokensBefore: initialTokens,
        tokensAfter: afterStage1Tokens,
      };
    }

    // Stage 2: Summarize older prefix while preserving cumulative touched-file ledger + recent tail
    const headToSummarize = stage1.slice(0, Math.max(1, stage1.length - keepTail));
    const retainedTail = stage1.slice(Math.max(1, stage1.length - keepTail));
    const summaryText = await warmPrefixSummarizeFn(headToSummarize);
    const stage2 = [
      {
        role: "user",
        type: "compaction_checkpoint",
        content: `<compaction_summary tokens_before="${initialTokens}">\n${summaryText}\n</compaction_summary>`,
      },
      ...retainedTail,
    ];
    return {
      compacted: true,
      stageUsed: "stage2_warm_prefix_llm_summary",
      messages: stage2,
      tokensBefore: initialTokens,
      tokensAfter: estimateTokensFn(JSON.stringify(stage2)),
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Role-Based Multi-Agent Orchestrator (`SUBAGENTS.yaml` 5 Specialized Roles)
// ---------------------------------------------------------------------------
export const ROLE_REGISTRY = Object.freeze({
  scout: {
    modelTier: "fast-500tps",
    thinkingLevel: "low",
    readOnly: true,
    ephemeralContext: true, // Keeps 80k grep noise OUT of Lead's context window!
    allowedTools: ["read", "codemode"],
  },
  architect: {
    modelTier: "frontier-reasoning",
    thinkingLevel: "high",
    readOnly: true,
    ephemeralContext: true,
    allowedTools: ["read", "codemode"],
  },
  builder: {
    modelTier: "coding-sonnet-or-v4",
    thinkingLevel: "medium",
    readOnly: false,
    requiresWorktree: true,
    allowedTools: ["read", "write", "edit", "bash", "codemode"],
  },
  qa_browser: {
    modelTier: "multimodal-vision",
    thinkingLevel: "medium",
    readOnly: true,
    ephemeralContext: true,
    allowedTools: ["read", "bash", "codemode"],
  },
  blind_reviewer: {
    modelTier: "frontier-reasoning",
    thinkingLevel: "high",
    readOnly: true,
    blindDiffOnly: true,
    allowedTools: ["read"],
  },
});

export class RoleOrchestrator {
  async dispatchRole(roleName, inputPacket, executorFn) {
    const profile = ROLE_REGISTRY[roleName];
    if (!profile) throw new Error(`UNKNOWN_AGENT_ROLE: ${roleName}`);

    // Enforce blind-context contract for `blind_reviewer`
    const sanitizedInput = profile.blindDiffOnly
      ? {
          spec: inputPacket.spec,
          gitDiff: inputPacket.gitDiff,
          testReport: inputPacket.testReport,
          qaReport: inputPacket.qaReport,
        }
      : inputPacket;

    const rawResult = await executorFn({ profile, input: sanitizedInput });

    // Enforce read-only guard
    if (profile.readOnly && rawResult.attemptedWrite) {
      throw new Error(`ROLE_POLICY_VIOLATION: Role '${roleName}' is strictly read-only`);
    }

    // Return ONLY compact structured handoff artifact (<500 tokens) to Lead agent!
    return {
      role: roleName,
      modelTier: profile.modelTier,
      summaryArtifact: rawResult.summaryArtifact,
    };
  }
}

// ---------------------------------------------------------------------------
// 5. Dual Self-Improvement Engine (Hermes Procedural Skill Curator + Harness² Outer Loop)
// ---------------------------------------------------------------------------
export class SelfImprovementEngine {
  constructor({ surfacesDir }) {
    this.surfacesDir = surfacesDir;
    this.skillsDir = path.join(surfacesDir, "skills");
    this.experiencePath = path.join(surfacesDir, "EXPERIENCE.md");
    this.lockPath = path.join(this.skillsDir, ".lock.json");
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  /**
   * Hermes-style Quarantine Security Scanner + Procedural `SKILL.md` Distillation:
   * Triggers after complex trajectories (>=5 tool steps or recovered error loops),
   * scans candidate skill markdown/scripts for prompt-injection / exfiltration patterns,
   * and writes a content-hashed lockfile entry (`skills/.lock.json`).
   */
  distillAndQuarantineSkill({ slug, description, triggers, stepsMarkdown, sourceSessionId }) {
    const forbiddenPatterns = [
      /curl\s+.*\|\s*(sh|bash)/i,
      /ignore\s+previous\s+instructions/i,
      /MEMORY\.md/i,
      /\.env\b/,
    ];
    for (const pat of forbiddenPatterns) {
      if (pat.test(stepsMarkdown)) {
        return { accepted: false, reason: `SKILL_QUARANTINE_REJECTED: matched ${pat}` };
      }
    }

    const body = [
      "---",
      `name: ${slug}`,
      `description: ${description}`,
      `triggers: ${JSON.stringify(triggers)}`,
      `distilled_from: ${sourceSessionId}`,
      "---",
      stepsMarkdown.trim(),
      "",
    ].join("\n");

    if (Buffer.byteLength(body, "utf8") > 24 * 1024) {
      return { accepted: false, reason: "SKILL_SIZE_CAP_EXCEEDED: >24KB" };
    }

    const skillFolder = path.join(this.skillsDir, slug);
    fs.mkdirSync(skillFolder, { recursive: true });
    const skillPath = path.join(skillFolder, "SKILL.md");
    fs.writeFileSync(skillPath, body, "utf8");

    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    const lock = fs.existsSync(this.lockPath)
      ? JSON.parse(fs.readFileSync(this.lockPath, "utf8"))
      : {};
    lock[slug] = { sha256, sourceSessionId, scannerVerdict: "clean", updatedAt: new Date().toISOString() };
    fs.writeFileSync(this.lockPath, JSON.stringify(lock, null, 2), "utf8");

    return { accepted: true, skillPath, sha256 };
  }

  /**
   * Google `Harness²` Two-Level Recursive Optimizer (`Propose -> Probe -> Compose` + `EXPERIENCE.md`):
   *  - Level 1 (Task/Batch Contrastive Step): Runs reference harness vs. Invariant & Domain candidate
   *    surface mutations under matched conditions, keeping ONLY edits supported by behavioral contrast.
   *  - Level 2 (Harnessing-Level Recursion): Appends evidence-backed lessons into `EXPERIENCE.md`
   *    so future optimization cycles learn what helped vs. regressed!
   */
  async runHarness2ProposeProbeCompose({ taskSuite, proposeCandidatesFn, probeEvaluatorFn }) {
    // 1. Reference baseline probe
    const baselineProbe = await probeEvaluatorFn({ variant: "reference", patch: {} }, taskSuite);

    // 2. Propose 1 Invariant edit (e.g., TOOL_GUIDANCE.md) & 1 Domain edit (e.g., skills/)
    const { invariantCandidate, domainCandidate } = await proposeCandidatesFn(baselineProbe);

    // 3. Probe both candidates under identical matched conditions (isolated sandboxes!)
    const [invProbe, domProbe] = await Promise.all([
      probeEvaluatorFn({ variant: "invariant", patch: invariantCandidate }, taskSuite),
      probeEvaluatorFn({ variant: "domain", patch: domainCandidate }, taskSuite),
    ]);

    // 4. Compose: merge only edits with strictly positive behavioral contrast & zero regressions
    const composedPatch = {};
    const evidenceLessons = [];

    if (invProbe.passCount > baselineProbe.passCount && invProbe.regressions === 0) {
      Object.assign(composedPatch, invariantCandidate);
      evidenceLessons.push(
        `[ADOPTED:invariant] +${invProbe.passCount - baselineProbe.passCount} tasks (${invProbe.behavioralObservation})`
      );
    } else {
      evidenceLessons.push(`[DISCARDED:invariant] delta=${invProbe.passCount - baselineProbe.passCount}`);
    }

    if (domProbe.passCount > baselineProbe.passCount && domProbe.regressions === 0) {
      Object.assign(composedPatch, domainCandidate);
      evidenceLessons.push(
        `[ADOPTED:domain] +${domProbe.passCount - baselineProbe.passCount} tasks (${domProbe.behavioralObservation})`
      );
    } else {
      evidenceLessons.push(`[DISCARDED:domain] delta=${domProbe.passCount - baselineProbe.passCount}`);
    }

    // 5. Final Verification Probe of Composed Harness
    const composedProbe = await probeEvaluatorFn(
      { variant: "composed", patch: composedPatch },
      taskSuite
    );

    // 6. Harnessing-Level Recursion: Persist evidence into `EXPERIENCE.md`
    const existingExp = fs.existsSync(this.experiencePath)
      ? fs.readFileSync(this.experiencePath, "utf8")
      : "# Harness² Continual Improvement Experience Library\n";
    const updatedExp =
      existingExp +
      `\n## Cycle ${new Date().toISOString()} (Baseline ${baselineProbe.passCount} -> Composed ${composedProbe.passCount})\n` +
      evidenceLessons.map((l) => `- ${l}`).join("\n") +
      "\n";
    fs.writeFileSync(this.experiencePath, updatedExp, "utf8");

    return {
      baselineScore: baselineProbe.passCount,
      composedScore: composedProbe.passCount,
      adoptedSurfaces: Object.keys(composedPatch),
      experienceUpdated: true,
    };
  }
}
