# OpenCode provider onboarding and model discovery review

**Reviewed:** 2026-10-27  
**Scope:** How OpenCode makes adding a provider/API key and selecting models approachable; what can safely transfer to Pi-Apex.

## Executive summary

Yes: Pi-Apex can make the common path substantially simpler. The useful OpenCode mental model is **Connect provider → enter credential → choose a model** (the current Desktop flow exposes provider connection from the model picker; the CLI/TUI docs describe `/connect`, then `/models`). OpenCode does not literally obtain every provider/model from one universal live endpoint. Its provider support combines a catalog (Models.dev), provider-specific integrations and auth, configured models, and some runtime model discovery. For a compatible endpoint, runtime `/v1/models` discovery can expose models served by that endpoint. These sources have different metadata quality and compatibility guarantees.

Recommended Pi-Apex UX: one **Connect provider** wizard from the model selector; choose a supported provider or “OpenAI-compatible endpoint”; enter key into a password field (or select local/no-key); test and discover; show discovered models with clear capability/availability metadata; select one to activate. Preserve manual refresh and an explicit manual model-ID fallback for providers without discovery. Keep local Ollama and API-key providers first. Do not promise that every model returned by `/models` supports tools, multimodal input, or Pi's required API semantics.

## What OpenCode documents

The provider guide says OpenCode uses AI SDK integrations and Models.dev to support 75+ providers and local models. Its basic setup is adding a provider API key using `/connect` and configuring providers as needed. Credentials added through `/connect` are stored in `~/.local/share/opencode/auth.json`; provider settings can be customized in config. For a connected provider, the guide directs users to `/models` to choose a model. The Zen and Go flows are: connect, obtain/paste a key, then browse recommended models. [OpenCode provider guide](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx)

The `models [provider]` CLI command lists models from `Provider.list()` and supports filtering by provider, verbose metadata, and refreshing the Models.dev cache. This is evidence of a catalog/list layer, not proof that every listed model was freshly queried from the provider's API. [OpenCode models command](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/models.ts)

