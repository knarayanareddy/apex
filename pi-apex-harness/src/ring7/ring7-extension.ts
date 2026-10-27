/**
 * Ring 7 — Deferred `pr_pipeline` Specialist Tool + `/pr`, `/handoff`, `/preset` & `/bookmark`
 * Zero-Token Operator Slash Commands (`src/ring7/ring7-extension.ts`).
 *
 * PRESERVED INVARIANTS:
 *  - `pr_pipeline` registers with `exposure: "deferred"` (`+0` active schema tokens: `1,073 === 1,073`).
 *  - `/pr`, `/handoff`, `/preset`, and `/bookmark` register via `ExtensionAPI.registerCommand` (`+0` schema tokens).
 *  - `PresetController` injects `<preset_guidance>` via `before_agent_start`'s `message` field (NOT `systemPrompt`)
 *    and enforces `preset.tools` at the `tool_call` gate, preserving `0` static-prefix SHA-256 drift!
 */

import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Ring3HarnessInstance } from "../ring3/ring3-extension.ts";
import { AutonomousPrPipeline } from "./autonomous-pr-pipeline.ts";
import {
  BookmarkController,
  HandoffController,
  PresetController
} from "./handoff-presets-bookmarks.ts";

export interface Ring7Options {
  initialPreset?: string;
}

export const RING7_SLASH_COMMANDS = [
  "pr",
  "handoff",
  "preset",
  "bookmark"
] as const;

