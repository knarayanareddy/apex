# Ring 16 — Connect-provider and model discovery UX spec

**Status:** implemented v1; automated typecheck and unit checks passed. Browser E2E not signed off because Headless Chromium is unavailable.  
**Scope:** simplify how the user connects an already supported provider or registers a compatible endpoint, then selects a model.

## Problem
Pi-Apex already has several separate paths: a built-in provider API-key form, a custom endpoint form that requires manually typing model metadata, local Ollama discovery, catalog browsing, and a model picker. That forces users to understand runtime registration and model capability metadata before they can connect.

## Goal / UX contract
Put a **Connect provider** action immediately beside the main model selector. The short guided flow is:
1. Choose a supported built-in provider, local Ollama, or a custom OpenAI-compatible endpoint.
2. Enter an API key in a masked field, or use the documented keyless local path.
3. Verify the endpoint/credential and discover models where the provider exposes a model-list endpoint.
4. Present the discovered models for selection in the same flow; activate the model only after explicit user selection.

If discovery is unsupported/unavailable, preserve an explicit manual model-ID fallback. Do not fabricate model capabilities. Unknown capabilities are shown as unknown and default to disabled/false in runtime config. Clearly distinguish endpoint-discovered, runtime-registered, and advisory catalog-only models.

## Baseline found in source
- `src/ring10/provider-manager.ts`: named isolated custom connections, `OnboardingVault`, 0600 connection store, custom model definitions, URL validation, provider registration and connection test. `add()` currently requires an API key and one or more manually supplied model records. `testConnection()` currently does not discover/populate models.
- `src/ring5/mission-control-server.ts`: `/api/providers` already supports custom add, test, enable/disable/remove. `/api/onboarding` handles built-in key save. `/api/models` lists runtime models and selects active model.
- `src/ring5/mission-control-ui.ts`: model selector; built-in key onboarding; separate manually entered custom-provider form; local Ollama discover; catalog-only models shown as advisory.
- No model capability should be inferred just because an endpoint returns an ID.

## Design decisions
- Preserve all current supported built-in adapters and provider allowlist. This task must not broaden unsupported provider claims.
- Built-in provider credentials remain managed by the existing key/vault flow; connecting means save/validate using existing runtime support, then show runtime models. Where current runtime cannot safely validate a key without making an inference call, explain that validation means credential saved and provider available; do not fake a successful health check.
- Generic endpoint discovery applies only to the existing supported `openai-compatible` adapter and uses `GET {baseUrl}/models`, with a timeout and strict response shape/size limits. `anthropic-compatible` remains manual model-ID unless existing adapter's actual discovery contract is confirmed.
- The connect wizard can create a staged custom connection after discovery; user confirms selected model before `set_model`. One connection may expose all valid IDs returned by the endpoint, but register them with conservative capability values (`input: ["text"]`, `reasoning: false`, configured conservative context/output defaults only when required by runtime schema). Do not label those defaults as observed facts.
- If no IDs can be discovered, allow manual model ID and display capability caveat. Do not persist guessed image/reasoning/tool support.
- Credentials are never included in GET responses, discovery results, error messages, UI text, or logs. Existing vault remains credential store. Custom endpoint key may be optional only for an explicit keyless-local path; cloud arbitrary public endpoint keylessness is not implied.
- Maintain existing URL safety policy: HTTPS for non-loopback, block DNS/IP private and non-public addresses; loopback HTTP only. Apply validation before any request; revalidate/guard redirects to prevent SSRF. Do not let endpoint response choose arbitrary redirect targets.
- Discovery must be explicit on connect/refresh, bounded, cancellable if feasible, and failures must preserve prior connection/model configuration.
- Keep multiple isolated named connections; do not collapse credentials by provider family.
- Keep routing/workflow independent: choosing or connecting a provider does not enable Ring 15 auto-routing or select workflow actions.

## UI plan
- Add a compact Connect provider button beside `chatModelSelect`; opens an accessible modal/wizard, not another dense settings form.
- Step one choices: existing built-in providers (runtime-supported), local Ollama, custom OpenAI-compatible endpoint.
- Built-in path: select provider, masked key, Save & continue, then show runtime models available for this provider with active model selection action.
- Ollama path: reuse the existing discovery endpoint and display detected local models; no API key by default.
- Custom compatible path: connection name, base URL, optional key only when loopback/local is selected; discover; list IDs as endpoint-discovered with capability badges “not verified”; select a model; manual-ID entry if list unavailable.
- After success, add/update model selector and set requested active model only on explicit final selection. Surface validation failures without clearing form fields except secret field; clear secret on success/failure and never echo it.
- Keep advanced configuration/catalog controls in existing Settings/Library, but clearly distinguish them from the simple connect path.

