import type {
  CompactionEntryDraft,
  ContextEditEntryDraft,
  ProjectedSessionEntry,
  SessionBoundaryDraft,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { countO200kTokens } from "../core/prefix-budget.ts";
import type { StateDb } from "../core/state-db.ts";
import { syncSessionTranscriptDurable } from "../core/wal-recovery.ts";

export interface TwoStageCompactionOptions {
  /** Effective context window token budget (`o200k_base`). Default `128_000`. */
  contextWindowTokens?: number;
  /** Boot-pinned static prefix tokens (`systemPrompt + activeToolSchemas`). Default `2_100`. */
  staticPrefixTokens?: number;
  /** Utilization ratio (`0..1`) triggering Stage-1 `appendContextEdit` pruning (`0` LLM calls). Default `0.70`. */
  stage1TriggerRatio?: number;
  /** Utilization ratio (`0..1`) triggering Stage-2 `<compacted-summary>` if Stage 1 is insufficient. Default `0.80`. */
  stage2TriggerRatio?: number;
  /** Number of newest `toolResult` entries protected from Stage-1 pruning. Default `4`. */
  keepRecentToolResults?: number;
  /** Minimum `o200k_base` token size of an older `toolResult` to be pruned in Stage 1. Default `120`. */
  pruneMinToolTokens?: number;
  /** Number of newest projected entries retained verbatim after Stage-2 compaction. Default `6`. */
  keepRecentEntriesOnStage2?: number;
  /**
   * Optional async summarizer (`purpose: "compaction"`). Defaults to deterministic structured
   * `<compacted-summary>` extraction so Stage 2 remains functional even offline or without extra API keys.
   */
  summarizerFn?: (params: {
    entriesToSummarize: ProjectedSessionEntry[];
    purpose: "compaction";
  }) => Promise<string>;
}

export interface CompactionExecutionReceipt {
  stage1Triggered: boolean;
  stage2Triggered: boolean;
  tokensBefore: number;
  tokensAfterStage1: number;
  tokensAfterStage2: number;
  prunedEntryIds: string[];
  firstKeptEntryId: string | null;
  episodeId: number | null;
  boundaryDrafts: SessionBoundaryDraft[];
}

function serializeMessageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const rec = msg as { role?: string; toolName?: string; content?: unknown };
  if (typeof rec.content === "string") return rec.content;
  if (Array.isArray(rec.content)) {
    return rec.content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(rec.content ?? "");
}

export function countProjectedEntriesTokens(
  entries: readonly ProjectedSessionEntry[],
  staticPrefixTokens = 0
): number {
  let total = staticPrefixTokens;
  for (const e of entries) {
    for (const m of e.messages) {
      total += countO200kTokens(serializeMessageText(m)) + 6;
    }
  }
  return total;
}

/**
 * Extracts any `<scoped-context ...>...</scoped-context>` blocks inside a toolResult so Stage-1
 * pruning preserves active directory/glob rules while trimming bulky raw command/file output!
 */
function extractPreservedScopedContextTags(rawText: string): string {
  const matches = rawText.match(/<scoped-context\s+rule="[^"]+"\s+sha256="[0-9a-f]{64}">[\s\S]*?<\/scoped-context>/g);
  return matches && matches.length > 0 ? `\n${matches.join("\n")}` : "";
}

function buildPrunedToolPlaceholder(entry: ProjectedSessionEntry, rawText: string, tokCount: number): string {
  const firstMsg = entry.messages[0] as { toolName?: string; toolCallId?: string } | undefined;
  const toolName = firstMsg?.toolName ?? "tool";
  const lines = rawText.split("\n");
  const headPreview = lines.slice(0, 2).join(" | ").slice(0, 140);
  const preservedRules = extractPreservedScopedContextTags(rawText);
  return `[Stage-1 Context Pruned (${toolName}, ${tokCount} o200k tokens -> compact stub): ${headPreview}]${preservedRules}`;
}

/**
 * `dsh-compaction-basic` Structured `<compacted-summary>` Builder:
 * Preserves user goals, touched file paths, tool actions, errors/fixes, and constraints.
 */
export function buildStructuredCompactedSummary(entries: readonly ProjectedSessionEntry[]): {
  summaryXml: string;
  filesTouched: string[];
} {
  const userGoals: string[] = [];
  const filesSet = new Set<string>();
  const keyEvents: string[] = [];

  const filePathRegex = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`):,])/g;

  for (const e of entries) {
    for (const m of e.messages) {
      const role = (m as { role?: string }).role ?? "unknown";
      const txt = serializeMessageText(m).trim();
      if (!txt) continue;

      let fm: RegExpExecArray | null;
      while ((fm = filePathRegex.exec(txt)) !== null) {
        if (!fm[1].startsWith("node_modules/")) {
          filesSet.add(fm[1]);
        }
      }

      if (role === "user") {
        userGoals.push(`- ${txt.split("\n")[0].slice(0, 220)}`);
      } else if (role === "toolResult") {
        const tName = (m as { toolName?: string }).toolName ?? "tool";
        const isErr = Boolean((m as { isError?: boolean }).isError);
        const snippet = txt.split("\n")[0].slice(0, 160);
        keyEvents.push(`- [${tName}${isErr ? ":ERROR" : ""}] ${snippet}`);
      } else if (role === "assistant") {
        const firstLine = txt.split("\n")[0].slice(0, 200);
        if (firstLine) keyEvents.push(`- [assistant] ${firstLine}`);
      }
    }
  }

  const filesTouched = Array.from(filesSet).sort().slice(0, 30);
  const summaryXml = [
    `<compacted-summary purpose="compaction">`,
    `  <goals>`,
    ...(userGoals.length > 0 ? userGoals.slice(-8) : ["  - Continue active workspace task"]),
    `  </goals>`,
    `  <files-touched>${filesTouched.join(", ") || "none"}</files-touched>`,
    `  <progress>`,
    ...(keyEvents.length > 0 ? keyEvents.slice(-12) : ["  - Earlier context summarized"]),
    `  </progress>`,
    `</compacted-summary>`
  ].join("\n");

  return { summaryXml, filesTouched };
}

/**
 * Computes Stage-1 (`ContextEditEntryDraft`) and optional Stage-2 (`CompactionEntryDraft`) boundary drafts
 * for `@earendil-works/pi-coding-agent@1.4.0`'s `turn_end` boundary hook (Invariant I-10).
 *
 * Pruner ALWAYS runs first (`0` LLM calls); Stage 2 runs ONLY if utilization after Stage 1 still exceeds `stage2TriggerRatio`!
 */
export async function planTwoStageCompactionDrafts(params: {
  projectedEntries: readonly ProjectedSessionEntry[];
  stateDb?: StateDb;
  sessionId?: string;
  workspaceRoot?: string;
  options?: TwoStageCompactionOptions;
}): Promise<CompactionExecutionReceipt> {
  const opts = params.options ?? {};
  const contextWindow = opts.contextWindowTokens ?? 128_000;
  const staticPrefixTokens = opts.staticPrefixTokens ?? 2_100;
  const stage1Threshold = Math.floor(contextWindow * (opts.stage1TriggerRatio ?? 0.70));
  const stage2Threshold = Math.floor(contextWindow * (opts.stage2TriggerRatio ?? 0.80));
  const keepRecentToolResults = opts.keepRecentToolResults ?? 4;
  const pruneMinTokens = opts.pruneMinToolTokens ?? 120;
  const keepRecentEntries = opts.keepRecentEntriesOnStage2 ?? 6;

  const entries = params.projectedEntries.filter((e) => e.messages.length > 0);
  const tokensBefore = countProjectedEntriesTokens(entries, staticPrefixTokens);

  if (tokensBefore < stage1Threshold) {
    return {
      stage1Triggered: false,
      stage2Triggered: false,
      tokensBefore,
      tokensAfterStage1: tokensBefore,
      tokensAfterStage2: tokensBefore,
      prunedEntryIds: [],
      firstKeptEntryId: null,
      episodeId: null,
      boundaryDrafts: []
    };
  }

  // =========================================================================
  // Stage 1: Deterministic `appendContextEdit` Tool-Output Pruner (`0` LLM calls!)
  // =========================================================================
  const toolResultIndices: number[] = [];
  entries.forEach((e, idx) => {
    if (e.sourceEntry.type === "message" && e.messages[0]?.role === "toolResult") {
      toolResultIndices.push(idx);
    }
  });

  const prunableIndexSet = new Set(
    toolResultIndices.slice(0, Math.max(0, toolResultIndices.length - keepRecentToolResults))
  );

  const stage1Drafts: ContextEditEntryDraft[] = [];
  const prunedEntryIds: string[] = [];
  const simulatedAfterStage1: ProjectedSessionEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!prunableIndexSet.has(i)) {
      simulatedAfterStage1.push(entry);
      continue;
    }

    const rawText = serializeMessageText(entry.messages[0]);
    if (rawText.startsWith("[Stage-1 Context Pruned (")) {
      simulatedAfterStage1.push(entry);
      continue;
    }

    const tokCount = countO200kTokens(rawText);
    if (tokCount < pruneMinTokens) {
      simulatedAfterStage1.push(entry);
      continue;
    }

    const stubText = buildPrunedToolPlaceholder(entry, rawText, tokCount);
    const stubTokens = countO200kTokens(stubText);
    if (stubTokens >= tokCount) {
      simulatedAfterStage1.push(entry);
      continue;
    }

    stage1Drafts.push({
      type: "context_edit",
      targetId: entry.sourceEntry.id,
      replacement: {
        content: [{ type: "text", text: stubText }]
      }
    });
    prunedEntryIds.push(entry.sourceEntry.id);
    simulatedAfterStage1.push({
      sourceEntry: entry.sourceEntry,
      messages: [
        {
          ...(entry.messages[0] as object),
          content: [{ type: "text", text: stubText }]
        } as ProjectedSessionEntry["messages"][number]
      ]
    });
  }

  const tokensAfterStage1 = countProjectedEntriesTokens(simulatedAfterStage1, staticPrefixTokens);
  if (tokensAfterStage1 < stage2Threshold || simulatedAfterStage1.length <= keepRecentEntries) {
    return {
      stage1Triggered: stage1Drafts.length > 0,
      stage2Triggered: false,
      tokensBefore,
      tokensAfterStage1,
      tokensAfterStage2: tokensAfterStage1,
      prunedEntryIds,
      firstKeptEntryId: null,
      episodeId: null,
      boundaryDrafts: stage1Drafts
    };
  }

  // =========================================================================
  // Stage 2: Warm-Prefix `<compacted-summary>` (`CompactionEntryDraft`)
  // =========================================================================
  const splitIdx = Math.max(1, simulatedAfterStage1.length - keepRecentEntries);
  const olderRegion = simulatedAfterStage1.slice(0, splitIdx);
  const keptRegion = simulatedAfterStage1.slice(splitIdx);
  const firstKeptEntryId = keptRegion[0]?.sourceEntry.id ?? null;

  const deterministic = buildStructuredCompactedSummary(olderRegion);
  let summaryXml = deterministic.summaryXml;
  if (opts.summarizerFn) {
    const custom = await opts.summarizerFn({
      entriesToSummarize: olderRegion,
      purpose: "compaction"
    });
    summaryXml = custom.includes("<compacted-summary")
      ? custom
      : `<compacted-summary purpose="compaction">\n${custom.trim()}\n</compacted-summary>`;
  }

  let episodeId: number | null = null;
  if (params.stateDb && params.sessionId && params.workspaceRoot) {
    episodeId = params.stateDb.insertEpisode({
      sessionId: params.sessionId,
      repoRoot: params.workspaceRoot,
      summary: summaryXml,
      filesTouched: deterministic.filesTouched,
      outcome: "compacted_warm_prefix"
    });
  }

  const compactionDraft: CompactionEntryDraft = {
    type: "compaction",
    summary: summaryXml,
    firstKeptEntryId,
    details: {
      purpose: "compaction",
      prunedInStage1: prunedEntryIds.length,
      episodeId
    }
  };

  const tokensAfterStage2 =
    staticPrefixTokens +
    countO200kTokens(summaryXml) +
    8 +
    countProjectedEntriesTokens(keptRegion, 0);

  return {
    stage1Triggered: stage1Drafts.length > 0,
    stage2Triggered: true,
    tokensBefore,
    tokensAfterStage1,
    tokensAfterStage2,
    prunedEntryIds,
    firstKeptEntryId,
    episodeId,
    boundaryDrafts: [...stage1Drafts, compactionDraft]
  };
}

/**
 * Direct `SessionManager` executor applying Stage-1 `appendContextEdit` and optional Stage-2 `appendCompaction`
 * immediately onto a `SessionManager` (with `power-loss-safe` JSONL `fsync` when `stateDb` is provided).
 */
export async function applyTwoStageCompactionToSessionManager(params: {
  sessionManager: SessionManager;
  stateDb?: StateDb;
  workspaceRoot?: string;
  options?: TwoStageCompactionOptions;
}): Promise<CompactionExecutionReceipt> {
  const projection = params.sessionManager.buildSessionProjection();
  const receipt = await planTwoStageCompactionDrafts({
    projectedEntries: projection.entries,
    stateDb: params.stateDb,
    sessionId: params.sessionManager.getSessionId(),
    workspaceRoot: params.workspaceRoot,
    options: params.options
  });

  for (const draft of receipt.boundaryDrafts) {
    if (draft.type === "context_edit") {
      params.sessionManager.appendContextEdit(draft.targetId, draft.replacement);
    } else if (draft.type === "compaction") {
      params.sessionManager.appendCompaction(
        draft.summary,
        draft.firstKeptEntryId,
        receipt.tokensAfterStage1,
        draft.details,
        true
      );
    }
  }

  if (receipt.boundaryDrafts.length > 0 && params.stateDb) {
    const sf = params.sessionManager.getSessionFile();
    syncSessionTranscriptDurable(sf, params.stateDb.durabilityMode, Boolean(sf));
  }

  return receipt;
}
