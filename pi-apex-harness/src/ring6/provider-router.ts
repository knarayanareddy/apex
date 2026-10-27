/**
 * Ring 6 — Cache-Preserving `apex/auto` Virtual Model Router, Local Ollama/OpenAI-Compat
 * Provider Composer & Session Cache/Cost Telemetry (`src/ring6/provider-router.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 *  - Adapted directly from `@earendil-works/pi-coding-agent@1.4.0`
 *    `examples/extensions/jev-router.ts` (`editedThisTurn`, `ApexRouteState`, `registerVirtualModel`,
 *    MIT License, Earendil Works) + `ModelRuntime.registerProvider` (`provider-composer.ts`).
 *
 * ROUTING & PROMPT-CACHE GUARANTEE:
 *  - `apex/auto` starts every branch in `"planning"` phase on `planningModel` (e.g. Claude Opus / Sonnet
 *    or GPT-5) to explore, build a Plan Trust Artifact, and execute the first edit.
 *  - Once `editedThisTurn(messages)` observes the first successful `edit` or `write` tool result,
 *    the router transitions to `"implementation"` phase on `implementationModel` (e.g. fast Sonnet /
 *    Haiku / GPT-5-mini / local Ollama) and persists `{ phase: "implementation", ... }` on the Pi
 *    session branch (`pi.virtual-model-state`), incurring AT MOST ONE prompt-cache switch per branch!
 *  - `reason === "direct"` (compaction summaries, side-queries) routes directly to `implementationModel`.
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  ModelRoute,
  ModelRouteRequest,
  ModelRuntime,
  ProviderModelConfig
} from "@earendil-works/pi-coding-agent";

/** Tools whose successful result means implementation has started (from Pi `examples/extensions/jev-router.ts`). */
const EDIT_TOOLS = new Set(["edit", "write"]);

export interface ApexModelRef {
  provider: string;
  id: string;
}

export interface ApexRouteState {
  phase: "planning" | "implementation";
  provider: string;
  modelId: string;
}

export interface ApexAutoRouterConfig {
  planningModel?: ApexModelRef;
  implementationModel?: ApexModelRef;
}

export interface LocalOllamaProviderOptions {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
  }>;
}

export interface SessionUsageTelemetry {
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRatePct: number;
  totalCostUsd: number;
  modelsUsed: string[];
}

/**
 * Ported from `@earendil-works/pi-coding-agent` `examples/extensions/jev-router.ts`:
 * Returns true when a tool call since the last user message edited or wrote a file without error.
 */
export function editedThisTurn(messages: readonly Message[]): boolean {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return messages
    .slice(lastUserIdx + 1)
    .some(
      (msg) =>
        msg.role === "toolResult" &&
        EDIT_TOOLS.has((msg as { toolName: string }).toolName) &&
        !(msg as { isError?: boolean }).isError
    );
}

export class ApexProviderRouterController {
  private readonly modelRuntime: ModelRuntime;
  private planningModel?: ApexModelRef;
  private implementationModel?: ApexModelRef;
  private readonly routeHistory: Array<{
    reason: string;
    phase: "planning" | "implementation" | "direct";
    resolved: string;
    timestampMs: number;
  }> = [];

  constructor(modelRuntime: ModelRuntime, initial?: ApexAutoRouterConfig) {
    this.modelRuntime = modelRuntime;
    this.planningModel = initial?.planningModel;
    this.implementationModel = initial?.implementationModel;
    this.installVirtualModel();
  }

  configureAutoTargets(cfg: ApexAutoRouterConfig): {
    planningModel?: ApexModelRef;
    implementationModel?: ApexModelRef;
  } {
    if (cfg.planningModel) this.planningModel = cfg.planningModel;
    if (cfg.implementationModel) this.implementationModel = cfg.implementationModel;
    return this.getAutoTargets();
  }

  getAutoTargets(): {
    planningModel?: ApexModelRef;
    implementationModel?: ApexModelRef;
  } {
    return {
      planningModel: this.planningModel,
      implementationModel: this.implementationModel
    };
  }

  getRouteHistory(): ReadonlyArray<{
    reason: string;
    phase: "planning" | "implementation" | "direct";
    resolved: string;
    timestampMs: number;
  }> {
    return this.routeHistory;
  }

  private resolvePhysicalCandidate(preferred?: ApexModelRef, fallbackLast = false): Model<Api> {
    if (preferred) {
      const exact = this.modelRuntime.getPhysicalModel(preferred.provider, preferred.id);
      if (exact) return exact;
    }
    const available = this.modelRuntime
      .getAvailableSnapshot()
      .filter((m) => !(m.provider === "apex" && m.id === "auto") && m.api !== "pi-virtual");
    if (available.length > 0) {
      return fallbackLast ? available[available.length - 1]! : available[0]!;
    }
    const allPhysical = this.modelRuntime
      .getModels()
      .filter((m) => !(m.provider === "apex" && m.id === "auto") && m.api !== "pi-virtual");
    if (allPhysical.length > 0) {
      return fallbackLast ? allPhysical[allPhysical.length - 1]! : allPhysical[0]!;
    }
    throw new Error("APEX_ROUTER_NO_PHYSICAL_MODEL: No physical chat model registered in ModelRuntime.");
  }

