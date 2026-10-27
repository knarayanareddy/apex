# Ring 14 — Task-aware chat modes and model routing

**Status:** Implemented in Ring 14; verification passes for routing logic, composer rendering, Ring 5 API integration and TypeScript. Real-browser review and the full regression gate remain open.  
**Date:** 2026-10-27  
**Separate from:** Rings A–F and Ring 13 document ingestion/export.

## Implementation status (2026-10-27)

- Added deterministic draft inference and explicit mode selection in the Mission Control composer; no text is sent for classification, and suggestions never select/dispatch themselves.
- Added optional `apex/auto` recommendation for likely complex tasks; the UI explains configured planner → implementer targets and changes the session model only when the user presses the separate action.
- API validates task-mode IDs. Plan mode enables the existing read-only Trust Artifact controller; Teamwork dispatches through `/swarm debate` and refuses attachments; browser/goal/schedule modes use bounded prompt framing. Schedule framing requires follow-up confirmation; no job is created by the mode selection.
- `npm run typecheck` passes; Ring 14 has **8 checks passed**; Ring 5 passes **6/6 gates**, including the invalid mode API rejection and unchanged active schema; Ring 13's isolated suite passes **38 assertions**. `npm audit --omit=dev` reports 0 vulnerabilities.
- Headless Chromium is unavailable, so no real-browser visual/interaction sign-off is claimed. Wider historical regression includes unresolved Ring 4 child-process timeout and Ring 7–9/11 Chromium blockers (documented in the Ring 13 spec). See `test/ring14/run-ring14-tests.ts`.

## Goal

Add a compact task-mode layer to the Mission Control composer. It locally proposes a task mode from the user's draft, explains the cues and any model recommendation, and waits for the user to accept or override it. Once the user sends, Pi-Apex routes through existing models/workflows where available. It must preserve the existing approval controller, Plan Mode, sandbox hard limits, and user-selected provider/model preferences.

## Scope

### Modes in v1

- **Quick answer** — normal one-turn prompt; no model or safety setting is changed.
- **Goal** — work through the requested outcome and verify completion within the current interactive run; never create unattended work implicitly.
- **Plan** — explicitly enables the existing read-only Plan Mode and asks for an actionable plan/Trust Artifact. Plan Mode remains visible and active until the operator exits it or approves/unlocks through existing controls.
- **Browser research** — prompt the existing deferred `browser_control` workflow for current/web-dependent tasks. The regular browser/network policy and any confirmations remain in force.
- **Teamwork** — explicitly dispatch text-only tasks through the existing `/swarm debate` command. Never dispatch from an inferred suggestion alone. Attachments are rejected with a clear message rather than silently omitted.
- **Schedule** — treat as a scheduling-design task. Ask the user to review/confirm the schedule details before using `cron_routine.create`; never create recurring or unattended work just because this mode was suggested or selected.

### Recommendation behavior

- A small deterministic, local heuristic runs in the browser as the draft changes; it sends no text to a model or server for classification.
- The suggestion displays the chosen mode and a short, human-readable reason. The default remains **Automatic / normal prompt** until the operator presses **Use suggestion** or selects a mode manually.
- The heuristic is advisory, ordered for clear intent (schedule, browser research, teamwork, plan, goal, then quick answer). Uncertain or unmatched text defaults to Quick answer and is labeled low-confidence; never silently select a special mode.
- For likely multi-step tasks, the UI may recommend `apex/auto` only when registered. Explain that it follows the configured planning → implementation targets. Do not change the active model unless the operator presses the separate model action. The existing model selector remains authoritative; no provider/key discovery or auto-install is triggered.
- Do not expose hidden chain-of-thought or pretend heuristics understand the user's full intent. Give observable cue-based reasons (e.g. “mentions current information” or “asks for a recurring run”).

## Routing and safety contract

- The API accepts only the declared mode IDs and treats all mode metadata as a user preference, not privileged instruction.
- Goal, browser, and schedule modes add concise task framing to the ordinary user prompt. They do not change approval mode or override tools/guardrails.
- Plan mode uses the existing `TrustArtifacts` Plan Mode controller, keeping writes read-only until the existing unlock/approval process.
- Teamwork mode dispatches the explicit user-sent goal to the existing `/swarm debate` command; it is text-only and reports that this invokes the orchestrator. Existing orchestrator safeguards still apply.
- Schedule mode requires an explicit confirmation step for recurring/unattended action; the first pass may prepare/clarify a schedule but must not create it automatically.
- Slash commands continue to work as slash commands; task modes must not reinterpret or wrap them. Steer messages do not change the selected mode.
- Suggestions never trigger a tool, browser visit, model switch, plan-mode change, schedule, or multi-agent run. Those require the visible user choice and Send action (plus any existing confirmations).
- Model selection is explicit and session-scoped. No hidden per-turn provider switching, credentials handling, or unsupported-provider claims.

## UI and API

- Add an accessible task-mode selector and recommendation panel beside the composer, with **Use suggestion**, manual override, reason, and a separate optional model suggestion/action.
- On submit, send one enum `taskMode` with the existing prompt. Server validates it before any model/tool activity; invalid IDs return HTTP 400.
- Render the selected mode in the pending/transcript turn so the user can tell what was sent. On send failure, preserve the draft and selected mode.
- Existing quick model selection, persona/profile controls, plan toggle, slash commands, document/image/audio flows remain compatible. Teamwork rejects document/image attachments rather than dropping them.

## Testing and acceptance

- Unit tests cover deterministic classifier precedence, confidence, rationale safety, and no-network/local-only behavior.
- UI rendering checks prove selector/options, accessibility labels, explicit accept/override, model rationale and no automatic selection.
- API tests cover valid/invalid mode IDs, ordinary prompt compatibility, plan mode activation/read-only behavior, browser/task framing, safe schedule framing, explicit teamwork dispatch, attachment rejection for teamwork, slash-command preservation, and failure recovery.
- Verify the existing model selector remains authoritative and optional `apex/auto` recommendation does not change model until the user chooses it.
- Run Ring 14 integration/security tests, typecheck, Rings 0–13 regression where feasible, and document environmental browser-test blockers accurately.
- Turbo/Auto interaction settings still affect confirmation prompts only; hard guardrails remain non-overridable.

## Non-goals for v1

- Side conversations that run independently without interrupting the current session (`ask`).
- Automatically continuing tasks after the current interactive turn, autonomous retries, or background `goal` execution.
- A complete Antigravity action/skills catalog (`compact`, `learn`, customization guides, cinematic workflows, etc.). Existing commands/tools remain discoverable via their existing UI.
- LLM-based intent classification, hidden reasoning, auto-provider selection, or per-task credentials.
- Visual redesign beyond the targeted composer addition; Warm Editorial direction remains subject to user review.
