# Spec: Skills Library, Plugin Boundaries, and External App Connections

**Status:** Approved by the user; implementation completed for Skills Library v1, quarantine-first create/import, remote HTTPS MCP configuration, and plugin inventory/re-audit controls. OAuth and a true isolated plugin runtime remain explicitly deferred as described below.

## Problem statement

The current Skills panel does not behave like a skill library. It renders the Ring 3 skill ledger (quarantined/active/stale/archived records) rather than discovering and displaying all skill files on disk, and it has no way to inspect the saved `SKILL.md` or its supporting files. This makes installed/shared skills hard to find and audit.

The current Plugin panel is a local-directory developer workflow, not an intuitive marketplace or app connector. It audits a manifest and sources, copies the directory, then imports plugin code into the host Node process. A static scan is useful defense-in-depth but is not a runtime sandbox.

The current MCP hub has `stdio` and HTTP transport support in its server layer; the visible UI only exposes stdio connection fields. It therefore does not yet provide a normal remote-app connection/OAuth setup experience.

## Goals

1. Make all discoverable saved skills visible, searchable, inspectable, and manageable in the UI.
2. Use an interoperable `SKILL.md` directory format and progressive disclosure: show names/descriptions in the index; load full instructions and references only when selected.
3. Preserve the existing quarantine, scan, explicit promotion, secret scrubbing, and bounded active-description budget.
4. Clearly separate **skills** (instructions/workflows), **plugins** (trusted executable extensions), and **connectors** (scoped access to external services, preferably through MCP).
5. Make the current and supported capabilities honest in UI copy; do not imply plugin isolation or OAuth support that does not exist.
6. Keep the work spec-first and add regression tests for discovery, safe file handling, content viewing, and lifecycle actions.

## Non-goals for the first delivery

- Running arbitrary community plugin code in-process or calling that a sandbox.
- A public marketplace, automatic remote updates, or unattended installation from URLs.
- Video skill assets, plugin dependency installation, or arbitrary shell execution from a skill.
- Building bespoke API connectors for every SaaS product before assessing MCP servers and SDK support.

## Skills-library behavior

### Canonical format and discovery

- Canonical workspace install location remains `.agents/skills/<skill-name>/SKILL.md` (the current promotion target and Agent Skills-compatible path).
- Discover compatible project-local sources: `.agents/skills`, `.opencode/skills`, and `.claude/skills`, with the active workspace and safe ancestors up to the repository boundary. Treat other harnesses' sources as read-only until explicitly imported.
- The current app's own active/quarantine/archive roots remain first-class and are shown with their exact source and status.
- Do not scan home/global skill locations by default. Add opt-in global locations later with visible scope and trust controls.
- Skill identity is source-qualified (for example, `workspace/.agents:pdf-helper`) to avoid silently collapsing duplicate names. Show duplicates and require the operator to choose which one is active.
- Require `SKILL.md` for a directory skill. Validate Agent Skills frontmatter (`name`, `description`), path/name consistency for newly created skills, reasonable file/size/depth limits, and reject symlinks or path traversal. Compatibility imports may report warnings rather than silently rewriting user-authored metadata.
- Supporting files are read-only/viewable in the library in the first release. For executable scripts, label them as files; do not auto-run them.

### UI

Replace the current “skills ledger” list with a **Skills Library** view:

- Search/filter by name, description, source, and status; tabs/filters for Active, Quarantine, Archived, and All.
- Each row shows skill name, description, source path/scope, trust/scan status, last-used/updated where known, and duplicate/conflict warnings.
- Selecting a skill opens a detail pane that displays `SKILL.md` and lists supporting files (`references/`, `scripts/`, `assets/`, `examples/`, `templates/`); render text safely, never as HTML.
- Provide explicit actions: **Open folder**, **Copy skill path**, **Rescan**, **Promote/Enable**, **Archive**, and **Delete** (with confirmation and source-aware warning). Do not overwrite external skills when promoting.
- Provide an **Import local folder** flow that previews metadata/files, runs the existing scanner, and imports only into quarantine until the operator approves promotion.
- Provide a simple **Create skill** flow with name/description/instructions and optional supporting files. Save to quarantine first; preview, scan, then require explicit promotion.
- Show a clear empty state with the actual directories scanned and a button to create/import a skill.

