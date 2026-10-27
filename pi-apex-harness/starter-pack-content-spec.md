# Starter content pack spec — skills, agents, plugin, MCP

**Status:** implemented and verified with focused runtime tests.  
**Goal:** provide a small, local-first pack of genuinely exercisable content so the operator can configure an API key and test skills, agents, plugins, and MCP in the running Pi-Apex build.

## Contents

1. **Three clean canonical skills** under `.agents/skills/`, designed for progressive-disclosure `skill_access`:
   - `test-driven-change`: inspect repository and tests, propose spec-first change, implement minimally, verify and report.
   - `api-contract-review`: review public API/schema/error/auth changes, compatibility and focused tests.
   - `provider-smoke-test`: safely test configured providers/models without exposing keys, with explicit distinction between model-list discovery and inference.
2. **Two workspace personas** under `.agents/agents/*.md`, consumed by `MultiAgentOrchestrator.listPersonas()` and `/agents`:
   - `test-coach`, role `verify`, read/bash tools only; should produce actionable commands/findings without changing files.
   - `api-reviewer`, role `review`, read tool only; should flag concrete contract/security regressions.
   Existing builtin agents and surfaces/SUBAGENTS.yaml worker safety profiles are retained; no widening worker permissions.
3. **One first-party sample plugin source** under `examples/starter-pack/plugins/dev-helper/` with a manifest + safe deterministic tools: text metrics and strict JSON formatting. It does no network/filesystem/process access and can be audited/installed using the existing Plugin UI. It is pre-staged in the inventory but disabled/not loaded until explicit operator enablement, because activation executes code in-process.
4. **One first-party local stdio MCP server** under `examples/starter-pack/mcp/local-dev-helper.mjs` exposing the same sort of deterministic text/JSON utility tools. Connect manually through the MCP UI using Node 22 and this path. No network, filesystem, child-process, credentials, npm install, or external service.
5. A README explains activation, exact commands/UI paths, behavior, and limits. User supplies their own API key separately; pack contains no secrets or cloud requirements.

## Safety / no overclaim

- Skills are reference instructions and still undergo runtime scan; they must be loadable only through the current explicit `skill_access` workflow and never execute scripts.
- Agent definitions are scanned by skills-guard and grant only read/bash role-level tools; agents are not guaranteed semantic performance and use the selected model/provider.
- Plugin is a trusted local plugin example, not sandboxed. Existing Plugin UI must audit before install; explicitly disclose in pack docs that static audit is not isolation.
- MCP server is local deterministic JSON-RPC, no external network. User explicitly connects it; do not persist or auto-spawn stdio server. Existing clean-environment and tool-description poisoning scanner apply.
- No untrusted third-party content, remote dependency, OAuth, write-capable plugin or MCP tool, browser automation, repository mutation, or auto-install.
- Tool output must be bounded and parameter validated; malformed input returns clear errors.

## Implementation / verification (2026-10-27)

- Added the three canonical skills and two custom personas described above.
- Added `examples/starter-pack/plugins/dev-helper` with `text_metrics` and `format_json`; audited and staged at `.harness/plugins/starter-dev-helper`, **disabled / not loaded** for explicit enablement from the Plugin UI. The installed marker is mode 0600 and plugin directory mode 0700.
- Added `examples/starter-pack/mcp/local-dev-helper.mjs`, a self-contained stdio JSON-RPC server with `text_metrics` and `format_json`, plus a non-active config example. It is **not** auto-spawned or persisted; user connects explicitly in the MCP UI.
- Added `examples/starter-pack/README.md`, `test/starter-pack/run-starter-pack-tests.ts`, and `npm run test:starter-pack`.
- `npx --yes tsc --noEmit`: PASS.
- `npx --yes node@22 --experimental-strip-types test/starter-pack/run-starter-pack-tests.ts`: PASS (3 skills, 2 personas, 2 plugin tools, 2 MCP tools).
- Ring 3 tests: PASS; Ring 6 tests: PASS after preserving its preview invariant (no localhost literal in rendered Mission Control HTML); Ring 14 tests: PASS.
- Ring 9 test invocation halted at its existing Headless Chromium requirement, so no Ring 9 browser UI visual signoff. Plugin host behavior itself is exercised by the starter-pack test.
- No API key was supplied or used; a real LLM/provider interaction remains for the operator to test after configuring their own key.

## Verification requirements

- Run skills scanner on each skill and ensure verdict `safe`; test SkillLibrary discovery and runtime eligibility/path labels.
- Test persona discovery and assertions on roles/tools/read-only policy.
- Run plugin audit, install in temp harness, invoke both tools, assert output and no dependencies or capabilities beyond manifest.
- Connect MCP via `ConfinedMcpHub`, assert safe scan, invoke tool(s), assert result; close child process.
- Typecheck and relevant Ring 3/6/9 tests; no Chromium required for these content/runtime tests. Report API inference is user-key dependent and not part of sample-content verification.
