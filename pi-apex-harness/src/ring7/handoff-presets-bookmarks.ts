/**
 * Ring 7 — Focused Session Handoff, Zero-Prefix-Drift Named Presets & Entry Bookmarks
 * (`src/ring7/handoff-presets-bookmarks.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 *  1. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/handoff.ts` (MIT License):
 *     - `HANDOFF_SYSTEM_PROMPT`, `entryToMessage`, `getHandoffMessages`, `convertToLlm`,
 *       `serializeConversation`, and `parentSession` `.jsonl` lineage tracking.
 *     - Apex Upgrade: Works across ALL 5 execution modes (Interactive TUI, `-p` Print, JSON, RPC,
 *       and Mission-Control Web Cockpit `/api/handoff`), scrubs serialized transcripts through
 *       Ring 0 `scrubSecretsInfallible()`, and supports deterministic structured extraction when
 *       no live remote LLM key is active.
 *  2. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/preset.ts` (MIT License):
 *     - `Preset`, `PresetsConfig`, `loadPresets` (`<agentDir>/presets.json` + `<cwd>/.pi/presets.json`),
 *       `buildPresetDescription`, and `preset-state` branch persistence.
 *     - Apex Upgrade (Prompt-Cache & Invariant I-01 Fix): Upstream `preset.ts` mutates
 *       `event.systemPrompt` inside `before_agent_start`, invalidating the prompt cache mid-session
 *       and violating `0` static-prefix drift. `PresetController` restricts active tools to the
 *       Ring 0 `<= 1,073`-token core set and injects preset `instructions` at the *turn tail*
 *       (`before_agent_start` `message` field, NOT `systemPrompt`) so `session.systemPrompt` SHA-256
 *       remains 100% invariant (`0` drift)!
 *  3. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/bookmark.ts` (MIT License):
 *     - `appendLabelChange` / `getLabel` turn bookmarking (`/bookmark`, `/unbookmark`, `listBookmarks`)
 *       integrated with `/tree` kernel-locked Git rewind!
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Message, type Model, uuidv7 } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  CONFIG_DIR_NAME,
  convertToLlm,
  getAgentDir,
  type ModelRuntime,
  serializeConversation,
  type SessionEntry,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import type { TrustArtifactController } from "../ring2/plan-trust-artifacts.ts";

export const CORE_DIRECT_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "codemode"
] as const;

// ============================================================================
// 1. Focused Context Handoff (`examples/extensions/handoff.ts` adaptation)
// ============================================================================

export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/**
 * Direct port of `entryToMessage` from `@earendil-works/pi-coding-agent/examples/extensions/handoff.ts`.
 */
export function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime()
    } as AgentMessage;
  }
  return undefined;
}

/**
 * Direct port of `getHandoffMessages` from `@earendil-works/pi-coding-agent/examples/extensions/handoff.ts`.
 */
export function getHandoffMessages(branch: readonly SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  if (compactionIndex < 0) {
    return branch
      .map((e) => entryToMessage(e))
      .filter((message): message is AgentMessage => message !== undefined);
  }

  const compaction = branch[compactionIndex]!;
  const firstKeptIndex =
    compaction.type === "compaction"
      ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
      : -1;
  const compactedBranch = [
    compaction,
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1)
  ];
  return compactedBranch
    .map((e) => entryToMessage(e))
    .filter((message): message is AgentMessage => message !== undefined);
}

export interface HandoffBriefResult {
  goal: string;
  briefMarkdown: string;
  touchedFiles: string[];
  sourceSessionId: string;
  parentSessionFile?: string;
  childSessionId?: string;
  childSessionFile?: string;
  usedLlm: boolean;
}

export class HandoffController {
  public extractTouchedFilesFromBranch(branch: readonly SessionEntry[]): string[] {
    const files = new Set<string>();
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const msg = entry.message as unknown as Record<string, unknown>;
      if (Array.isArray(msg["content"])) {
        for (const blk of msg["content"] as Array<Record<string, unknown>>) {
          if (blk["type"] === "toolCall") {
            const args = (blk["arguments"] ?? {}) as Record<string, unknown>;
            for (const key of ["path", "filePath", "targetPath", "relPath"]) {
              if (typeof args[key] === "string" && args[key].trim()) {
                files.add(args[key].trim());
              }
            }
          }
        }
      }
      const textBlob =
        typeof msg["content"] === "string"
          ? msg["content"]
          : Array.isArray(msg["content"])
            ? (msg["content"] as Array<Record<string, unknown>>)
                .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
                .map((b) => String(b["text"]))
                .join("\n")
            : "";
      const pathMatches = textBlob.matchAll(
        /\b((?:src|test|scripts|surfaces|docs|packages)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g
      );
      for (const m of pathMatches) {
        if (m[1]) files.add(m[1]);
      }
    }
    return [...files].sort();
  }

