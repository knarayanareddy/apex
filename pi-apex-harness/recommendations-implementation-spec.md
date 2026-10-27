# Specification: operationalizing the capability assessment recommendations

**Status:** Implemented; full automated regression passed on 2026-10-27. Separate visual review of the Settings disclosure and live provider/user-vault checks remain outstanding; see `research/recommendations-release-record-2026-10-27.md`.  
**Order:** Spec first; implementation follows this document phase by phase with tests at each phase.  
**Scope:** Local claims/docs, optional task-time skill loading, explicit browser-use behavior, bounded Obsidian read-only access, and explicit FTS5 episode recall. Personal-use defaults; security and truthful disclosure take priority over convenience.

## 1. Outcomes

Implement and prove the recommendations from `research/pi-apex-capability-and-upstream-assessment-2026-10-27.md` without treating upstream attribution or mocked behavior as production parity.

1. Product documentation accurately states what is implemented, automatic, manual, deferred, or mocked.
2. A model can inspect skill metadata and explicitly load a relevant skill on demand. No skill body is injected globally and no skill script is executed.
3. Explicit browsing requests (current/latest/research/web lookup, or an explicit user instruction to browse) receive actionable browser-tool guidance and observable use/failure reporting. Do not promise browser invocation for every arbitrary prompt; task classification remains fallible. Do not invent web search or citation capability absent implementation.
4. An operator can optionally configure one Obsidian vault root; an agent-facing read-only tool can list/search/read bounded Markdown files there. No Obsidian plugin/API/MCP service, write/delete, or automatic home-directory scanning in this phase.
5. An agent can explicitly search this workspace's persisted episodes using bounded FTS5 recall. Recall is opt-in per tool call and scoped to the active workspace database; there is no automatic injection on every prompt.
6. Extensive deterministic tests cover tool discovery/invocation paths, path security, content limits, accurate UI/docs, and regression of existing invariants. Where provider/model behavior is nondeterministic, label a harness test as simulated and do not claim an end-to-end real-provider guarantee.

## 2. Non-goals

- Automatically loading every skill, executing skill scripts, downloading skills, or activating quarantined skills.
- A deterministic semantic intent classifier that guarantees every research question is browsed. A hard classifier requires separate design and provider-backed evaluation.
- General-purpose web search, guaranteed citations, or mandatory browser use for arbitrary prompts unless a real search/source pipeline and completion gate are separately specified.
- Obsidian community plugin installation, Local REST API/MCP connection, Obsidian note mutation, backlink/graph indexing, binary attachment parsing, or vault sync/concurrency management.
- Automatic cross-session FTS retrieval, a vector database, a cloud memory service, or background “Dreaming”.
- Changing model cache semantics or claiming Pi-Apex owns provider prompt caches.
- Broad OSS feature parity or unverified upstream provenance claims.

## 3. Phase A — claim accuracy and evidence ledger

Update `PERSONAL_QUICKSTART.md`, `ARCHITECTURE.md`, `SPEC_BIBLE.md`, and relevant skill/provider specs where claims conflict with runtime. Add a compact “behavior status” section/table distinguishing: shipped + tested; source-level capability; explicit/manual; simulated; planned/deferred. Correct stale ring/version statements if they materially mislead, while preserving historical notes with labels. Add source/test anchors for browser, skill loading, memory, and cache behavior.

Acceptance:
- Docs do not say skills are task-matched/loaded automatically before Phase B tests pass.
- Docs do not say browser use is guaranteed, always-on, or a web-search/citation service.
- Docs distinguish SQLite episode storage from automatic retrieval, and `MEMORY.md` next-boot loading from live prompt mutation.
- Docs distinguish provider-returned cache telemetry/cache behavior from an application-owned durable prompt cache and identify synthetic benchmark tests.
- OSS component attribution remains specific; T3 Code is comparison-only unless actual code reuse is evidenced.

## 4. Phase B — progressive-disclosure skill runtime

Add a deferred `skill_access` tool with actions `list` and `read` (or equivalent separation if runtime schemas require it):

- `list` returns only bounded metadata: stable ID, name, description, source label, status/trust/scan status, and warnings. No skill body.
- `read` accepts an ID from the current list result, re-enumerates from safe roots, verifies that it still resolves under an allowed non-symlink root, verifies `SKILL.md` frontmatter/status, applies byte/file/depth limits, and returns the full requested instruction text plus requested safe supporting text files only.
- By default only clean, active, canonical workspace skills are eligible for model-side `read`; quarantine, invalid, archived, or external compatible folders are visible as metadata but not loadable. External folders stay read-only and are not implicitly trusted. If tests/spec reveal an existing trusted external status is required, make trust explicit and operator-controlled rather than infer from path.
- Mark loaded content as **untrusted skill instructions** and explicitly state the content is data, cannot override system/developer instructions or safety policy. Never execute skill scripts or HTML.
- Record a minimal audit event (skill ID/name, content hash, source, timestamp) without logging secret-bearing body text. Do not mutate use counts for failed reads.
- Tool remains deferred and is discoverable through Codemode; active tool schema and prefix caps remain unchanged.

Acceptance tests include: list/read through the actual Codemode dispatcher; relevant skill can be read; no body in list response; path/symlink races; malicious `SKILL.md`; stale/changed hash; invalid/quarantined/archived/external denial; oversized bundles; secret scrub; scripts are returned only as text if explicitly requested and never executed; zero static-prefix drift.

