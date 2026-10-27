# Ring 12 Specification — Provider Connections & Model Catalog Manager (`v4.2.0`, in progress)

**Status:** specification approved for implementation on 2026-10-26, with these operator decisions: runtime + optional models.dev metadata; API keys and Ollama first; multiple named connections per provider. Implementation is in progress. Current slice exposes installed runtime providers, searchable/paginated runtime and advisory models.dev catalogs, explicit catalog refresh, custom compatible connections, vault-backed credentials, test/enable/disable/disconnect, model favorites/recents, persisted preferences, a one-shot in-memory OpenRouter diagnostic with a fixed prompt and bounded request, and an opt-in temporary chat registration selectable in the normal model catalog for up to three turns or five minutes. The temporary chat key is first checked via an authenticated, redirect-rejecting OpenRouter `/models` request whose response body is discarded; rejected credentials fail before model registration. It is then held only in the live runtime registration and cleared by explicit stop, turn limit, timeout, or server shutdown; normal user prompts/replies use the ordinary transcript and guardrails. Transcript diagnostics expose only a fixed failure class, never the raw provider error. Mocked lifecycle coverage is in Ring 11/12; a real OpenRouter request was previously verified by the isolated probe, but the temporary multi-turn flow has not yet been exercised with a real key. Remaining acceptance gates are tracked in `SPEC_BIBLE.md`; the 2026-10-26 DNS-rebinding review gap has been remediated with a process-wide Undici dispatcher that validates and pins the actual DNS answer used for each socket connection, rejects non-global addresses (including mixed public/private answers and IPv4-mapped IPv6), and permits loopback only for explicitly local destinations. Ring 12 adversarial lookup tests cover rebinding and address classification; continue treating endpoint security as subject to full release verification. This spec is deliberately scoped to the existing Pi-Apex `ModelRuntime` and vault rather than claiming all OpenCode integrations are drop-in compatible.

## Additional approved diagnostic: one-shot OpenRouter request

Provide an explicit local Mission Control action for one real OpenRouter chat completion using an operator-entered one-time API key. Accept only a model ID and key; use the fixed OpenRouter HTTPS origin, a fixed non-sensitive probe prompt, at most one request, no retries, a short timeout, and a small output-token cap. Register a unique in-memory temporary runtime provider and always unregister it in `finally`; do not call vault APIs, store the credential, echo it in errors, log request data, write session/transcript/audit state, or retain the model reply beyond the response. The browser key field is password-typed, not persisted to storage, and cleared regardless of outcome. Return only a bounded reply/verification status, model ID and latency; error responses must be generic and secret-redacted. This is an optional diagnostic and does not enable or persist the provider connection. Tests must prove no vault/files/transcript mutation, temporary-provider cleanup on success/failure/timeout, request limits, and response/error secret redaction.

## Goal

Replace the current narrow onboarding/model dropdown with a first-class, local-first management experience for connecting multiple model providers and browsing large model catalogs. Support many provider integrations and hundreds of models where the installed runtime/provider catalog can actually serve them. Provider setup, credentials, model discovery, selection, and per-conversation model persistence must be understandable and safe.

## Product requirements

1. **Provider inventory and connection flow**
   - Add a dedicated **Providers & Models** page/drawer separate from the existing onboarding quick setup.
   - List supported built-in integrations discovered from the installed Pi AI/runtime provider registry; include each provider's supported auth modes and model APIs where available.
   - Add validated generic adapters for OpenAI-compatible endpoints, Anthropic-compatible endpoints, and local Ollama. Do not label a provider supported unless a real runtime API adapter exists.
   - Support adding, editing, testing, disabling, and removing a connection. Provider IDs and model IDs are stable normalized identifiers; names/URLs/headers are displayed with safe escaping.
   - Connection test is an explicit operator action. It reports safe status/error summaries and never returns credentials, authorization headers, or raw provider error bodies.

2. **Catalog discovery and management**
   - Aggregate models from the Pi runtime's built-in catalog, configured providers, local Ollama discovery, and an optional remote catalog source (default proposal: models.dev) fetched server-side with bounded timeout/response size and cached locally.
   - Remote catalog metadata is advisory only: it can populate a provider/model chooser but cannot execute code, silently add credentials, or auto-enable an integration. Importing a model/provider requires operator confirmation and successful runtime validation. Attribute the metadata source as models.dev (MIT; `https://models.dev/api.json`); no upstream provider code is copied or executed.
   - Provide server-side search, provider/type filters, capability badges (text/image/reasoning/context window), favorites, and recently used models. The UI must remain responsive with hundreds/thousands of entries (paginate/virtualize; do not ship an unbounded catalog into every chat render).
   - Permit explicit custom model definitions for compatible endpoints with validated required fields and conservative defaults. Unsupported/unknown capability claims are not presented as verified.
   - Refresh catalog on demand and at a bounded low-frequency cadence; show `last refreshed`, cache age, and stale/offline state. No startup network call is required for saved local/runtime catalogs.

