export const TASK_MODES = ["quick", "goal", "plan", "browser", "teamwork", "schedule"] as const;
export type TaskMode = typeof TASK_MODES[number];
export type TaskModeSelection = TaskMode | "automatic";

export interface TaskModeSuggestion {
  mode: TaskMode;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export const TASK_MODE_RULES: Array<{ mode: TaskMode; pattern: RegExp; reason: string }> = [
  { mode: "schedule", pattern: /\b(?:schedule|recurring|every\s+(?:day|week|month|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|remind\s+me|one[- ]time\s+timer|run\s+(?:this|it)\s+(?:daily|weekly|monthly)|in\s+\d+\s+(?:minutes?|hours?|days?)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b)/i, reason: "Your draft mentions a recurring or timed run." },
  { mode: "browser", pattern: /\b(?:latest|current|today|recent|news|look\s+up|search\s+(?:the\s+)?web|browse|website|online|web\s+research)\b/i, reason: "Your draft asks for current or web-based information." },
  { mode: "teamwork", pattern: /\b(?:multi[- ]agent|teamwork|swarm|parallel\s+agents|use\s+(?:a\s+)?team|ask\s+(?:a\s+)?team\s+of\s+agents)\b/i, reason: "Your draft explicitly asks for coordinated agents." },
  { mode: "plan", pattern: /\b(?:plan|planning|outline|roadmap|architecture|design\s+before\s+(?:coding|implementing)|do\s+not\s+implement|don't\s+implement)\b/i, reason: "Your draft asks for planning or design before execution." },
  { mode: "goal", pattern: /\b(?:end[- ]to[- ]end|fully\s+complete|finish|implement|build|fix|migrate|refactor|deliver|until\s+(?:the\s+)?goal)\b/i, reason: "Your draft describes a multi-step outcome to complete and verify." },
];

export function inferTaskMode(text: string): TaskModeSuggestion {
  const normalized = text.trim();
  const rule = TASK_MODE_RULES.find((item) => item.pattern.test(normalized));
  const mode = rule?.mode ?? "quick";
  return {
    mode,
    confidence: rule ? "medium" : "low",
    reason: rule?.reason ?? "No strong workflow cue was detected; a quick answer is the conservative default.",
  };
}

export function isTaskMode(value: unknown): value is TaskMode {
  return typeof value === "string" && (TASK_MODES as readonly string[]).includes(value);
}

const MODE_INSTRUCTIONS: Record<TaskMode, string> = {
  quick: "Answer directly and concisely. Do not start background work.",
  goal: "Work toward the requested outcome within this interactive run, verify the result, and report any unfinished criteria. Do not create unattended or background work.",
  plan: "Produce an actionable plan/Trust Artifact and do not modify workspace files. Existing read-only Plan Mode and approval controls remain authoritative.",
  browser: "For claims that depend on current web information, use the available browser workflow and cite the pages consulted. Follow all existing browser/network approvals and policies.",
  teamwork: "Dispatch is handled by Pi-Apex's existing multi-agent orchestrator; do not pretend other agents were used unless its result is returned.",
  schedule: "Treat this as schedule design. Explain the exact timing, action, and scope and ask the user to confirm before creating any one-time or recurring unattended routine. Never create it during this turn without that separate confirmation.",
};

export function frameTaskPrompt(text: string, mode: TaskMode): string {
  return `[Operator-selected task approach: ${mode}. ${MODE_INSTRUCTIONS[mode]} This preference does not change approval behavior or override hard guardrails.]\n\n${text}`;
}

export function routeTaskModePrompt(text: string, selection: TaskModeSelection): { prompt: string; dispatch: "prompt" | "swarm"; enablePlanMode: boolean } {
  if (selection === "automatic") return { prompt: text, dispatch: "prompt", enablePlanMode: false };
  if (selection === "teamwork") return { prompt: `/swarm debate ${text}`, dispatch: "swarm", enablePlanMode: false };
  return { prompt: frameTaskPrompt(text, selection), dispatch: "prompt", enablePlanMode: selection === "plan" };
}