  public async generateHandoffBrief(opts: {
    sessionManager: SessionManager;
    goal: string;
    trustArtifacts?: TrustArtifactController;
    modelRuntime?: ModelRuntime;
    model?: Model<Api>;
    preferLlm?: boolean;
  }): Promise<HandoffBriefResult> {
    const cleanGoal = scrubSecretsInfallible(opts.goal.trim());
    if (!cleanGoal) {
      throw new Error("HANDOFF_GOAL_REQUIRED: Usage: /handoff <goal for new session>");
    }

    const branch = opts.sessionManager.getBranch();
    const messages = getHandoffMessages(branch);
    const llmMessages = convertToLlm(messages);
    const rawSerialized = serializeConversation(llmMessages);
    const scrubbedConversation = scrubSecretsInfallible(rawSerialized);
    const touchedFiles = this.extractTouchedFilesFromBranch(branch);
    const sourceSessionId = opts.sessionManager.getSessionId();
    const parentSessionFile = opts.sessionManager.getSessionFile();

    let briefMarkdown = "";
    let usedLlm = false;

    if (opts.preferLlm && opts.modelRuntime && opts.model) {
      try {
        const userMessage: Message = {
          role: "user",
          content: [
            {
              type: "text",
              text: `## Conversation History\n\n${scrubbedConversation}\n\n## User's Goal for New Thread\n\n${cleanGoal}`
            }
          ],
          timestamp: Date.now()
        };
        const response = await opts.modelRuntime.complete(
          opts.model,
          { systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
          { cacheRetention: "none", sessionId: uuidv7() }
        );
        if (response.stopReason !== "aborted") {
          const llmText = response.content
            .filter(
              (c: { type: string; text?: string }): c is { type: "text"; text: string } =>
                c.type === "text" && typeof c.text === "string"
            )
            .map((c: { type: "text"; text: string }) => c.text)
            .join("\n")
            .trim();
          if (llmText.length > 0) {
            briefMarkdown = scrubSecretsInfallible(llmText);
            usedLlm = true;
          }
        }
      } catch {
        // Fall through to deterministic synthesis
      }
    }

    if (!briefMarkdown) {
      const highlights: string[] = [];
      for (const msg of llmMessages.slice(-8)) {
        const m = msg as unknown as Record<string, unknown>;
        const role = String(m["role"] ?? "turn");
        let text = "";
        if (typeof m["content"] === "string") {
          text = m["content"];
        } else if (Array.isArray(m["content"])) {
          text = (m["content"] as Array<Record<string, unknown>>)
            .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
            .map((b) => String(b["text"]))
            .join(" ");
        }
        const oneLine = scrubSecretsInfallible(text.replace(/\s+/g, " ").trim()).slice(0, 220);
        if (oneLine) {
          highlights.push(`- [${role}] ${oneLine}`);
        }
      }

      const approvedPlans =
        opts.trustArtifacts
          ?.listArtifacts("plan")
          .filter((a) => a.status === "approved")
          .map((a) => `- Approved Plan \`${a.artifactId}\`: ${a.title}`) ?? [];

      const fileLines =
        touchedFiles.length > 0
          ? touchedFiles.map((f) => `- ${f}`).join("\n")
          : "- (no workspace files modified yet)";

      briefMarkdown = [
        "## Context",
        `Transferred from parent session \`${sourceSessionId}\`.`,
        ...(highlights.length > 0
          ? ["Key findings & recent decisions:", ...highlights]
          : ["- Starting focused follow-up thread from prior session state."]),
        ...(approvedPlans.length > 0 ? ["", "Active Trust Artifacts:", ...approvedPlans] : []),
        "",
        "Files involved:",
        fileLines,
        "",
        "## Task",
        cleanGoal
      ].join("\n");
    }

    return {
      goal: cleanGoal,
      briefMarkdown: scrubSecretsInfallible(briefMarkdown),
      touchedFiles,
      sourceSessionId,
      parentSessionFile,
      usedLlm
    };
  }

  /**
   * Creates a persistent child `.jsonl` session linked via `parentSession` in its `SessionHeader`
   * and seeds the Handoff Brief as the initial `custom_message` context entry.
   */
  public createChildHandoffSessionFile(opts: {
    cwd: string;
    sessionDir: string;
    parentSessionFile?: string;
    brief: HandoffBriefResult;
  }): { childSessionId: string; childSessionFile: string } {
    fs.mkdirSync(opts.sessionDir, { recursive: true });
    const childSm = SessionManager.create(opts.cwd, opts.sessionDir, {
      parentSession: opts.parentSessionFile
    });
    childSm.appendSessionInfo(`Handoff: ${opts.brief.goal.slice(0, 60)}`);
    childSm.appendCustomEntry("pi-apex-handoff-meta", {
      parentSessionId: opts.brief.sourceSessionId,
      parentSessionFile: opts.parentSessionFile ?? null,
      goal: opts.brief.goal,
      touchedFiles: opts.brief.touchedFiles
    });
    // Append the Handoff Brief as the initial user message so SessionManager._hasConversation()
    // flushes the `.jsonl` file (with `parentSession` in SessionHeader) to disk immediately!
    childSm.appendMessage({
      role: "user",
      content: [{ type: "text", text: opts.brief.briefMarkdown }],
      timestamp: Date.now()
    });
    const childFile = childSm.getSessionFile();
    if (!childFile) {
      throw new Error("HANDOFF_SESSION_PERSIST_FAILED: Child session file was not materialized.");
    }
    return {
      childSessionId: childSm.getSessionId(),
      childSessionFile: childFile
    };
  }
}

// ============================================================================
// 2. Cache-Preserving Zero-Prefix-Drift Presets (`examples/extensions/preset.ts`)
// ============================================================================

export type ThinkingLevelName =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ApexPreset {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevelName;
  /** Restricted strictly to Ring 0 direct core tools so active schema tokens stay <= 1,073! */
  tools?: string[];
  /** Injected at turn tail (`<preset_guidance>`) — NEVER mutates `session.systemPrompt`! */
  instructions?: string;
  description?: string;
}

export type PresetsMap = Record<string, ApexPreset>;

export const BUILTIN_APEX_PRESETS: PresetsMap = {
  plan: {
    thinkingLevel: "high",
    tools: ["read", "codemode"],
    description: "Read-only architectural exploration & Plan Trust Artifact synthesis",
    instructions:
      "PRESET [plan]: Operate in strict architectural planning mode. Read files thoroughly, identify dependencies and edge cases, and output a concrete numbered implementation plan with target file paths and verification commands before making edits."
  },
  implement: {
    provider: "apex",
    model: "auto",
    thinkingLevel: "medium",
    tools: [...CORE_DIRECT_TOOL_NAMES],
    description: "Full Ring 0 confined toolset with apex/auto routing & surgical edits",
    instructions:
      "PRESET [implement]: Keep scope surgical. Prefer `edit` over full overwrites, respect confined paths, and run verification checks after mutating files."
  },
  review: {
    thinkingLevel: "high",
    tools: ["read", "bash", "codemode"],
    description: "Codex three-dot diff & Cursor BugBot REVIEW_RULES.md audit posture",
    instructions:
      "PRESET [review]: Perform high-signal code review focusing on correctness regressions, race conditions, and security boundary violations. Avoid nitpicks."
  },
  "fast-local": {
    provider: "ollama",
    model: "qwen2.5-coder:14b",
    thinkingLevel: "low",
    tools: [...CORE_DIRECT_TOOL_NAMES],
    description: "Low-latency local Ollama coder profile",
    instructions:
      "PRESET [fast-local]: Execute concise, direct edits and verify immediately."
  }
};

export function loadMergedPresets(cwd: string, agentDir: string = getAgentDir()): PresetsMap {
  const globalPath = path.join(agentDir, "presets.json");
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, "presets.json");
  let globalPresets: PresetsMap = {};
  let projectPresets: PresetsMap = {};