export function createRing7Extension(bridge: {
  getHarness: () => Ring3HarnessInstance | null;
  getWorkspaceRoot: () => string;
  getPrPipeline: () => AutonomousPrPipeline;
  getHandoffController: () => HandoffController;
  getPresetController: () => PresetController;
  getBookmarkController: () => BookmarkController;
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}): ExtensionFactory {
  const PrPatchSchema = Type.Object({
    relPath: Type.String({ description: "Workspace-relative file path to write" }),
    content: Type.String({ description: "Full UTF-8 file content" })
  });

  const PrPipelineParams = Type.Object({
    action: Type.Union([
      Type.Literal("run"),
      Type.Literal("list"),
      Type.Literal("handoff_brief")
    ]),
    title: Type.Optional(Type.String({ description: "PR title for run" })),
    issueDescription: Type.Optional(Type.String({ description: "Issue / PR summary for run" })),
    githubIssueRef: Type.Optional(
      Type.String({ description: "Optional GitHub Issue URL or owner/repo#num to quarantine-scan" })
    ),
    liveLlm: Type.Optional(
      Type.Boolean({ description: "Enable live-LLM patch synthesis & BugBot/bwrap-CI self-healing" })
    ),
    maxRepairAttempts: Type.Optional(
      Type.Number({ description: "Max self-healing repair attempts (default 2)" })
    ),
    slug: Type.Optional(Type.String({ description: "Branch slug (creates apex/<slug>)" })),
    scope: Type.Optional(Type.String({ description: "Conventional commit scope" })),
    baseBranch: Type.Optional(Type.String({ description: "Base Git branch (default current branch)" })),
    filePatches: Type.Optional(Type.Array(PrPatchSchema)),
    testCommand: Type.Optional(Type.String({ description: "Sandboxed CI command to run" })),
    keepFeatureBranchCheckedOut: Type.Optional(Type.Boolean()),
    goal: Type.Optional(Type.String({ description: "Goal for handoff_brief" }))
  });

  return (pi) => {
    const emitReport = (
      ctx: ExtensionContext,
      commandName: string,
      markdown: string,
      details: unknown,
      level: "info" | "warning" | "error" = "info"
    ) => {
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
            ...(typeof details === "object" && details !== null
              ? (details as object)
              : { value: details })
          }
        },
        { triggerTurn: false }
      );
      bridge.onCommandOutput?.(commandName, markdown, details);
    };

    // 1. Turn-tail `<preset_guidance>` injection (NEVER touches `session.systemPrompt` -> 0 prefix drift!)
    pi.on("before_agent_start", async () => {
      const msg = bridge.getPresetController().getTurnTailGuidanceMessage();
      if (msg) {
        return { message: msg };
      }
      return undefined;
    });

    // 2. Cache-preserving `preset.tools` gate at `tool_call`
    pi.on("tool_call", async (event) => {
      const check = bridge.getPresetController().checkToolCallAllowed(event.toolName);
      if (!check.allowed) {
        return {
          block: true,
          reason: check.reason
        };
      }
      return undefined;
    });

    // 3. Deferred `pr_pipeline` specialist tool (`exposure: "deferred"` -> +0 active schema tokens!)
    pi.registerTool({
      name: "pr_pipeline",
      label: "Autonomous Issue-to-PR Pipeline & Session Handoff",
      description:
        "Runs the 6-stage Autonomous Issue-to-PR pipeline (apex/<slug> branch -> Plan -> worktree/patches -> Codex/BugBot diff review -> bwrap CI -> PR bundle), lists PR runs, or generates a secret-scrubbed session handoff brief.",
      parameters: PrPipelineParams,
      exposure: "deferred",
      async execute(
        _toolCallId,
        params
      ): Promise<{ content: TextContent[]; details: unknown }> {
        const h = bridge.getHarness();
        switch (params.action) {
          case "list": {
            const runs = bridge.getPrPipeline().listRuns();
            return {
              content: [{ type: "text", text: JSON.stringify({ runs }, null, 2) }],
              details: { runs }
            };
          }
          case "run": {
            if (!params.title && !params.githubIssueRef) {
              throw new Error("pr_pipeline run requires 'title' or 'githubIssueRef'.");
            }
            const receipt = await bridge.getPrPipeline().run({
              title: params.title,
              issueDescription: params.issueDescription ?? params.title,
              githubIssueRef: params.githubIssueRef,
              liveLlm: params.liveLlm,
              maxRepairAttempts: params.maxRepairAttempts,
              slug: params.slug,
              scope: params.scope,
              baseBranch: params.baseBranch,
              filePatches: params.filePatches,
              testCommand: params.testCommand,
              keepFeatureBranchCheckedOut: params.keepFeatureBranchCheckedOut ?? true
            });
            return {
              content: [{ type: "text", text: receipt.prMarkdown }],
              details: receipt
            };
          }
          case "handoff_brief": {
            if (!h) throw new Error("Harness not initialized.");
            if (!params.goal) throw new Error("pr_pipeline handoff_brief requires 'goal'.");
            const brief = await bridge.getHandoffController().generateHandoffBrief({
              sessionManager: h.session.sessionManager,
              goal: params.goal,
              trustArtifacts: h.trustArtifacts,
              modelRuntime: h.modelRuntime,
              model: h.session.model
            });
            return {
              content: [{ type: "text", text: brief.briefMarkdown }],
              details: brief
            };
          }
        }
      }
    });

    // 4. `/pr [list | run <title> :: <description> | --auto <issueUrlOrTitle>]`
    pi.registerCommand("pr", {
      description:
        "Inspect or run the 6-stage Autonomous Issue-to-PR pipeline (`list`, `run <title> :: <desc>`, or `--auto <issueUrl|goal>`)",
      getArgumentCompletions: (prefix) =>
        ["list", "run ", "--auto "]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const trimmed = rawArgs.trim();
        if (!trimmed || trimmed.toLowerCase() === "list") {
          const runs = bridge.getPrPipeline().listRuns();
          const lines = [
            `# Autonomous Issue-to-PR Runs (${runs.length})`,
            ...(runs.length === 0
              ? ["- (no PR pipeline runs recorded yet — run `/pr run <title> :: <description>` or `/pr --auto <issueUrl>`)"]
              : runs.map(
                  (r) =>
                    `- **\`${r.prId}\`** [\`${r.status.toUpperCase()}\`] \`${r.branchName}\` -> \`${r.baseBranch}\` (\`${r.headSha.slice(0, 8)}\`, files=${r.changedFiles.length}, repairs=${r.repairAttemptsUsed}, ci=${r.ciPassed ? "PASS" : "FAIL"})`
                ))
          ];
          emitReport(ctx, "pr", lines.join("\n"), { runs });
          return;
        }

        if (trimmed.toLowerCase().startsWith("--auto ")) {
          const specText = trimmed.slice(7).trim();
          const looksLikeIssue =
            /^https?:\/\/[^/]+\/(?:repos\/)?[^/]+\/[^/]+\/issues\/\d+/i.test(specText) ||
            /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(specText) ||
            /^#\d+$/.test(specText);
          const receipt = await bridge.getPrPipeline().run({
            title: looksLikeIssue ? undefined : specText,
            issueDescription: looksLikeIssue ? undefined : specText,
            githubIssueRef: looksLikeIssue ? specText : undefined,
            liveLlm: true,
            keepFeatureBranchCheckedOut: true
          });
          emitReport(
            ctx,
            "pr",
            receipt.prMarkdown,
            receipt,
            receipt.status === "ready" ? "info" : "warning"
          );
          return;
        }

        if (trimmed.toLowerCase().startsWith("run ")) {
          const body = trimmed.slice(4).trim();
          const [rawTitle, rawDesc] = body.includes("::")
            ? body.split("::", 2)
            : [body, body];
          const receipt = await bridge.getPrPipeline().run({
            title: (rawTitle ?? "").trim(),
            issueDescription: (rawDesc ?? rawTitle ?? "").trim(),
            keepFeatureBranchCheckedOut: true
          });
          emitReport(
            ctx,
            "pr",
            receipt.prMarkdown,
            receipt,
            receipt.status === "ready" ? "info" : "warning"
          );
          return;
        }

        emitReport(
          ctx,
          "pr",
          "Usage: `/pr list`, `/pr run <title> :: <description>`, or `/pr --auto <issueUrlOrTitle>`",
          { error: "invalid_pr_subcommand" },
          "warning"
        );
      }
    });

    // 5. `/handoff [--switch] <goal>` (adapted from Pi `examples/extensions/handoff.ts`)
    pi.registerCommand("handoff", {
      description:
        "Extract secret-scrubbed session context for <goal> into a clean parentSession-linked child session",
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = bridge.getHarness();
        if (!h) throw new Error("Harness not initialized.");
        let goal = rawArgs.trim();
        let switchImmediately = false;
        if (goal.startsWith("--switch ")) {
          switchImmediately = true;
          goal = goal.slice("--switch ".length).trim();
        }
        if (!goal) {
          emitReport(
            ctx,
            "handoff",
            "Usage: `/handoff [--switch] <goal for focused child session>`",
            { error: "missing_handoff_goal" },
            "warning"
          );
          return;
        }

        const brief = await bridge.getHandoffController().generateHandoffBrief({
          sessionManager: h.session.sessionManager,
          goal,
          trustArtifacts: h.trustArtifacts,
          modelRuntime: h.modelRuntime,
          model: h.session.model
        });

        const sessionDir =
          h.session.sessionManager.getSessionDir() ||
          path.join(bridge.getWorkspaceRoot(), ".harness", "sessions");
        const created = bridge.getHandoffController().createChildHandoffSessionFile({
          cwd: bridge.getWorkspaceRoot(),
          sessionDir,
          parentSessionFile: brief.parentSessionFile,
          brief
        });

        const fullResult = {
          ...brief,
          childSessionId: created.childSessionId,
          childSessionFile: created.childSessionFile,
          switched: false
        };

        const report = [
          `# Session Handoff Ready (\`${created.childSessionId}\`)`,
          `- **Parent Session**: \`${brief.sourceSessionId}\``,
          `- **Child Session File**: \`${created.childSessionFile}\``,
          `- **Touched Files (${brief.touchedFiles.length})**: ${brief.touchedFiles.join(", ") || "(none)"}`,
          "",
          brief.briefMarkdown
        ].join("\n");

        emitReport(ctx, "handoff", report, fullResult);

        if (switchImmediately) {
          await ctx.switchSession(created.childSessionFile);
        }
      }
    });

    // 6. `/preset [list | <name> | clear]` (adapted from Pi `examples/extensions/preset.ts` with 0 prefix drift)
    pi.registerCommand("preset", {
      description:
        "List, activate, or clear named agent presets (plan, implement, review, fast-local) with zero static-prefix drift",
      getArgumentCompletions: (prefix) =>
        ["list", "plan", "implement", "review", "fast-local", "clear"]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = bridge.getHarness();
        if (!h) throw new Error("Harness not initialized.");
        const arg = rawArgs.trim();

        if (!arg || arg.toLowerCase() === "list") {
          const presets = bridge.getPresetController().listPresets();
          const active = bridge.getPresetController().getActivePreset();
          const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
            h.session.systemPrompt,
            h.session.agent.state.tools
          );
          const lines = [
            `# Pi-Apex Named Presets (active=\`${active?.name ?? "none"}\`, prefixHash=\`${livePrefixSha256.slice(0, 12)}...\`)`,
            ...presets.map(
              (p) => `- **\`${p.name}\`**${p.active ? " *(ACTIVE)*" : ""}: ${p.summary}`
            )
          ];
          emitReport(ctx, "preset", lines.join("\n"), {
            activePreset: active?.name ?? null,
            presets,
            livePrefixSha256
          });
          return;
        }

        const applied = await bridge
          .getPresetController()
          .applyPresetToSession(arg, h.session, h.modelRuntime);
        const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
          h.session.systemPrompt,
          h.session.agent.state.tools
        );
        const report = [
          `# Preset ${applied.activated ? `Activated: \`${applied.activated}\`` : "Cleared"}`,
          `- **Thinking Level**: \`${applied.thinkingLevel}\``,
          `- **Allowed Tools**: \`${applied.allowedTools.join(", ")}\``,
          `- **Pinned Prefix SHA-256**: \`${livePrefixSha256.slice(0, 16)}...\` (\`0\` drift)`,
          ...(applied.warnings.length > 0
            ? applied.warnings.map((w) => `- *Note*: ${w}`)
            : [])
        ].join("\n");
        emitReport(ctx, "preset", report, { ...applied, livePrefixSha256 });
      }
    });

    // 7. `/bookmark [list | add <label> | remove [entryId] | <label>]` (adapted from Pi `bookmark.ts`)
    pi.registerCommand("bookmark", {
      description:
        "List, add, or remove labeled entry bookmarks for session navigation & kernel-locked /tree rewind",
      getArgumentCompletions: (prefix) =>
        ["list", "add ", "remove"]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = bridge.getHarness();
        if (!h) throw new Error("Harness not initialized.");
        const trimmed = rawArgs.trim();

        if (!trimmed || trimmed.toLowerCase() === "list") {
          const bookmarks = bridge
            .getBookmarkController()
            .listBookmarks(h.session.sessionManager);
          const lines = [
            `# Session Bookmarks (${bookmarks.length})`,
            ...(bookmarks.length === 0
              ? ["- (no bookmarks — run `/bookmark <label>` to mark the latest turn)"]
              : bookmarks.map(
                  (b) => `- **\`${b.label}\`** (\`entryId=${b.entryId}\`, ${b.role ?? b.entryType}): ${b.preview}`
                ))
          ];
          emitReport(ctx, "bookmark", lines.join("\n"), { bookmarks });
          return;
        }

        if (trimmed.toLowerCase() === "remove" || trimmed.toLowerCase().startsWith("remove ")) {
          const targetId = trimmed.slice(6).trim() || undefined;
          const removed = bridge
            .getBookmarkController()
            .removeBookmark(h.session.sessionManager, targetId);
          if (!removed) {
            emitReport(
              ctx,
              "bookmark",
              "No bookmarked entry found to remove.",
              { removed: null },
              "warning"
            );
            return;
          }
          emitReport(
            ctx,
            "bookmark",
            `Removed bookmark \`${removed.removedLabel}\` from entry \`${removed.removedEntryId}\`.`,
            removed
          );
          return;
        }

        const label = trimmed.toLowerCase().startsWith("add ")
          ? trimmed.slice(4).trim()
          : trimmed;
        const created = bridge
          .getBookmarkController()
          .addBookmark(h.session.sessionManager, label);
        emitReport(
          ctx,
          "bookmark",
          `Bookmarked entry \`${created.entryId}\` as **\`${created.label}\`**.`,
          created
        );
      }
    });
  };
}