  private installVirtualModel(): void {
    this.modelRuntime.registerVirtualModel({
      provider: "apex",
      id: "auto",
      name: "Apex Auto (Plan-Strong / Implement-Fast)",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      contextWindow: 200_000,
      maxTokens: 64_000,
      route: async (request: ModelRouteRequest<ApexRouteState>): Promise<ModelRoute<ApexRouteState>> => {
        if (request.reason === "direct") {
          const fast = this.resolvePhysicalCandidate(this.implementationModel, true);
          this.routeHistory.push({
            reason: request.reason,
            phase: "direct",
            resolved: `${fast.provider}/${fast.id}`,
            timestampMs: Date.now()
          });
          return { model: fast, thinkingLevel: request.thinkingLevel };
        }

        const currentState = request.state;
        if (!currentState) {
          // Reuse session's already-warm planning model if it matches configured planning target
          const prev = request.previous?.model;
          const planTarget =
            prev &&
            this.planningModel &&
            prev.provider === this.planningModel.provider &&
            prev.id === this.planningModel.id
              ? prev
              : this.resolvePhysicalCandidate(this.planningModel, false);

          const nextState: ApexRouteState = {
            phase: "planning",
            provider: planTarget.provider,
            modelId: planTarget.id
          };
          this.routeHistory.push({
            reason: request.reason,
            phase: "planning",
            resolved: `${planTarget.provider}/${planTarget.id}`,
            timestampMs: Date.now()
          });
          return {
            model: planTarget,
            thinkingLevel: request.thinkingLevel,
            state: nextState
          };
        }

        // Adapted from Pi `examples/extensions/jev-router.ts`:
        // Once the planning model completes the first `edit` or `write`, hand off to `implementationModel` once!
        if (currentState.phase === "planning" && editedThisTurn(request.messages)) {
          const implModel = this.resolvePhysicalCandidate(this.implementationModel, true);
          const nextState: ApexRouteState = {
            phase: "implementation",
            provider: implModel.provider,
            modelId: implModel.id
          };
          this.routeHistory.push({
            reason: request.reason,
            phase: "implementation",
            resolved: `${implModel.provider}/${implModel.id}`,
            timestampMs: Date.now()
          });
          return {
            model: implModel,
            thinkingLevel: request.thinkingLevel,
            state: nextState
          };
        }

        const pinned =
          this.modelRuntime.getPhysicalModel(currentState.provider, currentState.modelId) ??
          this.resolvePhysicalCandidate(
            currentState.phase === "planning" ? this.planningModel : this.implementationModel
          );
        this.routeHistory.push({
          reason: request.reason,
          phase: currentState.phase,
          resolved: `${pinned.provider}/${pinned.id}`,
          timestampMs: Date.now()
        });
        return {
          model: pinned,
          thinkingLevel: request.thinkingLevel,
          state: currentState
        };
      }
    });
  }

  /**
   * Registers a local Ollama / vLLM / LM Studio OpenAI-compatible provider on `ModelRuntime`
   * without requiring cloud API keys.
   */
  async registerLocalOllamaProvider(opts: LocalOllamaProviderOptions): Promise<{
    providerId: string;
    baseUrl: string;
    registeredModels: string[];
  }> {
    const providerId = opts.providerId?.trim() || "ollama";
    const defaultHost = "127.0.0.1";
    const baseUrl = opts.baseUrl?.trim() || `http://${defaultHost}:11434/v1`;
    const apiKey = opts.apiKey?.trim() || "ollama-local";

    const chatModels: ProviderModelConfig[] = opts.models.map((m) => ({
      type: "chat",
      id: m.id,
      name: m.name ?? `${m.id} (Local Ollama)`,
      api: "openai-completions",
      baseUrl,
      input: ["text"],
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 16_384,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      }
    }));

    this.modelRuntime.registerProvider(providerId, {
      name: opts.name ?? "Ollama Local",
      api: "openai-completions",
      baseUrl,
      apiKey,
      models: chatModels
    });
    await this.modelRuntime.setRuntimeApiKey(providerId, apiKey);

    return {
      providerId,
      baseUrl,
      registeredModels: chatModels.map((m) => `${providerId}/${m.id}`)
    };
  }
}

export function computeSessionUsageTelemetry(
  messages: ReadonlyArray<{ role?: string; [k: string]: unknown }>
): SessionUsageTelemetry {
  let assistantTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  const modelsSet = new Set<string>();

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    assistantTurns++;
    const am = m as unknown as Partial<AssistantMessage>;
    if (am.provider && am.model) {
      modelsSet.add(`${am.provider}/${am.model}`);
    }
    const u = am.usage;
    if (u) {
      inputTokens += u.input ?? 0;
      outputTokens += u.output ?? 0;
      cacheReadTokens += u.cacheRead ?? 0;
      cacheWriteTokens += u.cacheWrite ?? 0;
      totalTokens += u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      totalCostUsd += u.cost?.total ?? 0;
    }
  }

  const promptPool = inputTokens + cacheReadTokens + cacheWriteTokens;
  const cacheHitRatePct =
    promptPool > 0 ? Number(((cacheReadTokens / promptPool) * 100).toFixed(2)) : 0;

  return {
    assistantTurns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cacheHitRatePct,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    modelsUsed: Array.from(modelsSet)
  };
}