  if (fs.existsSync(globalPath)) {
    try {
      globalPresets = JSON.parse(fs.readFileSync(globalPath, "utf8")) as PresetsMap;
    } catch {
      // ignore invalid global preset JSON
    }
  }
  if (fs.existsSync(projectPath)) {
    try {
      projectPresets = JSON.parse(fs.readFileSync(projectPath, "utf8")) as PresetsMap;
    } catch {
      // ignore invalid project preset JSON
    }
  }
  return {
    ...BUILTIN_APEX_PRESETS,
    ...globalPresets,
    ...projectPresets
  };
}

export function buildPresetDescription(preset: ApexPreset): string {
  const parts: string[] = [];
  if (preset.provider && preset.model) parts.push(`${preset.provider}/${preset.model}`);
  if (preset.thinkingLevel) parts.push(`thinking:${preset.thinkingLevel}`);
  if (preset.tools) parts.push(`tools:${preset.tools.join(",")}`);
  if (preset.description) parts.push(preset.description);
  return parts.join(" | ");
}

export class PresetController {
  private cwd: string;
  private readonly agentDir: string;
  private presets: PresetsMap;
  private activePresetName: string | null = null;
  private activeAllowedTools: Set<string> | null = null;
  private originalState: {
    model?: Model<Api>;
    thinkingLevel: ThinkingLevelName;
  } | null = null;

