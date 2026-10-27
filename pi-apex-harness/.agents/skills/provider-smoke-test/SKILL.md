---
name: provider-smoke-test
description: A safe checklist for checking configured model providers and selecting a usable model.
---
# Provider smoke test

Use this checklist only after the operator has connected a provider and chosen a model. Never request that a user paste a key into chat, print or copy credentials, or change provider settings without explicit approval.

1. Confirm the provider and model are present in the runtime selector; distinguish runtime-registered models from advisory catalog entries.
2. Check image/tool/reasoning claims against explicit runtime metadata. A model-list endpoint returning an ID does not prove those capabilities or account entitlement.
3. Use a short, harmless prompt with the operator's chosen model. Do not send private data in a smoke test.
4. Report provider response, latency if shown, and the exact model ID. Do not claim a key was verified merely because it was saved or a model list loaded.
5. If the test fails, report the sanitized error and likely categories (credential, entitlement, endpoint, compatibility, rate limit) without revealing secrets.
6. Do not switch or auto-route the user's model after the test. Ask before changing selection or running a more expensive test.
