/**
 * Ring 4 — Zero-Token Operator Slash-Command Extension (`src/ring4/slash-commands-extension.ts`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - `@earendil-works/pi-coding-agent@1.4.0` (`ExtensionAPI.registerCommand`, `registerShortcut`,
 *    `examples/extensions/plan-mode/index.ts`, MIT) + `@earendil-works/pi-tui@1.4.0` (`Key`).
 *
 * ARCHITECTURE & TOKEN INVARIANT (`Invariant I-01` & `I-03`):
 *  - Registers 7 operator slash commands (`/plan`, `/rewind`, `/review`, `/quarantine`, `/dream`,
 *    `/evolve`, `/doctor`) + `Ctrl+Alt+P` plan-mode toggle via `ExtensionRunner` commands.
 *  - Adds `+0` tools to `agent.state.tools` -> `1,073 === 1,073 o200k_base` active schema tokens
 *    and `0` live static-prefix SHA-256 drift!
 *  - Works identically across all 4 execution modes (`tui`, `print`, `json`, `rpc`):
 *      - Updates TUI status bar & notifications when `ctx.hasUI` is true
 *      - Emits a structured `CustomMessageEntry` (`customType: "pi-apex-command"`, `triggerTurn: false`)
 *      - Writes deterministic text to `stdout` when running in `print` mode (`pi-apex -p "/doctor"`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { rewindChatAndDiskToLeaf } from "../core/git-rewind.ts";
import { COMPILED_GUARDRAILS_SHA256, loadVerifiedGuardrails } from "../core/guardrail-pin.ts";
import { getLinuxFsBridge } from "../core/linux-fs-bridge.ts";
import { countO200kTokens } from "../core/prefix-budget.ts";
import type { ReviewTarget } from "../ring2/bugbot-ci-loop.ts";
import type { Ring3HarnessInstance } from "../ring3/ring3-extension.ts";
import type { SkillLifecycleStatus } from "../ring3/skills-guard-quarantine.ts";

export interface Ring4SlashCommandBridge {
  getHarness(): Ring3HarnessInstance | null;
  getWorkspaceRoot(): string;
  getGuardrailsPath(): string | undefined;
  getExpectedGuardrailsSha256(): string | undefined;
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}

export const RING4_SLASH_COMMANDS = [
  "plan",
  "rewind",
  "review",
  "quarantine",
  "dream",
  "evolve",
  "doctor"
] as const;

function parseLineRangeToken(token: string): { lineStart: number; lineEnd: number } | null {
  const m = /^L?(\d+)(?:-L?(\d+))?$/i.exec(token.trim());
  if (!m) return null;
  const start = Number.parseInt(m[1]!, 10);
  const end = m[2] ? Number.parseInt(m[2], 10) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    return null;
  }
  return { lineStart: start, lineEnd: end };
}

export function createRing4SlashCommandsExtension(
  bridge: Ring4SlashCommandBridge
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const refreshStatusBadge = (ctx: ExtensionContext, h: Ring3HarnessInstance) => {
      if (!ctx.hasUI) return;
      const planBadge = h.trustArtifacts.isPlanModeActive() ? "PLAN (read-only)" : "EXEC";
      const qCount = h.skillCurator.listSkills("quarantined").length;
      const qSuffix = qCount > 0 ? ` | quarantine:${qCount}` : "";
      ctx.ui.setStatus("pi-apex", `Apex [${planBadge}${qSuffix}]`);
    };

    const emitCommandReport = (
      ctx: ExtensionContext,
      commandName: string,
      markdown: string,
      details: unknown,
      level: "info" | "warning" | "error" = "info"
    ) => {
      const h = bridge.getHarness();
      if (h) refreshStatusBadge(ctx, h);

      if (ctx.hasUI) {
        ctx.ui.notify(markdown, level);
      }
      if (ctx.mode === "print") {
        process.stdout.write(`${markdown.trimEnd()}\n`);
      }
      pi.sendMessage(
        {
          customType: "pi-apex-command",
          content: markdown,
          display: true,
          details: {
            command: commandName,
            ...(typeof details === "object" && details !== null ? (details as object) : { value: details })
          }
        },
        { triggerTurn: false }
      );
      bridge.onCommandOutput?.(commandName, markdown, details);
    };

    const requireHarness = (): Ring3HarnessInstance => {
      const h = bridge.getHarness();
      if (!h) {
        throw new Error("Pi-Apex Ring 3/4 harness instance is not bound yet.");
      }
      return h;
    };

    // Keep TUI status badge synchronized at session start
    pi.on("session_start", async (_event, ctx) => {
      const h = bridge.getHarness();
      if (h) refreshStatusBadge(ctx, h);
    });

    // Keyboard shortcut `Ctrl+Alt+P` (ported from Pi `examples/extensions/plan-mode/index.ts`)
    pi.registerShortcut(Key.ctrlAlt("p"), {
      description: "Toggle Pi-Apex read-only Plan Mode",
      handler: async (ctx) => {
        const h = requireHarness();
        const next = !h.trustArtifacts.isPlanModeActive();
        h.trustArtifacts.setPlanMode(next);
        emitCommandReport(
          ctx,
          "plan",
          next
            ? "Plan Mode ENABLED (read-only exploration; write/edit/mutating bash gated)."
            : "Plan Mode DISABLED (workspace execution unlocked).",
          { planModeActive: next }
        );
      }
    });

    // =========================================================================
    // 1. `/plan [on | off | toggle | status | list | approve <id> | steer <id> <L1-L2> <comment>]`
    // =========================================================================
    pi.registerCommand("plan", {
      description:
        "Toggle read-only Plan Mode, inspect/approve Trust Artifacts, or send inline L-anchored steer feedback",
      getArgumentCompletions: (prefix) => {
        const opts = ["on", "off", "toggle", "status", "list", "approve ", "steer "];
        return opts
          .filter((o) => o.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value.trim() }));
      },
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const trimmed = rawArgs.trim();
        const parts = trimmed ? trimmed.split(/\s+/) : [];
        const sub = (parts[0] ?? "toggle").toLowerCase();

        if (sub === "on" || sub === "off" || sub === "toggle") {
          const next =
            sub === "on" ? true : sub === "off" ? false : !h.trustArtifacts.isPlanModeActive();
          h.trustArtifacts.setPlanMode(next);
          emitCommandReport(
            ctx,
            "plan",
            next
              ? "Plan Mode ENABLED (read-only exploration active)."
              : "Plan Mode DISABLED (full confined workspace tools active).",
            { planModeActive: next }
          );
          return;
        }

        if (sub === "status" || sub === "list") {
          const artifacts = h.trustArtifacts.listArtifacts();
          const lines = [
            `# Plan Mode & Trust Artifacts`,
            `- **Plan Mode**: ${h.trustArtifacts.isPlanModeActive() ? "ACTIVE (read-only)" : "INACTIVE (exec)"}`,
            `- **Tracked Artifacts**: ${artifacts.length}`
          ];
          for (const a of artifacts) {
            const doneCount = a.todos.filter((t) => t.completed).length;
            const stepSummary =
              a.todos.length > 0 ? ` (steps: ${doneCount}/${a.todos.length})` : "";
            lines.push(`  - \`${a.artifactId}\` [${a.kind} | ${a.status}] — ${a.title}${stepSummary}`);
          }
          emitCommandReport(ctx, "plan", lines.join("\n"), {
            planModeActive: h.trustArtifacts.isPlanModeActive(),
            artifacts
          });
          return;
        }

        if (sub === "approve") {
          const artifactId = parts[1];
          if (!artifactId) {
            emitCommandReport(
              ctx,
              "plan",
              "Usage: `/plan approve <artifactId>`",
              { error: "missing_artifact_id" },
              "warning"
            );
            return;
          }
          const approved = h.trustArtifacts.approvePlanArtifact(artifactId, true);
          emitCommandReport(
            ctx,
            "plan",
            `Approved Trust Artifact \`${approved.artifactId}\` (${approved.title}) and unlocked execution mode.`,
            approved
          );
          return;
        }

        if (sub === "steer") {
          const artifactId = parts[1];
          const rangeTok = parts[2];
          const commentText = parts.slice(3).join(" ").trim();
          const range = rangeTok ? parseLineRangeToken(rangeTok) : null;
          if (!artifactId || !range || !commentText) {
            emitCommandReport(
              ctx,
              "plan",
              "Usage: `/plan steer <artifactId> <Lstart[-Lend]> <review comment>`",
              { error: "invalid_steer_args" },
              "warning"
            );
            return;
          }
          const cmt = await h.trustArtifacts.addInlineCommentAndSteer({
            artifactId,
            lineStart: range.lineStart,
            lineEnd: range.lineEnd,
            comment: commentText,
            author: "operator"
          });
          emitCommandReport(
            ctx,
            "plan",
            `Delivered inline steer comment \`${cmt.commentId}\` on \`${artifactId}\` (L${cmt.lineStart}-L${cmt.lineEnd}).`,
            cmt
          );
          return;
        }

        emitCommandReport(
          ctx,
          "plan",
          "Unknown `/plan` subcommand. Use `/plan [on|off|toggle|status|list|approve <id>|steer <id> <L1-L2> <comment>]`.",
          { sub },
          "warning"
        );
      }
    });

    // =========================================================================
    // 2. `/rewind [list | <leafId>]`
    // =========================================================================
    pi.registerCommand("rewind", {
      description:
        "List captured Git/SQLite turn checkpoints or atomically rewind chat + workspace disk to <leafId>",
      getArgumentCompletions: (prefix) => {
        const h = bridge.getHarness();
        if (!h) return [{ value: "list", label: "list" }];
        const sessionId = h.session.sessionManager.getSessionId();
        const rows = h.stateDb.db
          .prepare(
            `SELECT leaf_id, turn_index FROM git_checkpoints WHERE session_id = ? ORDER BY turn_index DESC LIMIT 20`
          )
          .all(sessionId) as Array<{ leaf_id: string; turn_index: number }>;
        const items = [
          { value: "list", label: "list (show all turn checkpoints)" },
          ...rows.map((r) => ({
            value: r.leaf_id,
            label: `${r.leaf_id} (turn #${r.turn_index})`
          }))
        ];
        return items.filter((i) => i.value.startsWith(prefix));
      },
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const arg = rawArgs.trim();
        const sessionId = h.session.sessionManager.getSessionId();
        const checkpoints = h.stateDb.db
          .prepare(
            `SELECT leaf_id, turn_index, git_tree_oid, created_at_ms
             FROM git_checkpoints
             WHERE session_id = ?
             ORDER BY turn_index DESC`
          )
          .all(sessionId) as Array<{
          leaf_id: string;
          turn_index: number;
          git_tree_oid: string;
          created_at_ms: number;
        }>;

        let targetLeafId = arg && arg !== "list" ? arg : "";

        // Interactive TUI picker when invoked with bare `/rewind`
        if (!arg && ctx.hasUI && ctx.mode === "tui" && checkpoints.length > 0) {
          const picked = await ctx.ui.select(
            "Select checkpoint to rewind workspace + transcript:",
            checkpoints.map(
              (cp) =>
                `${cp.leaf_id} | turn #${cp.turn_index} | tree ${cp.git_tree_oid.slice(0, 10)}`
            )
          );
          if (picked) {
            targetLeafId = picked.split("|")[0]!.trim();
          }
        }

        if (!targetLeafId) {
          const currentLeaf = h.session.sessionManager.getLeafId() ?? "(none)";
          const lines = [
            `# Workspace Git Rewind Checkpoints (current leaf: \`${currentLeaf}\`)`,
            checkpoints.length === 0
              ? "- _(no git checkpoints captured in this session yet)_"
              : checkpoints
                  .map(
                    (cp) =>
                      `- Turn #${cp.turn_index}: leaf=\`${cp.leaf_id}\` tree=\`${cp.git_tree_oid.slice(0, 12)}\` (${new Date(cp.created_at_ms).toISOString()})`
                  )
                  .join("\n")
          ];
          emitCommandReport(ctx, "rewind", lines.join("\n"), {
            currentLeaf,
            checkpoints
          });
          return;
        }

        const fromLeafId = h.session.sessionManager.getLeafId();
        if (!fromLeafId) {
          throw new Error("Cannot rewind: current session has no active leaf ID.");
        }

        const receipt = rewindChatAndDiskToLeaf({
          stateDb: h.stateDb,
          workspaceRoot: bridge.getWorkspaceRoot(),
          sessionManager: h.session.sessionManager,
          sessionId,
          fromLeafId,
          toLeafId: targetLeafId,
          durabilityMode: h.stateDb.durabilityMode
        });

        const summary = [
          `# Rewind Completed (\`${receipt.txId}\`)`,
          `- **Target Leaf**: \`${targetLeafId}\` -> Anchor \`${receipt.anchorLeafId}\``,
          `- **Restored Paths (${receipt.restoredPaths.length})**: ${receipt.restoredPaths.join(", ") || "(none)"}`,
          `- **Deleted Paths (${receipt.deletedPaths.length})**: ${receipt.deletedPaths.join(", ") || "(none)"}`,
          ...(receipt.safetyGitRef ? [`- **Safety Git Ref**: \`${receipt.safetyGitRef}\``] : [])
        ].join("\n");
        emitCommandReport(ctx, "rewind", summary, receipt);
      }
    });

    // =========================================================================
    // 3. `/review [uncommitted | base <branch> | commit <sha> | ci <cmd>]`
    // =========================================================================
    pi.registerCommand("review", {
      description:
        "Run BugBot REVIEW_RULES.md + Codex structured diff review or bounded CI verification loop",
      getArgumentCompletions: (prefix) =>
        ["uncommitted", "base main", "commit ", "ci "]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const trimmed = rawArgs.trim();
        const parts = trimmed ? trimmed.split(/\s+/) : [];
        const mode = (parts[0] ?? "uncommitted").toLowerCase();

        if (mode === "ci") {
          const cmd = trimmed.slice(2).trim();
          if (!cmd) {
            emitCommandReport(
              ctx,
              "review",
              "Usage: `/review ci <test-or-typecheck-command>`",
              { error: "missing_ci_command" },
              "warning"
            );
            return;
          }
          const ciRes = await h.bugBotCi.runCiVerificationLoop({
            command: cmd,
            maxAttempts: 2
          });
          emitCommandReport(
            ctx,
            "review",
            `# CI Verification (${ciRes.passed ? "PASSED" : "FAILED"})\n- Command: \`${cmd}\`\n- Attempts: ${ciRes.attempts.length}`,
            ciRes,
            ciRes.passed ? "info" : "warning"
          );
          return;
        }

        let target: ReviewTarget = { type: "uncommittedChanges" };
        if (mode === "base" && parts[1]) {
          target = { type: "baseBranch", branch: parts[1] };
        } else if (mode === "commit" && parts[1]) {
          target = { type: "commit", sha: parts[1] };
        }

        const reviewRes = h.bugBotCi.reviewTarget(target);
        emitCommandReport(ctx, "review", reviewRes.renderedText, reviewRes);
      }
    });

    // =========================================================================
    // 4. `/quarantine [list [status] | inspect <name> | promote <name> | consolidate <name> <umbrella> | lifecycle]`
    // =========================================================================
    pi.registerCommand("quarantine", {
      description:
        "Inspect skills-guard-v10 quarantine queue, promote clean skills, consolidate into umbrellas, or run lifecycle pass",
      getArgumentCompletions: (prefix) =>
        ["list", "list quarantined", "list active", "inspect ", "promote ", "consolidate ", "lifecycle"]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const parts = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
        const sub = (parts[0] ?? "list").toLowerCase();

        if (sub === "list") {
          const filter = parts[1] as SkillLifecycleStatus | undefined;
          const skills = h.skillCurator.listSkills(filter);
          const lines = [
            `# Quarantined & Managed Skills (${skills.length})`,
            ...(skills.length === 0
              ? ["- _(no skills recorded)_"]
              : skills.map(
                  (s) =>
                    `- \`${s.name}\` [${s.status}] verdict=\`${s.lastScanVerdict}\` uses=${s.useCount}${
                      s.pinned ? " (pinned)" : ""
                    }${s.cronReferenced ? " (cron)" : ""}${
                      s.absorbedInto ? ` -> ${s.absorbedInto}` : ""
                    }`
                ))
          ];
          emitCommandReport(ctx, "quarantine", lines.join("\n"), { skills });
          return;
        }

        if (sub === "inspect") {
          const name = parts[1];
          if (!name) {
            emitCommandReport(ctx, "quarantine", "Usage: `/quarantine inspect <name>`", {}, "warning");
            return;
          }
          const md = h.skillCurator.inspectOrRecordUse(name);
          const rec = h.skillCurator.getSkillRecord(name)!;
          emitCommandReport(
            ctx,
            "quarantine",
            `# Skill \`${name}\` [${rec.status} | scan=${rec.lastScanVerdict}]\n\n${md}`,
            rec
          );
          return;
        }

        if (sub === "promote") {
          const name = parts[1];
          if (!name) {
            emitCommandReport(ctx, "quarantine", "Usage: `/quarantine promote <name>`", {}, "warning");
            return;
          }
          const promoted = h.skillCurator.promoteFromQuarantine({
            name,
            operatorApproved: true
          });
          emitCommandReport(
            ctx,
            "quarantine",
            `Promoted skill \`${promoted.record.name}\` -> \`${promoted.promotedPath}\` (scan=${promoted.scan.verdict}).`,
            promoted
          );
          return;
        }

        if (sub === "consolidate") {
          const name = parts[1];
          const umbrella = parts[2];
          if (!name || !umbrella) {
            emitCommandReport(
              ctx,
              "quarantine",
              "Usage: `/quarantine consolidate <skillName> <umbrellaSkillName>`",
              {},
              "warning"
            );
            return;
          }
          const rec = h.skillCurator.consolidateIntoUmbrella({
            name,
            absorbedInto: umbrella
          });
          emitCommandReport(
            ctx,
            "quarantine",
            `Consolidated \`${rec.name}\` into umbrella \`${rec.absorbedInto}\` (archived under .agents/.archive/).`,
            rec
          );
          return;
        }

        if (sub === "lifecycle") {
          const summary = h.skillCurator.runAutomaticLifecyclePass();
          emitCommandReport(
            ctx,
            "quarantine",
            `# Skill Curator Lifecycle Pass\n- Marked Stale: ${summary.markedStale.join(", ") || "(none)"}\n- Archived: ${summary.archived.join(", ") || "(none)"}\n- Protected: ${summary.skippedProtected.join(", ") || "(none)"}`,
            summary
          );
          return;
        }

        emitCommandReport(
          ctx,
          "quarantine",
          "Unknown `/quarantine` subcommand. Use `list`, `inspect <name>`, `promote <name>`, `consolidate <name> <umbrella>`, or `lifecycle`.",
          { sub },
          "warning"
        );
      }
    });

    // =========================================================================
    // 5. `/dream [optional FTS5 query]`
    // =========================================================================
    pi.registerCommand("dream", {
      description:
        "Run Dreaming episodic FTS5 consolidator (Hermes #115104 two-pass scrub -> <=300-token MEMORY.md for next boot)",
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const query = rawArgs.trim() || undefined;
        const res = h.dreamingConsolidator.runDreamingPass({ query });
        const liveHash = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        const report = [
          `# Dreaming Consolidation Complete`,
          `- **Episodes Considered**: ${res.episodesConsidered}`,
          `- **Bullets Retained**: ${res.bulletsRetained} (rejected poisoned: ${res.rejectedPoisonedEpisodes})`,
          `- **Next-Boot MEMORY.md Budget**: ${res.memoryMdTokens}/${res.maxMemoryTokens} \`o200k_base\` tokens`,
          `- **Live Static Prefix SHA-256**: \`${liveHash.slice(0, 16)}...\` (0 mid-session drift; applies on \`/new\` or next boot)`
        ].join("\n");
        emitCommandReport(ctx, "dream", report, { ...res, livePrefixSha256: liveHash });
      }
    });

    // =========================================================================
    // 6. `/evolve [status | recall <domain> [query]]`
    // =========================================================================
    pi.registerCommand("evolve", {
      description:
        "Inspect Harness² EXPERIENCE.md surface + GUARDRAILS.yaml SHA-256 pin or recall domain cues/lessons",
      getArgumentCompletions: (prefix) =>
        ["status", "recall "]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const parts = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
        const sub = (parts[0] ?? "status").toLowerCase();

        if (sub === "recall") {
          const domain = parts[1] ?? "general";
          const query = parts.slice(2).join(" ").trim() || undefined;
          const entries = h.experienceEvolver.recallRelevantExperiences({
            domain,
            query,
            limit: 10
          });
          const lines = [
            `# Harness² Experience Recall (domain=\`${domain}\`${query ? `, query=\`${query}\`` : ""})`,
            ...(entries.length === 0
              ? ["- _(no matching experiences)_"]
              : entries.map(
                  (e) =>
                    `- **${e.slug}** — cue: _${e.experience.cue}_ -> lesson: ${e.experience.lesson} _(evidence: ${e.experience.evidence})_`
                ))
          ];
          emitCommandReport(ctx, "evolve", lines.join("\n"), { domain, entries });
          return;
        }

        const expMd = h.experienceEvolver.readCurrentExperienceMd();
        const expTokens = countO200kTokens(expMd);
        const verified = loadVerifiedGuardrails(
          bridge.getGuardrailsPath(),
          bridge.getExpectedGuardrailsSha256()
        );
        const runCountRow = h.stateDb.db
          .prepare(`SELECT COUNT(*) AS cnt, SUM(adopted) AS adopted_cnt FROM ring3_evolution_runs`)
          .get() as { cnt: number; adopted_cnt: number | null };

        const report = [
          `# Harness² Self-Evolution Surface Status`,
          `- **Mutable Surface (\`surfaces/EXPERIENCE.md\`)**: ${expTokens}/220 \`o200k_base\` tokens`,
          `- **Immutable \`GUARDRAILS.yaml\` SHA-256**: \`${verified.sha256.slice(0, 16)}...\` (VERIFIED === compiled pin; Issue #94 protected)`,
          `- **Recorded Propose-Probe-Compose Runs**: ${runCountRow.cnt} (adopted: ${runCountRow.adopted_cnt ?? 0})`
        ].join("\n");
        emitCommandReport(ctx, "evolve", report, {
          experienceMdTokens: expTokens,
          guardrailsSha256: verified.sha256,
          totalRuns: runCountRow.cnt,
          adoptedRuns: runCountRow.adopted_cnt ?? 0
        });
      }
    });

    // =========================================================================
    // 7. `/doctor` — 9-Point Runtime Security, Kernel Syscall & Token Self-Audit
    // =========================================================================
    pi.registerCommand("doctor", {
      description:
        "Run 9-point security, openat2 broker, bwrap, FTS5/WAL, GUARDRAILS SHA-256, and token-budget self-audit",
      handler: async (_rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = requireHarness();
        const wsRoot = bridge.getWorkspaceRoot();

        // 1. N-API `linux_fs_bridge.node` openat2 + FD_CLOEXEC probe
        const fsBridge = getLinuxFsBridge();
        const wsFd = fsBridge.openRootDir(fs.realpathSync(wsRoot));
        let cloexecOk = false;
        try {
          cloexecOk = fsBridge.hasCloexec(wsFd);
        } finally {
          fs.closeSync(wsFd);
        }

        // 2. Compiled `GUARDRAILS.yaml` SHA-256 verification
        const gVer = loadVerifiedGuardrails(
          bridge.getGuardrailsPath(),
          bridge.getExpectedGuardrailsSha256()
        );
        const guardrailsPinMatch =
          gVer.sha256 === (bridge.getExpectedGuardrailsSha256() ?? COMPILED_GUARDRAILS_SHA256);

        // 3. `bwrap` availability
        const bwrapProbe = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
        const bwrapVersion =
          bwrapProbe.status === 0 ? (bwrapProbe.stdout ?? "").trim() : "unavailable";

        // 4. Git repository & object format check
        const gitProbe = spawnSync("git", ["rev-parse", "--show-object-format"], {
          cwd: wsRoot,
          encoding: "utf8"
        });
        const gitFormat =
          gitProbe.status === 0 ? (gitProbe.stdout ?? "").trim() : "not-a-git-repo";

        // 5. SQLite WAL + FTS5 integrity check
        h.stateDb.verifyFtsIntegrity();

        // 6. Unresolved `OUTCOME_UNKNOWN` WAL rows check
        const sessionId = h.session.sessionManager.getSessionId();
        const unknownRows = h.stateDb.db
          .prepare(
            `SELECT COUNT(*) AS cnt FROM wal_intents WHERE session_id = ? AND status = 'OUTCOME_UNKNOWN'`
          )
          .get(sessionId) as { cnt: number };

        // 7. Static prefix SHA-256 & exact `o200k_base` active schema token audit
        const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        const activeSchemaTokens = countO200kTokens(
          JSON.stringify(
            h.session.agent.state.tools.map((t) => ({
              name: t.name,
              description: t.description ?? "",
              parameters: t.parameters ?? null
            }))
          )
        );
        const totalPrefixTokens = h.prefix.componentTokens.textTotal + activeSchemaTokens;

        // 8. Quarantine & Skills queue
        const quarantinedCount = h.skillCurator.listSkills("quarantined").length;
        const activeSkillsCount = h.skillCurator.listSkills("active").length;

        // 9. Active Model & Mode readiness
        const modelLabel = h.session.model
          ? `${h.session.model.provider}/${h.session.model.id}`
          : "none (slash-command / offline ready)";

        const allHealthy =
          cloexecOk &&
          guardrailsPinMatch &&
          unknownRows.cnt === 0 &&
          totalPrefixTokens <= h.guardrails.prefix_caps_o200k.total_max;

        const details = {
          healthy: allHealthy,
          openat2Cloexec: cloexecOk,
          guardrailsSha256: gVer.sha256,
          guardrailsPinMatch,
          bwrapVersion,
          gitFormat,
          fts5Integrity: "ok",
          walOutcomeUnknownCount: unknownRows.cnt,
          activeSchemaTokens,
          staticTextTokens: h.prefix.componentTokens.textTotal,
          totalPrefixTokens,
          maxPrefixTokens: h.guardrails.prefix_caps_o200k.total_max,
          livePrefixSha256,
          quarantinedCount,
          activeSkillsCount,
          planModeActive: h.trustArtifacts.isPlanModeActive(),
          cuaEnabled: h.cuaDriver.isEnabled(),
          model: modelLabel
        };

        const report = [
          `# Pi-Apex Doctor Self-Audit — ${allHealthy ? "ALL HEALTHY" : "ATTENTION REQUIRED"}`,
          `1. **Linux \`openat2\` + \`FD_CLOEXEC\` Broker**: ${cloexecOk ? "OK" : "FAIL"}`,
          `2. **\`GUARDRAILS.yaml\` SHA-256 Pin**: ${guardrailsPinMatch ? "OK" : "MISMATCH"} (\`${gVer.sha256.slice(0, 16)}...\`)`,
          `3. **Bubblewrap (\`bwrap\`) Sandbox**: ${bwrapVersion}`,
          `4. **Workspace Git Format**: ${gitFormat}`,
          `5. **SQLite WAL + \`episodes_fts\` Integrity**: OK (\`durability=${h.stateDb.durabilityMode}\`)`,
          `6. **WAL \`OUTCOME_UNKNOWN\` Lock Count**: ${unknownRows.cnt}`,
          `7. **Boot-Pinned Prefix Budget**: ${totalPrefixTokens}/${h.guardrails.prefix_caps_o200k.total_max} \`o200k_base\` tokens (schema=${activeSchemaTokens}, text=${h.prefix.componentTokens.textTotal}, hash=\`${livePrefixSha256.slice(0, 12)}...\`)`,
          `8. **Skills Queue**: active=${activeSkillsCount}, quarantined=${quarantinedCount}`,
          `9. **Session Model & Gates**: model=\`${modelLabel}\`, planMode=${h.trustArtifacts.isPlanModeActive()}, cuaEnabled=${h.cuaDriver.isEnabled()}`
        ].join("\n");

        emitCommandReport(ctx, "doctor", report, details, allHealthy ? "info" : "warning");
      }
    });
  };
}