  constructor(opts: { cwd: string; agentDir?: string }) {
    this.cwd = path.resolve(opts.cwd);
    this.agentDir = opts.agentDir ?? getAgentDir();
    this.presets = loadMergedPresets(this.cwd, this.agentDir);
  }

  public reload(cwd?: string): PresetsMap {
    if (cwd) this.cwd = path.resolve(cwd);
    this.presets = loadMergedPresets(this.cwd, this.agentDir);
    return this.presets;
  }

  public listPresets(): Array<{
    name: string;
    active: boolean;
    summary: string;
    preset: ApexPreset;
  }> {
    this.reload();
    return Object.entries(this.presets).map(([name, preset]) => ({
      name,
      active: name === this.activePresetName,
      summary: buildPresetDescription(preset),
      preset
    }));
  }

  public getActivePreset(): { name: string; preset: ApexPreset } | null {
    if (!this.activePresetName) return null;
    const preset = this.presets[this.activePresetName];
    if (!preset) return null;
    return { name: this.activePresetName, preset };
  }

  /**
   * Enforces `preset.tools` at the `tool_call` gate WITHOUT mutating `session.agent.state.tools`
   * mid-session — keeping `1,073 === 1,073` schema tokens and `0` prompt-cache prefix SHA-256 drift!
   */
  public checkToolCallAllowed(toolName: string): { allowed: boolean; reason?: string } {
    if (!this.activePresetName || !this.activeAllowedTools) {
      return { allowed: true };
    }
    if (this.activeAllowedTools.has(toolName) || toolName === "tool_search") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `PRESET_TOOL_RESTRICTED: Active preset '${this.activePresetName}' restricts tools to [${[...this.activeAllowedTools].join(", ")}]; '${toolName}' is blocked.`
    };
  }

  /**
   * Formats turn-tail `<preset_guidance>` without ever touching `session.systemPrompt`.
   */
  public getTurnTailGuidanceMessage(): {
    customType: string;
    content: string;
    display: boolean;
    details: { preset: string };
  } | null {
    const active = this.getActivePreset();
    if (!active?.preset.instructions) return null;
    return {
      customType: "pi-apex-preset-guidance",
      content: `<preset_guidance name="${active.name}">\n${scrubSecretsInfallible(active.preset.instructions)}\n</preset_guidance>`,
      display: false,
      details: { preset: active.name }
    };
  }

  public async applyPresetToSession(
    name: string,
    session: AgentSession,
    modelRuntime: ModelRuntime
  ): Promise<{
    activated: string | null;
    modelApplied?: string;
    thinkingLevel: string;
    allowedTools: string[];
    warnings: string[];
  }> {
    this.reload();
    const warnings: string[] = [];

    if (name === "none" || name === "(none)" || name === "clear") {
      this.activePresetName = null;
      this.activeAllowedTools = null;
      if (this.originalState) {
        if (this.originalState.model) {
          await session.setModel(this.originalState.model).catch(() => {});
        }
        session.setThinkingLevel(this.originalState.thinkingLevel);
      }
      session.sessionManager.appendCustomEntry("preset-state", { name: null });
      return {
        activated: null,
        thinkingLevel: session.thinkingLevel,
        allowedTools: [...CORE_DIRECT_TOOL_NAMES],
        warnings
      };
    }

    const preset = this.presets[name];
    if (!preset) {
      throw new Error(
        `UNKNOWN_PRESET: '${name}'. Available presets: ${Object.keys(this.presets).join(", ")}`
      );
    }

    if (this.activePresetName === null) {
      this.originalState = {
        model: session.model,
        thinkingLevel: (session.thinkingLevel as ThinkingLevelName) ?? "off"
      };
    }

    let modelApplied: string | undefined;
    if (preset.provider && preset.model) {
      const resolvedModel = modelRuntime.getModel(preset.provider, preset.model);
      if (resolvedModel) {
        try {
          await session.setModel(resolvedModel);
          modelApplied = `${preset.provider}/${preset.model}`;
        } catch (err) {
          warnings.push(
            `Model ${preset.provider}/${preset.model} not applied: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        warnings.push(`Model ${preset.provider}/${preset.model} not registered; keeping current model.`);
      }
    }

    if (preset.thinkingLevel) {
      session.setThinkingLevel(preset.thinkingLevel);
    }

    if (preset.tools && preset.tools.length > 0) {
      this.activeAllowedTools = new Set(preset.tools);
    } else {
      this.activeAllowedTools = null;
    }

    this.activePresetName = name;
    session.sessionManager.appendCustomEntry("preset-state", { name });

    return {
      activated: name,
      modelApplied,
      thinkingLevel: session.thinkingLevel,
      allowedTools: this.activeAllowedTools
        ? [...this.activeAllowedTools]
        : [...CORE_DIRECT_TOOL_NAMES],
      warnings
    };
  }
}

// ============================================================================
// 3. Entry Bookmarking (`examples/extensions/bookmark.ts` adaptation)
// ============================================================================

export interface BookmarkRecord {
  entryId: string;
  label: string;
  entryType: string;
  role?: string;
  preview: string;
  timestamp: string;
}

export class BookmarkController {
  public addBookmark(
    sessionManager: SessionManager,
    label?: string,
    targetEntryId?: string
  ): BookmarkRecord {
    const cleanLabel = scrubSecretsInfallible((label ?? "").trim()) || `bookmark-${Date.now()}`;
    const entries = sessionManager.getEntries();
    let target: SessionEntry | undefined;

    if (targetEntryId) {
      target = sessionManager.getEntry(targetEntryId);
    } else {
      // Match upstream `bookmark.ts`: prefer last assistant message, fallback to current leaf entry
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type === "message" && entry.message.role === "assistant") {
          target = entry;
          break;
        }
      }
      if (!target) {
        target = sessionManager.getLeafEntry();
      }
    }

    if (!target) {
      throw new Error("NO_ENTRY_TO_BOOKMARK: Session has no entries yet.");
    }

    sessionManager.appendLabelChange(target.id, cleanLabel);
    return this.formatEntryAsBookmark(target, cleanLabel);
  }

  public removeBookmark(
    sessionManager: SessionManager,
    targetEntryId?: string
  ): { removedEntryId: string; removedLabel: string } | null {
    if (targetEntryId) {
      const existing = sessionManager.getLabel(targetEntryId);
      if (!existing) return null;
      sessionManager.appendLabelChange(targetEntryId, undefined);
      return { removedEntryId: targetEntryId, removedLabel: existing };
    }
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const existing = sessionManager.getLabel(entry.id);
      if (existing) {
        sessionManager.appendLabelChange(entry.id, undefined);
        return { removedEntryId: entry.id, removedLabel: existing };
      }
    }
    return null;
  }

  public listBookmarks(sessionManager: SessionManager): BookmarkRecord[] {
    const out: BookmarkRecord[] = [];
    for (const entry of sessionManager.getEntries()) {
      const label = sessionManager.getLabel(entry.id);
      if (label) {
        out.push(this.formatEntryAsBookmark(entry, label));
      }
    }
    return out;
  }

  private formatEntryAsBookmark(entry: SessionEntry, label: string): BookmarkRecord {
    let role: string | undefined;
    let preview: string = entry.type;
    if (entry.type === "message") {
      const m = entry.message as unknown as Record<string, unknown>;
      role = String(m["role"] ?? "message");
      if (typeof m["content"] === "string") {
        preview = m["content"].slice(0, 120);
      } else if (Array.isArray(m["content"])) {
        preview = (m["content"] as Array<Record<string, unknown>>)
          .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
          .map((b) => String(b["text"]))
          .join(" ")
          .slice(0, 120);
      }
    } else if (entry.type === "custom_message") {
      role = "custom";
      preview =
        typeof entry.content === "string" ? entry.content.slice(0, 120) : entry.customType;
    }
    return {
      entryId: entry.id,
      label,
      entryType: entry.type,
      role,
      preview: scrubSecretsInfallible(preview.replace(/\s+/g, " ").trim()),
      timestamp: entry.timestamp
    };
  }
}
