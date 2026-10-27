export type ModelRouteBucket = "fast" | "planning" | "current";
export interface ModelRouteDecision {
  bucket: ModelRouteBucket;
  confidence: "high" | "low";
  reason: string;
}

const RESEARCH_CUE = /\b(?:latest|current|today|recent|news|browse|browser|search\s+(?:the\s+)?web|online|web\s+research|look\s+up|source\s+links?)\b/i;
const PLANNING_CUE = /\b(?:implement|build|debug|fix|refactor|migrate|architecture|multi[- ]step|end[- ]to[- ]end|comprehensive|integrat(?:e|ion)|security\s+review|design\s+the|write\s+tests?|test\s+suite|large[- ]scale)\b/i;
const SIMPLE_CUE = /\b(?:quick\s+answer|briefly|in\s+one\s+sentence|define|summari[sz]e|translate|what\s+does|what\s+is|who\s+is|explain\s+(?:briefly|simply))\b/i;

/**
 * Conservative local-only preflight. It deliberately does not call a model and only selects a
 * configured fast/planning target for clear cues; research and ambiguous requests stay put.
 */
export function classifyModelRoute(userText: string): ModelRouteDecision {
  const text = Array.from(String(userText ?? "").trim()).slice(0, 4000).join("");
  if (RESEARCH_CUE.test(text)) {
    return { bucket: "current", confidence: "high", reason: "Research/current-information cue: keep the selected model; workflow/tool choice remains separate." };
  }
  if (PLANNING_CUE.test(text)) {
    return { bucket: "planning", confidence: "high", reason: "Multi-step coding, planning, or verification cue: use the configured planning model." };
  }
  if (text.length <= 220 && SIMPLE_CUE.test(text)) {
    return { bucket: "fast", confidence: "high", reason: "Explicit short-answer, definition, or summary cue: use the configured implementation model." };
  }
  return { bucket: "current", confidence: "low", reason: "No sufficiently clear local routing cue: keep the selected model." };
}

export interface ConfiguredModelTarget { provider: string; id: string }
export interface AvailableRouteTargets {
  planningModel?: ConfiguredModelTarget;
  implementationModel?: ConfiguredModelTarget;
}

export function targetForDecision(decision: ModelRouteDecision, targets: AvailableRouteTargets): ConfiguredModelTarget | null {
  if (decision.confidence !== "high" || decision.bucket === "current") return null;
  return decision.bucket === "planning" ? targets.planningModel ?? null : targets.implementationModel ?? null;
}
