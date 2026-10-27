# Ring 15 — Submit-time local model preflight

**Status:** Spec-first; implementation follows this document.  
**Date:** 2026-10-27  
**Related:** Ring 14 task-mode UI in `task-aware-routing-spec.md`; this is model routing only, not workflow dispatch.

## Goal

Add an opt-in, deterministic local preflight that runs **after Send receives the complete user draft and before the first model call**. It can choose between the operator's explicitly configured Apex planning and implementation models, explains the chosen route in Mission Control, and restores the user's selected session model after the request. It never uses an LLM/classifier call.

## Scope and user contract

- Add a separate **Model routing** selector: `Keep selected model` (default) or `Auto route — configured models`.
- Auto routing is enabled only when both configured `ApexProviderRouterController` targets resolve to currently available, physical models. Do not invent candidates, use catalog defaults, fetch a remote model catalog, or select a provider/key outside those two explicit targets.
- Task/workflow modes remain a separate selector. `Teamwork`, `Schedule`, `Browser`, and `Plan` cannot be triggered by model-route classification. Existing explicit workflow behavior and approvals remain unchanged.
- The current task-mode option labeled `Automatic — use the normal prompt` must be renamed to `Normal prompt — no workflow override`; it is not a router.
- Submit-time classification uses only the current user-authored text (not prior chat history, document contents, hidden reasoning, or attachment bytes), with bounded Unicode/codepoint-safe text handling and no external request. A separate subsequent task workflow may still process the attachment normally.
- High-confidence simple/factual/explanation requests can route to the configured implementation/fast model. High-confidence multi-step coding, debugging, planning, architecture, review/security requests can route to the configured planning/strong model. Research/current-web requests and all ambiguous/unsupported inputs retain the currently selected model.
- Low confidence, missing/stale route targets, temporary-provider sessions, streaming/busy session, unsupported multimodal capability, or model-switch failure all fail closed to the user's selected model with a clear reason. Do not fail the user's task just because optional routing failed.
- No route switch is persisted as the new session/global default. Temporarily selected model must be restored in `finally` after success, error, or cancellation.
- The UI reports the classification/rationale and exact chosen model before generation starts (SSE/status), then includes the outcome in the prompt response. No text is stored in logs or telemetry beyond existing transcript behavior.

## Classifier contract

- A small pure deterministic function returns `{bucket: "fast" | "planning" | "current", confidence: "high" | "low", reason: bounded enum/string}`.
- Explicit user-task cues only; no inference about credentials, safety approval, or intent to execute side effects. Examples: “what does X mean?” / “summarize briefly” can be fast; “implement / debug / refactor / architecture / multi-step / comprehensive security review” can be planning; “latest / current / browse / search online” and unmatched tasks keep the selected model.
- Precedence: current-web/research and security-sensitive routing ambiguities stay on current; explicit high-complexity coding/architecture cues select planning; explicit short-answer cues select fast; otherwise current.
- No classifier-model dependency, prompt, telemetry, cache, or call. Evaluate accuracy on fixtures; document the classifier as a heuristic, not semantic understanding.

## Runtime and safety

- Validate `modelRouting` against the strict enum at `POST /api/prompt`; unknown values return HTTP 400 before model/tool activity.
- Classification occurs on the server from the submitted user text after body shape validation and before any model call; no LLM call is made.
- Model candidates come only from `routerController.getAutoTargets()` and `modelRuntime.getAvailableSnapshot()`/`getPhysicalModel()`. Require explicit configured targets and availability.
- If the target differs, temporarily call `session.setModel(target, { persist: false })`, invoke the regular prompt, and restore the original model in a `finally` block. Serialize/lock this section: reject a competing prompt/model change with HTTP 409 while a temporary route is active; never switch models in the middle of a streaming response.
- Do not auto-switch for explicit slash commands, steer messages, teamwork slash dispatch, or ephemeral temporary-provider sessions. Attachments are not classified; if an image is present, route only to a candidate that supports image input, otherwise retain current model.
- Keep Ring 0 hard denies, sandbox limits, approvals, Turbo semantics, and model-connection allowlists unchanged. Router output cannot authorize a tool/action.
- Emit only bounded routing metadata to SSE and response: tier, selected provider/model, confidence, and a fixed rationale. Do not echo the raw request into routing logs.

## UI

- Place `Model routing` beside the workflow selector, defaulting to `Keep selected model`.
- Show the explicitly configured planning and implementation targets; disable the Auto route option if either is unavailable and explain where to configure them.
- When Auto route is selected, show `Analyzing this submitted request locally…` at Send. Then show, before response generation, e.g. `Auto route → provider/model (planning): multi-step implementation cue. No classifier model call; session default will be restored.`
- Keep the session model picker authoritative: after the turn it returns to the original selection. Clearly distinguish the per-request route from the user's persistent model selection.
- Remove the pre-send task-mode model recommendation/action that changed the persistent session model; task-mode suggestions remain workflow-only.
- If fallback is used, display why (ambiguous, research, missing targets, image mismatch, temporary provider, route switch failed) and which model actually handled the turn.

## Tests and acceptance

- Unit tests: fixed text-to-bucket examples, precedence, low-confidence fallback, bounded reason, research/current-web exclusions, no raw prompt echo.
- API tests: invalid route ID rejects before work; default `current` preserves existing prompt behavior; Auto with unavailable targets falls back to current; successful Auto selects the configured target, returns a rationale, and restores the original model; errors/cancellation restore model; concurrent requests/model changes return 409; slash/steer/teamwork/ephemeral sessions bypass Auto; images never route to a non-image model.
- UI checks: default current model, no pre-send model change, Auto route disabled with incomplete target config, route status text uses `textContent`, and persistent selector returns to original model after response.
- Verify no extra model/API request is made by routing; measure classification CPU time locally, but do not claim semantic understanding or external-router quality.
- Run Ring 15, Ring 5, typecheck, and Ring 13 regression; broader Rings 0–14 where feasible. Real-browser review remains subject to Chromium availability.

## Non-goals

- LLM/remote intent classifier, embeddings, user-text logging, or router telemetry service.
- Default-on silent provider switching or credentials selection.
- Automatic browser/teamwork/schedule dispatch, background goals, or approval changes.
- Persistent model selection changes, catalog auto-discovery, model installs, or arbitrary provider/model IDs.
- Replacing `apex/auto` phase routing; this preflight is a separate optional request-level selector.