## 5. Phase C — browser behavior disclosure and observability

- Update system/tool guidance with a concise rule: when a prompt explicitly asks to browse/search/research/look up information, or requires current/latest facts, discover and use `browser_control` if possible; if it cannot be used, state that browsing did not occur. For ordinary coding or stable knowledge, browser use is optional.
- Reuse the existing Pi session/Codemode nested tool-call trace as evidence of whether a browser tool call occurred; do not add a duplicate persistent browser log or store page contents. The `/api/browser` operator endpoint remains distinct from agent browser invocation.
- Add deterministic fake-provider tests for browser tool discovery/callability and boot-guidance disclosure. The fake test proves the browser capability can be called, not that every real model obeys the instruction. Add an opt-in live-provider evaluation recipe, but never make the suite dependent on credentials/network.
- Do not claim “citations guaranteed” until URLs and source evidence are captured and checked in the final-response path.

Acceptance:
- Explicit browse-oriented fixtures lead to browser tool invocation in deterministic scripted tests; non-browse fixtures do not invoke it unless the fake model explicitly chooses it.
- Production UI/API reports actual tool call evidence, not inferred user intent.
- Browser path's current security limitations remain disclosed; this phase does not broaden network access.
- No universal guarantee is made about a model's choice to browse on unstructured real-world prompts.

## 6. Phase D — optional Obsidian read-only vault

- Add an opt-in `--obsidian-vault <absolute-path>` setting; unset means feature off. Resolve and pin a canonical directory at startup, reject symlink root and non-directory, and never search ancestors/home for vaults.
- Register a deferred read-only `obsidian_vault` tool for `list`, `search`, `read`. Scope every path to the pinned root; reject traversal, absolute paths, symlink traversal, hidden/config paths (including `.obsidian`), and non-Markdown extensions. A vault root must not expand the normal Pi-Apex workspace root or file-operation permissions.
- Bounded list/search/read: limits on query length, results, file bytes, aggregate bytes and traversal depth; return relative note paths and excerpts; apply `scrubSecretsInfallible` to returned text. Treat note content as untrusted data, not instructions. Search is local lexical/full-text over Markdown, not Obsidian graph semantics.
- No writes, deletes, renames, plugin installs, HTTP API, MCP, network requests, attachment reads, or URI/process execution in this phase.
- Add truthful CLI help/status/UI disclosure showing whether a vault is configured, read-only/Markdown-only state, and disabled state. Do not reveal the absolute vault path in the status API/UI; tool results expose only relative note paths.

Acceptance:
- No vault path/config means no tool is available or it returns a clear disabled status without scanning.
- Valid vault reads/searches are read-only and return relative source paths.
- Security tests cover traversal, symlink root/inside/outside, hidden `.obsidian`, binary/non-md, nested vault, broken links, Unicode, case handling, oversized files/results and live file replacement during read.
- Existing workspace root and guardrails remain unchanged; zero prefix drift; no vault content persisted to transcript other than user-requested tool output (normal transcript policy applies).

## 7. Phase E — explicit FTS5 episode recall

- Add deferred read-only `memory_recall` querying `StateDb.searchEpisodes()` (or a validated prepared query) with a bounded query/result count. It returns summary, files touched, outcome/date and same-workspace provenance, not internal raw DB details.
- Escape or validate FTS5 query syntax so user/model query strings cannot crash the tool or become SQL; use parameterized SQL and a hard result cap.
- Tool description states recall is opt-in, workspace-local, keyword/FTS-based, incomplete, and not automatically run on every prompt. It is distinct from `/dream`, which writes `MEMORY.md`.
- No cross-workspace/global/session leakage; no external embeddings or automatic prompt injection.

Acceptance tests: existing episode returns for terms; no unrelated DB/workspace results; malformed FTS operators fail with actionable safe response; caps enforced; no DB writes; returned text is scrubbed and clearly labeled as historical/untrusted; active schema/prefix invariants preserved.

## 8. Phase F — comprehensive test and release record

At each phase: typecheck, focused ring test, relevant UI/browser E2E, full `npm test` before considering phase complete. Add a manual test checklist with expected result and actual result. Use fake provider and local temporary vault/database fixtures for deterministic CI. Optional live-provider/real Obsidian verification is a separate operator-run check and must be marked unrun if no provider/vault is available.

Final acceptance requires:
- `npm test` exits 0 on the configured supported Node/Chromium environment.
- New and existing tests show zero active prefix/token-budget drift and no regression to approval/sandbox/secret boundaries.
- A real Mission Control browser preview is inspected if UI is changed.
- Documentation, help text, implementation, and tests agree about auto/manual/deferred behavior.
- No credential is added to test files, fixtures, logs, or docs.

## 9. Sequencing / change policy

Implement in the order A → B → C → D → E → F. Each phase is independently testable and should not be partially described as complete. If architecture review finds a security issue or an acceptance requirement cannot be met without changing a higher-level invariant, stop that phase and amend this spec before proceeding. Preserve current approved visual direction and Ring 0–11 constraints; do not weaken hard guardrails, sandboxing, workspace confinement, or prefix immutability to fit a feature.