Current Desktop UX discussion in the repository notes a visible “Connect provider” action in the model picker. This supports putting connection at the point where users need a model, rather than making them navigate a separate configuration area. [OpenCode issue #47440](https://github.com/anomalyco/opencode/issues/47440)

## How model availability is assembled (and why “all models” needs a caveat)

The reviewed docs and code/search-indexed source show several paths:

1. **Provider catalog and metadata.** Models.dev supplies broad provider/model metadata; OpenCode can refresh its model cache. Catalog metadata can include limits, modality, costs, and provider identifiers. A catalog listing is not necessarily a live entitlement check for a particular account.
2. **Credential connection.** `/connect` stores credentials and enables authenticated provider use. Desktop's picker-level connection action shortens the path from wanting a model to authorizing the provider.
3. **Configured models and provider options.** Custom providers can specify adapter, base URL, API key/options, and a model map in config. Configuration remains necessary for special endpoints, gateways, and models with incomplete catalog metadata. [OpenCode provider guide](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx)
4. **Runtime discovery for some providers/endpoints.** OpenCode has discovery hooks and provider-specific model-list calls. Merged PR #32731 describes calling OpenAI-compatible `GET /v1/models`, reading IDs/names and optional context/output limits, merging endpoint results with configured/catalog metadata, and an opt-out. It explicitly addresses local/self-hosted compatible endpoints. [OpenCode PR #32731](https://github.com/anomalyco/opencode/pull/32731)
5. **Provider-specific API catalogs.** Example GitHub Copilot integration code calls its `/models` endpoint and constructs model objects with capability metadata; that is a provider adapter, not a generic rule for all providers. [OpenCode Copilot model discovery source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/github-copilot/models.ts)

Therefore, “all models offered by the provider become available” is achievable only when the provider exposes a usable discovery API (or OpenCode already has compatible metadata/adapter support). The provider's list may include models that are not entitled, unavailable in the user's region/account, incompatible with tool calling, or missing the capability metadata this harness needs. Some providers expose no model-list API, restrict it, or require provider-specific auth. A robust UI must distinguish **discovered**, **catalog-listed**, and **manually configured** where useful, and validate/communicate capability limits.

## Implementation ideas transferable to Pi-Apex

- **One discoverable entry point:** put “Connect provider” beside the existing model selector; show configured providers/models in that same picker.
- **Short guided form:** provider → credential (masked; local provider can be keyless) → verify/discover → model selection. Save only after user confirmation. Provide a clear credential-storage explanation.
- **Provider registry as adapter boundary:** for built-ins, define auth shape, base URL, model-discovery method, API adapter, and capability mapping explicitly. Avoid pretending arbitrary provider IDs share one wire protocol.
- **Generic OpenAI-compatible path:** endpoint URL + optional API key, use `GET {baseURL}/models` with strict timeout/response-size limits, parse only safe fields, and keep manual ID input as fallback. Use an allowlisted/validated URL policy to avoid SSRF, especially for hosted deployment; local-first behavior should not mean unrestricted server-side network access.
- **Keep metadata provenance:** merge endpoint IDs with known catalog metadata; API response confirms presence, richer registry data supplies capabilities/limits where trustworthy. Unknown tool/image/audio support should remain unknown/disabled rather than guessed.
- **Resilient discovery:** discovery failure must not erase a previously configured provider/model list; provide explicit refresh and actionable errors. Avoid a slow serial startup scan; do it on connect/refresh with bounded timeouts.
- **Key handling:** never put secrets into browser-rendered HTML, logs, model-list responses, or ordinary settings. Store using the harness's secure credential mechanism, mask in UI, support replace/remove, and redact test errors. Existing Pi-Apex provider security requirements still apply.
- **Connection management:** allow multiple named isolated connections to one provider (already a Pi-Apex requirement); model choice should reference a connection, not just provider family, so separate keys/tenants stay isolated.
- **Do not conflate models and routing:** model selection chooses the user's default. Ring 15's opt-in per-request router can only target explicitly configured and available models; connecting a provider should not silently enable automatic routing.

## Relevant caveats from OpenCode repository

OpenCode is a useful UX reference, not a guarantee of frictionless universal discovery. The repository has reports of config-defined models missing from parts of the GUI picker, discrepancies between backend model catalog and UI, and custom-provider forms lacking discovery or model metadata fields. These issues illustrate why Pi-Apex should test the end-to-end path (credential save → model list → selection → real request), not merely implement a provider form. Examples: [#56293](https://github.com/anomalyco/opencode/issues/56293), [#50726](https://github.com/anomalyco/opencode/issues/50726), [#57325](https://github.com/anomalyco/opencode/issues/57325). These are reports/issues, not proof every OpenCode release has the same bug.

## Pi-Apex gap and recommendation

The user reports the current provider onboarding/model picker is cumbersome. Before implementation, map current Pi-Apex APIs and credential storage against this flow, especially whether the current model listing is runtime-only, manually registered, or models.dev advisory. A v1 should first streamline the **providers and models already supported by the runtime**—searchable provider list, obvious connect action, masked key entry, immediate selectable model list—then add generic compatible-endpoint discovery as a separately bounded feature if it is not already supported by the adapter layer.

Suggested acceptance criteria:

1. From model picker, connect an existing supported API-key provider without editing config or navigating away.
2. Store credentials using approved local secret handling; never echo key in responses or logs.
3. After connect, show that provider's currently available runtime/catalog models and allow selection in the same flow.
4. For supported dynamic endpoints, refresh model discovery on demand; timeout/failure leaves prior config intact and gives actionable feedback.
5. Clearly label catalog vs endpoint-discovered models and avoid claiming availability guarantees.
6. Test at least a cloud API-key provider, a local Ollama endpoint, a provider with no discovery endpoint/manual fallback, invalid credentials, network timeout, and removal/replacement of a connection.
7. Preserve named isolated connections, provider allowlists, existing OAuth scope (only complete SDK-native lifecycle), and all existing guardrails.

## Source register

- OpenCode provider docs: https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx
- OpenCode model listing CLI: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/models.ts
- OpenCode model discovery PR #32731: https://github.com/anomalyco/opencode/pull/32731
- OpenCode GitHub Copilot model adapter: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/github-copilot/models.ts
- OpenCode Desktop connection UX issue #47440: https://github.com/anomalyco/opencode/issues/47440
- OpenCode custom-provider/UI caveat reports: https://github.com/anomalyco/opencode/issues/56293 ; https://github.com/anomalyco/opencode/issues/50726 ; https://github.com/anomalyco/opencode/issues/57325
- Generic discovery feature context: https://github.com/anomalyco/opencode/issues/27553

**Attribution note:** This is a design review of public OpenCode documentation/source and issue/PR records, not a claim that Pi-Apex reuses OpenCode code. Any future adaptation should separately record exact files, versions/commits, license, and changes.
