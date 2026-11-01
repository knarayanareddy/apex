import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEncoding } from "js-tiktoken";
import type { GuardrailsConfig } from "../types.ts";

const o200k = getEncoding("o200k_base");

export class PrefixBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrefixBudgetError";
  }
}

export class PrefixMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrefixMutationError";
  }
}

export function countO200kTokens(text: string): number {
  if (!text) return 0;
  return o200k.encode(text).length;
}

export interface BootPinnedPrefix {
  readonly frozenSystemPrompt: string;
  readonly turn1OverflowAgentsAttachment: string | null;
  readonly componentTokens: {
    systemMd: number;
    toolGuidanceMd: number;
    memoryMd: number;
    rootAgentsMd: number;
    textTotal: number;
  };
  /** Set once effective session prompt & active tool schemas are inspected at session initialization. */
  lockToolSchemasAndComputeHash(
    tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>,
    effectiveBootSystemPrompt?: string
  ): {
    schemaTokens: number;
    totalPrefixTokens: number;
    prefixSha256: string;
  };
  /** Verifies neither `systemPrompt` nor active tool declarations drifted before a provider request. */
  verifyInvariantBeforeRequest(
    effectiveSystemPrompt: string,
    tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>
  ): string;
}

function summarizeLargeAgentsMd(rawAgentsMd: string, maxTokens: number): string {
  const headings = rawAgentsMd
    .split("\n")
    .filter((l) => /^#{1,3}\s+/.test(l))
    .slice(0, 12)
    .join("\n");
  let summary = `[Root AGENTS.md index (full file attached in Turn 1)]:\n${headings}`;
  while (countO200kTokens(summary) > maxTokens && summary.length > 40) {
    summary = summary.slice(0, summary.length - 32);
  }
  return summary;
}

/**
 * Builds an immutable, session-pinned system prompt snapshot at `session_start`.
 * Subsequent edits to `MEMORY.md` or `AGENTS.md` on disk NEVER mutate `frozenSystemPrompt` mid-session!
 */
export function buildBootPinnedPrefix(params: {
  surfacesDir: string;
  workspaceRoot: string;
  trustedRepo: boolean;
  caps: GuardrailsConfig["prefix_caps_o200k"];
}): BootPinnedPrefix {
  const readSurface = (name: string) => {
    const p = path.join(params.surfacesDir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  };

  const systemMd = readSurface("SYSTEM.md");
  const toolGuidanceMd = readSurface("TOOL_GUIDANCE.md");
  const memoryMd = readSurface("MEMORY.md");

  const systemTokens = countO200kTokens(systemMd);
  const guidanceTokens = countO200kTokens(toolGuidanceMd);
  const memoryTokens = countO200kTokens(memoryMd);

  if (systemTokens > params.caps.system_md) {
    throw new PrefixBudgetError(`SYSTEM.md exceeds cap (${systemTokens} > ${params.caps.system_md} o200k tokens)`);
  }
  if (guidanceTokens > params.caps.tool_guidance_md) {
    throw new PrefixBudgetError(
      `TOOL_GUIDANCE.md exceeds cap (${guidanceTokens} > ${params.caps.tool_guidance_md} o200k tokens)`
    );
  }
  if (memoryTokens > params.caps.memory_md) {
    throw new PrefixBudgetError(`MEMORY.md exceeds cap (${memoryTokens} > ${params.caps.memory_md} o200k tokens)`);
  }

  let rootAgentsSection = "";
  let turn1OverflowAgentsAttachment: string | null = null;
  const rootAgentsPath = path.join(params.workspaceRoot, "AGENTS.md");
  if (params.trustedRepo && fs.existsSync(rootAgentsPath)) {
    const rawAgents = fs.readFileSync(rootAgentsPath, "utf8").trim();
    if (countO200kTokens(rawAgents) <= params.caps.root_agents_md) {
      rootAgentsSection = rawAgents;
    } else {
      rootAgentsSection = summarizeLargeAgentsMd(rawAgents, params.caps.root_agents_md);
      turn1OverflowAgentsAttachment = rawAgents;
    }
  }
  const agentsTokens = countO200kTokens(rootAgentsSection);

  const sections = [systemMd, toolGuidanceMd, memoryMd, rootAgentsSection].filter(Boolean);
  const frozenSystemPrompt = sections.join("\n\n");
  const textTotal = countO200kTokens(frozenSystemPrompt);

  let lockedPrefixSha256: string | null = null;

  const serializeSchemas = (
    tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>
  ): string =>
    JSON.stringify(
      tools.map((t) => {
        let desc = t.description ?? "";
        if (t.name === "codemode") {
          desc = desc.replace(
            /Read \S+?\/docs\/codemode\.md first\./,
            "Read docs/codemode.md first."
          );
        }
        return {
          name: t.name,
          description: desc,
          parameters: t.parameters ?? null
        };
      })
    );

  return {
    frozenSystemPrompt,
    turn1OverflowAgentsAttachment,
    componentTokens: {
      systemMd: systemTokens,
      toolGuidanceMd: guidanceTokens,
      memoryMd: memoryTokens,
      rootAgentsMd: agentsTokens,
      textTotal
    },
    lockToolSchemasAndComputeHash(tools, effectiveBootSystemPrompt) {
      const promptToLock = effectiveBootSystemPrompt ?? frozenSystemPrompt;
      const effectivePromptTokens = countO200kTokens(promptToLock);
      const serialized = serializeSchemas(tools);
      const schemaTokens = countO200kTokens(serialized);
      if (schemaTokens > params.caps.direct_tool_schemas) {
        throw new PrefixBudgetError(
          `Direct tool schemas exceed cap (${schemaTokens} > ${params.caps.direct_tool_schemas} o200k tokens)`
        );
      }
      const totalPrefixTokens = effectivePromptTokens + schemaTokens;
      if (totalPrefixTokens > params.caps.total_max) {
        throw new PrefixBudgetError(
          `Total static prefix exceeds cap (${totalPrefixTokens} > ${params.caps.total_max} o200k tokens)`
        );
      }
      lockedPrefixSha256 = crypto
        .createHash("sha256")
        .update(promptToLock + "\n---TOOLS---\n" + serialized)
        .digest("hex");
      return { schemaTokens, totalPrefixTokens, prefixSha256: lockedPrefixSha256 };
    },
    verifyInvariantBeforeRequest(effectiveSystemPrompt, tools) {
      const serialized = serializeSchemas(tools);
      const currentHash = crypto
        .createHash("sha256")
        .update(effectiveSystemPrompt + "\n---TOOLS---\n" + serialized)
        .digest("hex");
      if (lockedPrefixSha256 === null) {
        lockedPrefixSha256 = currentHash;
      } else if (currentHash !== lockedPrefixSha256) {
        throw new PrefixMutationError(
          `PREFIX_INVARIANT_VIOLATION: expected static prefix SHA-256 ${lockedPrefixSha256}, got ${currentHash}`
        );
      }
      return currentHash;
    }
  };
}