### Runtime behavior

- Discover skills at startup and on an explicit **Refresh** action. Avoid an implicit recursive full-disk scan on every prompt.
- Advertise only compact active skill name/description metadata to the model, within the existing token budget.
- Load the selected skill's full instructions on demand via explicit `/skill <name>` and/or a deferred skill tool; never inject every skill body into every prompt.
- References can be loaded on demand after safe root-relative path validation. Log which skill was loaded, not arbitrary secret content.
- Active edits must go through editor + rescan + confirmation. Keep content hashes/history so a user can compare/revert; do not silently mutate an externally sourced skill.
- Preserve existing skill scan verdicts, quarantine-first install, explicit promotion, and ledger accounting. Inventory display must come from the filesystem plus ledger metadata, not the ledger alone.

## Plugin behavior and policy

- Keep the existing audited plugin host as an **advanced, trusted-local extension** feature, not the normal way to connect an app.
- Correct UI disclosure: static scanning is not isolation. Current source code is dynamically imported in the host process after scanning; code can still have host-process authority. Do not describe this as sandboxed or safe for arbitrary downloaded plugins.
- In the first delivery, surface installed plugins' manifest, enabled state, declared tools/commands, scan result/findings, installed path, and restart/persistence status. Add explicit Disable and Remove actions, with confirmation.
- Persist plugin installation metadata and re-audit at startup; fail closed on changed hashes or a newly dangerous scan. Do not imply a plugin remains installed/enabled after restart unless that lifecycle is implemented and tested.
- Any later third-party plugin runtime must use a real isolated process/permission broker with narrow capabilities, clean environment, filesystem/network restrictions, timeouts, output bounds, and revocation. Static scanners remain defense-in-depth only.
- Prefer declarative skills or an MCP connector over native plugin code whenever they meet the use case.

## External applications / connectors

- Treat MCP as the default generic integration layer. The existing `ConfinedMcpHub` already supports stdio and Streamable HTTP transports; expose both through the UI and persist named configurations safely.
- Remote connector form should include endpoint, transport, authentication method, scopes/permissions, enabled state, and a **Test connection** action. Keep tokens in the existing out-of-workspace vault; never store secrets in workspace JSON or skill/plugin files.
- Start with operator-configured MCP servers and supported auth styles. Implement OAuth only where the MCP client can complete the full lifecycle (authorization launch/callback, state/PKCE, refresh, secure token storage, revoke); do not present a pasted token as OAuth support.
- Gate untrusted workspace-configured endpoints and stdio processes behind trust. Apply URL/DNS/IP protections to remote endpoints; prevent redirects and private-network/SSRF bypasses. Keep the existing clean environment for stdio.
- Review every discovered tool and description. Continue to quarantine poisoned descriptions and block execution; expose permission state and per-server enable/disable/revoke in the UI.
- First-party app targets should be chosen after validation of their official MCP server/SDK and auth lifecycle. GitHub, Slack, and Notion are reasonable candidates, but connection support must be verified individually rather than assumed from an MCP listing.
- Plugins and MCP must remain separate UI concepts: plugins add executable host extensions; MCP servers expose external tools/data.

## Security and acceptance criteria

1. A manually saved `.agents/skills/<name>/SKILL.md` appears in Skills Library after refresh even if no Ring 3 ledger row exists.
2. Skills in `.opencode/skills` and `.claude/skills` are clearly labeled by path and are not copied/modified during discovery.
3. Skill detail shows safe text for `SKILL.md` and supporting files; HTML/script content never executes.
4. Invalid frontmatter, duplicate IDs, symlink escape, traversal, oversized files, and unreadable files fail safely with actionable warnings.
5. Import/create always stages in quarantine and cannot activate without explicit operator approval and a fresh clean scan.
6. Selection/invocation loads only the requested skill instructions; full skill bodies are not put in the always-on prompt.
7. Plugin UI clearly states that the current plugin runtime is not process-isolated; no UI text claims arbitrary downloaded plugins are sandboxed.
8. Remote MCP setup does not persist credentials in workspace config; invalid, redirected, private-address, or DNS-rebound endpoints are rejected.
9. MCP server trust, per-server tools, auth status, and disconnect/revoke are visible and testable.
10. Unit, API, UI/browser, and security regression tests cover the above. Update the user-facing docs and release artifact only after tests pass.

