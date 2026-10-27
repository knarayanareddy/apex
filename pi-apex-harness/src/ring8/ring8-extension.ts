/**
 * Ring 8 — Deferred `github_issue` Specialist Tool + `/issue` & `/bench` Zero-Token Slash Commands
 * + `#<num>` Interactive Issue Autocomplete (`src/ring8/ring8-extension.ts`).
 *
 * PRESERVED INVARIANTS:
 *  - `github_issue` registers with `exposure: "deferred"` (`+0` active schema tokens: `1,073 === 1,073`).
 *  - `/issue` and `/bench` register via `ExtensionAPI.registerCommand` (`+0` active schema tokens).
 *  - Zero mutation to `session.systemPrompt` (`0` static-prefix SHA-256 drift!).
 */

import path from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createIssueAutocompleteProvider,
  findGitMergeConflicts,
  formatMergeConflicts,
  type GitHubIssueBridge
} from "./github-issue-bridge.ts";
import {
  listPersistedBenchmarks,
  runPersonalSweBenchmarkSuite
} from "./swe-eval-bench.ts";

export interface Ring8Options {
  githubApiBaseUrl?: string;
}

export const RING8_SLASH_COMMANDS = ["issue", "bench"] as const;

export function createRing8Extension(bridge: {
  getWorkspaceRoot: () => string;
  getSurfacesDir: () => string;
  getIssueBridge: () => GitHubIssueBridge;
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}): ExtensionFactory {
  const GitHubIssueParams = Type.Object({
    action: Type.Union([
      Type.Literal("ingest"),
      Type.Literal("list"),
      Type.Literal("conflicts")
    ]),
    refOrUrl: Type.Optional(
      Type.String({
        description:
          "GitHub Issue URL ('https://github.com/owner/repo/issues/42'), 'owner/repo#42', or '#42'"
      })
    ),
    fixtureJsonPath: Type.Optional(
      Type.String({ description: "Optional workspace-relative JSON fixture path" })
    ),
    apiBaseUrl: Type.Optional(
      Type.String({ description: "Optional GitHub Enterprise / test REST base URL" })
    ),
    allowQuarantinedIssue: Type.Optional(
      Type.Boolean({
        description:
          "If true, sanitizes dangerous prompt-injection lines instead of hard-blocking"
      })
    )
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

    // 1. Wire `#<number>` TUI fuzzy issue autocomplete when interactive UI is active
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.addAutocompleteProvider((current) =>
        createIssueAutocompleteProvider(current, async () =>
          bridge.getIssueBridge().getCachedIssuesForAutocomplete()
        )
      );
    });

    // 2. Deferred `github_issue` specialist tool (`exposure: "deferred"` -> +0 schema tokens!)
    pi.registerTool({
      name: "github_issue",
      label: "Quarantine-Scanned GitHub Issue Bridge & Merge Conflict Inspector",
      description:
        "Ingests & scans untrusted GitHub Issues/comments via skills-guard-v10 (wrapping in <untrusted_github_issue>), lists ingested issues, or inspects Git merge conflict blocks.",
      parameters: GitHubIssueParams,
      exposure: "deferred",
      async execute(
        _toolCallId,
        params
      ): Promise<{ content: TextContent[]; details: unknown }> {
        const ib = bridge.getIssueBridge();
        switch (params.action) {
          case "list": {
            const ingestions = ib.listIngestions();
            return {
              content: [{ type: "text", text: JSON.stringify({ ingestions }, null, 2) }],
              details: { ingestions }
            };
          }
          case "conflicts": {
            const conflicts = findGitMergeConflicts(bridge.getWorkspaceRoot(), {
              scanAllTrackedIfNoUnmergedIndex: true
            });
            const formatted =
              conflicts.length > 0
                ? formatMergeConflicts("HEAD", conflicts)
                : "No unresolved Git conflict markers found.";
            return {
              content: [{ type: "text", text: formatted }],
              details: { conflicts }
            };
          }
          case "ingest": {
            const res = await ib.ingestIssue({
              refOrUrl: params.refOrUrl,
              fixtureJsonPath: params.fixtureJsonPath,
              apiBaseUrl: params.apiBaseUrl,
              allowQuarantinedIssue: params.allowQuarantinedIssue
            });
            return {
              content: [{ type: "text", text: res.isolatedPromptEnvelope }],
              details: res
            };
          }
        }
      }
    });

    // 3. `/issue [list | conflicts | ingest <refOrUrl> [--allow-quarantined]]`
    pi.registerCommand("issue", {
      description:
        "Ingest & quarantine-scan a GitHub Issue via skills-guard-v10 (`ingest <url|#num>`), list ingested issues (`list`), or inspect Git merge conflicts (`conflicts`)",
      getArgumentCompletions: (prefix) =>
        ["list", "conflicts", "ingest "]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const trimmed = rawArgs.trim();
        const ib = bridge.getIssueBridge();

        if (!trimmed || trimmed.toLowerCase() === "list") {
          const items = ib.listIngestions();
          const lines = [
            `# Quarantine-Scanned GitHub Issues (${items.length})`,
            ...(items.length === 0
              ? ["- (none ingested yet — run `/issue ingest owner/repo#42` or `/pr --auto <issueUrl>`)"]
              : items.map(
                  (i) =>
                    `- **\`${i.repo}#${i.number}\`** [scan=\`${i.scanVerdict}\`, findings=${i.findingsCount}, sanitized=${i.sanitized}] — ${i.title}`
                ))
          ];
          emitReport(ctx, "issue", lines.join("\n"), { ingestions: items });
          return;
        }

        if (trimmed.toLowerCase() === "conflicts") {
          const conflicts = findGitMergeConflicts(bridge.getWorkspaceRoot(), {
            scanAllTrackedIfNoUnmergedIndex: true
          });
          const text =
            conflicts.length > 0
              ? formatMergeConflicts("HEAD", conflicts)
              : "# Git Merge Conflict Audit\n- Clean — zero `<<<<<<<` conflict blocks found.";
          emitReport(ctx, "issue", text, { conflicts });
          return;
        }

        const allowQuarantined = /--allow-quarantined\b/i.test(trimmed);
        const refPart = trimmed
          .replace(/^ingest\s+/i, "")
          .replace(/--allow-quarantined\b/gi, "")
          .trim();

        const res = await ib.ingestIssue({
          refOrUrl: refPart,
          allowQuarantinedIssue: allowQuarantined
        });
        emitReport(ctx, "issue", res.isolatedPromptEnvelope, res);
      }
    });

    // 4. `/bench [run [--no-ab] | list]`
    pi.registerCommand("bench", {
      description:
        "Run or list the Personal SWE Eval & Harness² Prompt-Cache Benchmark Suite (`run`, `list`)",
      getArgumentCompletions: (prefix) =>
        ["run", "run --no-ab", "list"]
          .filter((v) => v.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value })),
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const trimmed = rawArgs.trim().toLowerCase();
        const wsRoot = bridge.getWorkspaceRoot();

        if (trimmed === "list") {
          const runs = listPersistedBenchmarks(wsRoot);
          const lines = [
            `# Persisted SWE Eval & Prompt-Cache Benchmarks (${runs.length})`,
            ...(runs.length === 0
              ? ["- (no benchmark runs persisted yet — run `/bench run`)"]
              : runs.map(
                  (b) =>
                    `- **\`${b.benchId}\`** model=\`${b.modelLabel}\` baseline=${b.baselinePassRatePct}%${b.evolvedPassRatePct !== undefined ? ` -> evolved=${b.evolvedPassRatePct}% (repairsSaved=${b.repairAttemptsSaved ?? 0})` : ""} cacheHit=${b.baselineCacheHitPct}%`
                ))
          ];
          emitReport(ctx, "bench", lines.join("\n"), { runs });
          return;
        }

        const compareAb = !trimmed.includes("--no-ab");
        const surfacesDir = bridge.getSurfacesDir();
        const report = await runPersonalSweBenchmarkSuite({
          surfacesTemplateDir: path.resolve(surfacesDir),
          persistWorkspaceRoot: wsRoot,
          compareExperienceAb: compareAb
        });
        emitReport(ctx, "bench", report.markdownReport, report);
      }
    });
  };
}