## API/implementation plan
- Add pure response parsing for OpenAI-compatible `/models`: accept only bounded JSON object containing `data` array and valid `id` fields; cap response bytes, item count and ID/name lengths; de-duplicate, reject malformed IDs; never consume arbitrary metadata to set capabilities without a vetted mapping.
- Add provider manager discover/verify API. Validate URL before network. Use AbortSignal timeout, no redirects (or validate every redirect destination), and allow only approved URL policy. Return only safe provider/model names and IDs.
- Split staged discovery from persistence where possible; on final save validate then persist vault key + connection atomically as current manager does. Keyless local must not call vault save with empty key.
- Keep discovery optional in `add()` for backward compatibility/tests; existing API `add_custom` calls continue to work.
- Add explicit `/api/providers` action(s) for discover and add discovered custom provider. Validate payload strictly; never return API key.
- Add tests: model-list parsing, malformed/oversized list, duplicate IDs, response non-2xx, timeout, redirect/SSRF block, URL DNS private rebinding risk, keyless local handling, key redaction, existing manually configured fallback, test request integration, runtime model selectable after registration, and failure rollback.
- UI tests/manual smoke: model selector connect action, keyboard/modal accessibility, cloud supported provider path, loopback compatible endpoint path, Ollama path, manual fallback, error persistence, secret clearing, successful model selection.

## Acceptance criteria
1. User can open Connect provider from beside the model selector.
2. Supported built-in provider connection uses existing approved vault/runtime route and makes available models selectable without editing files.
3. Loopback OpenAI-compatible endpoint can be connected without a key; remote endpoint requires HTTPS and key unless an explicitly supported no-auth policy is documented.
4. Compatible endpoint discovery returns selectable model IDs only, with conservative and honest capability state.
5. If discovery is unsupported/fails/empty, user can manually enter a model ID with clear caveat.
6. User confirms model selection; connect alone does not silently alter active model or enable routing.
7. No secret appears in output/logs/GET; connections remain named and isolated.
8. Invalid endpoint, discovery, or vault failures do not destroy previous connection or change selected model.
9. Existing local security, provider allowlist, guardrail, hard-approval, and OAuth-lifecycle constraints remain intact.
10. Typecheck, unit/integration tests pass; do a live UI smoke where environment allows. If Chromium is unavailable, report no visual/E2E signoff.

## Non-goals
- Claim universal support for every commercial provider.
- Build an OAuth framework or add OAuth providers without full SDK-native lifecycle.
- Trust models.dev advisory metadata as proof of live availability/capability.
- Guess image/audio/tool/reasoning support from model names or bare `/models` entries.
- Auto-select a newly connected model, enable model routing, workflow dispatch, or bypass guardrails.
- Redesign unrelated Mission Control surfaces.

## Implementation and verification record (2026-10-27)

Implemented in v1:
- Added a **Connect provider** action beside the chat model selector; it opens the provider connection area.
- Consolidated built-in API-key entry and custom OpenAI-compatible endpoint setup inside the Connect provider disclosure. After a built-in key is saved, runtime-listed configured models are loaded for explicit selection in the same disclosure.
- Added bounded endpoint model discovery (`GET /models`), requiring a key for remote endpoints and allowing loopback keyless; only validated model IDs/names are returned. Endpoint redirects are rejected; request timeout and 2 MiB response limit are enforced.
- Custom provider connect registers all explicitly selected discovered IDs (or one manually entered ID), clears key fields, and explicitly selects the chosen active model after the user clicks Connect. Capabilities stay conservative (text only, no reasoning) and UI calls them unverified.
- Existing 0600 metadata and private-vault secret handling are preserved. Existing compatibility and Anthropic custom registration paths remain available only as before/advanced paths; model discovery is deliberately OpenAI-compatible-only.
- Updated Ring 14 tests to confirm workflow suggestions no longer carry model recommendations.

Verified:
- `npx --yes tsc --noEmit` — PASS.
- `npx --yes node@22 --experimental-strip-types test/ring12/run-ring12-tests.ts` — PASS, including bounded discovery, deduplication/invalid-ID filtering, keyless loopback and conservative capability defaults.
- `npx --yes node@22 --experimental-strip-types test/ring14/run-ring14-tests.ts` — PASS (8 checks).
- Rendered UI inline script parsed with Node 22 `--check` — PASS.
- `test/ring11/run-ring11-tests.ts` attempted but halted at its required Headless Chromium availability gate; browser E2E/visual review is not signed off.

Known limitation: the pre-existing built-in provider key-save API stores a key but does not preflight it. The UI says so explicitly. Custom endpoint discovery verifies that `/models` can be read, not that a model inference/tool call succeeds. Models are endpoint-listed, not necessarily account-entitled or feature-compatible. Ollama retains its pre-existing dedicated registration/discovery path; arbitrary compatible endpoints use the new wizard.

## Provenance
UX/design reference: OpenCode provider documentation and model-listing/discovery behavior, reviewed in `/home/user/pi-apex-harness/research/opencode-provider-onboarding-and-model-discovery-review-2026-10-27.md`. This spec does not claim code reuse. Any adapted code requires separately recorded upstream path/version/license and changes.