## Suggested delivery order

1. **Spec approval and existing-behavior review.** Confirm skill discovery paths, read-only external sources, and first connector targets.
2. **Skills Library v1.** Filesystem inventory/detail view/refresh/source labels; no remote marketplace and no in-place editing of foreign skill directories.
3. **Safe skill authoring/import.** Quarantine-first creation/import, file preview, rescan/promotion, archive/delete UX.
4. **MCP Connectors v1.** Remote HTTP UI, safe configuration persistence, secrets in vault, test/disable/disconnect; verify OAuth only for chosen servers.
5. **Plugin lifecycle hardening.** Honest UI, persistence/re-audit/remove controls; defer a true sandbox until a separate design and threat-model review.

## Upstream references reviewed (26 Oct 2026)

- OpenCode skills docs: https://opencode.ai/docs/skills/ — compatible paths, `SKILL.md` frontmatter, compact discovery metadata, on-demand loading, and skill permissions.
- OpenCode MCP docs: https://opencode.ai/docs/mcp-servers/ — local and remote MCP, server enable/disable, OAuth and credential lifecycle patterns.
- OpenCode plugin docs: https://opencode.ai/docs/plugins/ — plugin files and extension points.
- Hermes Skills System docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills — primary skills directory, progressive disclosure, bundles, and explicit skill commands.
- NousResearch Hermes Agent: https://github.com/NousResearch/hermes-agent — upstream repo checked at current `main` on 26 Oct 2026.
- Pi repository and skills documentation: https://github.com/earendil-works/pi and https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs — Agent Skills-compatible directories, skills/extensions distinction, and package-based distribution.

## Delivery status

Implemented in this iteration:

- Filesystem-backed Skills Library inventory and detail API/UI for canonical, OpenCode-compatible, Claude-compatible, quarantine, and archive folders; duplicate/source/status labeling; refresh/search/filter; text-only detail rendering with secret scrubbing and no symlink traversal.
- Local folder import and create-to-quarantine UI, bounded support-file intake, explicit scan/promotion, and managed archive/delete controls.
- Remote HTTPS MCP URL validation (public unicast DNS/IP only), no URL credentials/query/fragment, private 0600 metadata storage without tokens, startup revalidation/reconnect, visible failure notices, and a remote endpoint form. Local stdio trust behavior is retained.
- Plugin inventory now includes on-disk installs, records an installed source hash, blocks changed files, and defaults persisted plugins to unloaded after restart; explicit enable re-audits. UI supports enable/disable/remove and prominently warns that code runs in-process and scanning is not sandboxing.
- `PERSONAL_QUICKSTART.md` updated with skill, MCP, and plugin workflows and safety limits.

Explicitly deferred as the approved non-goals/limitations: authenticated remote MCP headers, OAuth client lifecycle, app-specific first-party connectors, persisted enablement/automatic plugin execution after restart, and a real isolated plugin runtime. Remote MCP currently supports endpoints that do not require credentials. A true plugin sandbox needs a separate threat model and permission broker.

## Current implementation areas inspected

The bullets in “Delivery status” above are historical and predate explicit task-time loading. Current runtime behavior is described immediately below and verified by Ring 3 tests. Current source paths include `src/ring3/skills-guard-quarantine.ts`, `src/ring3/skill-library.ts`, `src/ring5/mission-control-server.ts`, `src/ring5/mission-control-ui.ts`, `src/ring6/mcp-confined-hub.ts`, and `src/ring9/external-plugin-host.ts`.

## Runtime limitation clarification (2026-10-27)

The Skills Library discovery/detail API and UI are implemented. A separate deferred `skill_access` tool now lists compact metadata and explicitly loads only clean, active canonical workspace skills after a fresh static scan; reads are marked untrusted and recorded by hash without persisting the body. This is progressive disclosure, **not** guaranteed automatic task matching. Ring 0's Pi `skillsOverride` remains empty, so no skill body is injected globally. Quarantined, invalid, archived, compatible external, and out-of-workspace ancestor skills are not loadable through this tool. `/api/skills` remains operator-facing inventory/detail; task-time invocation is through the deferred tool.