3. **Credentials and endpoint security**
   - All secrets live only in the existing out-of-workspace `OnboardingVault` with restrictive file permissions; UI/API return only masked readiness, credential source, and last-validated status. Never write keys to workspace config, session transcripts, audit entries, errors, browser storage, or HTML.
   - Credential updates/removals take effect in the live `ModelRuntime` without restart when supported; otherwise clearly indicate restart requirement.
   - Validate endpoint schemes/hosts; default to HTTPS except loopback/local endpoints explicitly selected by the operator. Prevent SSRF to cloud metadata/private networks for non-local providers, restrict redirects, set request timeouts/size limits, and avoid forwarding ambient credentials across origins.
   - Secrets are sent only to the configured provider endpoint. Custom headers are secret-capable fields, stored encrypted/secret-side in vault (not plain provider metadata), masked in the UI, and must not override host/origin routing.

4. **Models in Studio**
   - Keep current per-conversation model persistence and session switching. Model selection is per saved conversation; switching one conversation must not mutate another. One active conversation per runtime remains the supported contract unless concurrent runtimes are separately designed.
   - Show unavailable/unconfigured states and a direct “Connect provider” action; prevent selection of models without valid configuration. Model capability checks (including image/reasoning) remain authoritative from runtime model metadata.
   - Keep virtual `apex/auto` behavior explicit and preserve existing profiles/reasoning clamp. Profile defaults cannot override a later explicit model choice.
   - Model/provider errors are safe, actionable, and do not leak provider response bodies or secrets.

5. **API proposal**
   - `GET /api/providers`: provider status summaries, auth modes, connection IDs; no secret values.
   - `POST /api/providers`: add/update/disable/remove/test/refresh actions, schema-validated; destructive removal requires explicit confirmation token/action.
   - `GET /api/models`: paginated/filterable catalog query and active conversation selection, retaining existing response compatibility where practical.
   - `POST /api/models`: retain existing set-model/reasoning actions and add favorite/refresh/import operations with strict validation.
   - Separate `/api/catalog` only if it improves boundary clarity; all provider/network operations execute server-side.
   - SSE events announce catalog/provider status changes without credentials or unbounded payloads.

6. **Observability and privacy**
   - Persistent audit records record provider/model IDs and action outcomes only; never credentials, custom secret headers, raw endpoint response bodies, or prompt content.
   - Connection testing and catalog refresh are operator-triggered, visible actions. No silent outbound telemetry.
   - Provide per-provider connection diagnostics and an exportable redacted configuration snapshot; import/export excludes secrets by default and requires explicit secure re-entry on another installation.

## Non-goals / boundaries

- Do not clone OpenCode branding or imply upstream code/provenance. Reuse Pi-Apex runtime/SDK functionality honestly and attribute any reused OSS code.
- Do not promise every OpenCode provider or automatic OAuth login flow until the installed SDK exposes and tests that specific integration.
- No arbitrary user-supplied plugin code, shell-based credential helpers, browser-direct provider calls, credential sharing across unrelated providers, or provider-controlled changes to execution modes/guardrails.
- No simultaneous independent active chat runtimes as part of this feature; per-saved-conversation model selection is retained.

## Acceptance gates (`R12-1`–`R12-7`)

- **R12-1 Provider inventory:** fixture the runtime registry; prove every advertised provider has a concrete registered adapter/auth path; generic compatible adapters reject malformed IDs, URLs, headers, and model definitions.
- **R12-2 Vault boundary:** add/update/remove credentials; assert `0600` and out-of-workspace storage; scan API/UI/log/audit/session/export responses for secrets; verify live runtime credential changes.
- **R12-3 Catalog scale:** serve large deterministic catalog fixtures; test pagination/search/filter/favorites/capability flags and bounded UI render size; cached/offline/stale/refresh behavior.
- **R12-4 Endpoint security:** SSRF/redirect/timeout/oversize tests, HTTPS-default tests, loopback opt-in tests, credential-origin isolation, and error-body redaction.
- **R12-5 Model/session semantics:** connect two providers, select models in two saved conversations, switch back/forth, verify independent selection, image/reasoning capability enforcement, and unchanged `apex/auto` behavior.
- **R12-6 Chromium UX:** connect/test/disconnect provider with mocked network, edit custom compatible model, search/filter large catalog, refresh/cache status, and verify no console errors or secret leakage.
- **R12-7 Release:** run complete suite and typecheck, package, extract/install, `/doctor`, UI launch, and verify schema/prefix invariants remain unchanged.

## Open decisions requiring user review before implementation

1. Should optional remote catalog metadata use **models.dev**, runtime-only catalogs, or both? Recommended: both, with remote metadata optional/advisory and explicitly refreshable.
2. Should initial credentials support be API keys only plus local Ollama, or also SDK-native OAuth flows where available? Recommended: API keys/local first; include OAuth only for integrations with complete SDK-native login/refresh lifecycle and tests.
3. Should users be able to add multiple named connections for the same provider (for example work/personal endpoints)? Recommended: yes, with separate connection IDs and isolated credentials.
4. Should the first implementation prioritize broad known-provider presets or a robust OpenAI-compatible custom endpoint workflow? Recommended: custom-compatible + Ollama + all genuinely supported built-in providers, catalogued from actual runtime capability rather than a fixed aspirational count.
