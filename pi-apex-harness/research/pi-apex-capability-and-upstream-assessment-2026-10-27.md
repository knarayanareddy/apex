# Pi-Apex capability, memory, Obsidian, and upstream comparison

**Assessment date:** 27 October 2026  
**Repository assessed:** `/home/user/pi-apex-harness` (package reports v4.1.0 / Rings 0–11; Ring 12 tests/spec artifacts also exist)  
**Scope:** Source, runtime wiring, test code, project specs/docs, and current upstream repository documentation. This is an assessment only: no product code or configuration was changed.

## Executive findings

1. **Obsidian is a good optional *knowledge/workspace surface*, not a missing core dependency.** Obsidian vaults are ordinary local folders of Markdown and attachments. Pi-Apex can already work against a selected folder as a workspace and can read/write confined workspace files; this does not require an Obsidian plugin. The smallest safe step is an explicitly selected vault/workspace with read-only discovery first. Do not point the agent at the user's whole home directory, and do not equate Obsidian notes with Pi-Apex's own session memory.
2. **Browser: capability is available, but task-to-browser dispatch is probabilistic/model-directed, not a deterministic automatic rule.** The agent receives a deferred `browser_control` specialist tool through Codemode discovery. A model may discover and invoke it when it judges browsing useful. There is no source-level router that classifies “needs current web evidence” and forces a browser call. The Cockpit `/api/browser` endpoint is a separate operator/browser panel path, not proof that every chat prompt uses a browser. A request to “look this up” can still be answered without a tool call unless policy/prompt/UI behavior makes browsing compulsory.
3. **Skills: discovery/inventory is implemented; automatic task matching and skill loading are not.** Pi-Apex scans compatible `.agents/skills`, `.opencode/skills`, and `.claude/skills` directories for the Skills Library UI, and has a deferred skill-curation tool. But Ring 0 explicitly overrides Pi's built-in skills loader with an empty skill set; there is no active skill-load/execute tool or automatic semantic matching/injection path in the inspected runtime. It is inaccurate to say that task-appropriate skills are automatically selected and applied today.
4. **Memory is a layered, mostly local system, with an important manual seam.** Pi session transcript/context is stored in Pi session files under the workspace `.harness/sessions`; SQLite WAL/FTS5 and audit/checkpoint state is under `.harness/state.db`; a short `surfaces/MEMORY.md` (max 300 `o200k_base` tokens) is read into the immutable boot prompt. Two-stage compaction can reduce the current transcript and create FTS5 episodes. But FTS5 episodes are not automatically retrieved into every new prompt. “Dreaming” consolidates episodes into the on-disk memory file only when explicitly run (e.g. `/dream`, deferred tool, or Cockpit API); the new file takes effect on a subsequent session boot.
5. **Prompt caching: Pi-Apex protects cacheability; it does not implement a durable prompt-content cache.** It freezes and hashes the system prompt and active direct tool schemas for a session, tracks provider-reported cache-read/cache-write usage, and limits `apex/auto` to one route switch per session branch. The actual prompt cache, if any, belongs to the chosen provider/runtime. The Ring 8 SWE cache benchmark uses a deterministic/mock responder and must not be read as a general live-provider cache guarantee.
6. **Pi-Apex is a custom integrated harness that borrows/adapts named components, not a drop-in superset of its references.** It is unusually strong in explicit local confinement, fixed-prefix invariants, durable execution receipts, and a single-personal-workspace integration. It is behind the upstreams in native skill execution, persistent user-facing memory retrieval, broad provider/product maturity, mobile/multi-client control plane, and the depth of DeepSeek's composable plugin architecture. Harness² and DeepSeek Harness are different categories (research framework and plugin platform), not direct competitors on all axes.

---

## 1. Evidence and confidence rules

This assessment distinguishes four evidence levels:

- **Runtime source:** implemented wiring and conditions in `src/`.
- **Automated test:** test asserts a path, frequently with faux providers, local fixtures, mocks, or deterministic data.
- **Specification/documentation:** intended behavior/attribution, which can be stale or aspirational.
- **Upstream current docs/source:** current repository pages checked on 27 Oct 2026. Upstreams are moving targets; current feature statements are not a claim that Pi-Apex has synchronized to them.

The latest local project test run before this assessment was the completed full `npm test` from the preceding UX work. It passed on Node 22 with the installed Chromium path. That establishes the suite passed at that point, **not** that every test is a real-provider, real-internet, or production deployment test. A fresh test run was not needed for this read-only assessment.

Project docs themselves are not perfectly current: `SPEC_BIBLE.md`, `ARCHITECTURE.md`, and quickstart contain old version/ring snapshots and extensive “verified” claims. Use the executable implementation and focused test names below for this assessment; treat feature language in old docs as a map, not proof.

## 2. Obsidian: should it be integrated?

### Recommendation

**Yes as an optional, user-selected local knowledge source; no as a required dependency or replacement for Pi-Apex's own session/memory state.** Obsidian's documented model is a local folder containing Markdown and other files, and it refreshes when files change externally. That fits Pi-Apex's workspace model well ([Obsidian data storage](https://obsidian.md/help/data-storage), [vault setup](https://help.obsidian.md/vault)).

There are three distinct integration levels:

| Option | What it means | Assessment |
|---|---|---|
| **A. Open an existing vault as a separate Pi-Apex workspace** | Operator explicitly starts/selects Pi-Apex with the vault directory as `workspaceRoot`; use existing confined file tools and search. | **Recommended first.** Lowest integration complexity; no plugin, service, or credential. Read-only by policy for the first phase. Test symlink/path-boundary behavior against a real vault. Do not expose the entire home directory. |
| **B. Read-only vault indexing/search adapter** | Dedicated read-only tools enumerate Markdown and retrieve excerpts/links within one configured vault; optional explicit “open this note in Obsidian” link. | Best next product-level integration if Option A proves useful. Build as a distinct connector with a canonical vault root, allow-listed extensions, no `.obsidian` reads by default, bounded results, provenance paths, secret scrubbing, and traversal/symlink rejection. Add retrieval tests that prove citations/paths and no cross-vault access. |
| **C. Obsidian plugin or Local REST API / MCP** | Obsidian app-side plugin, or a third-party local API/MCP server, exposes vault operations. | Defer. Adds a local service/plugin, trust boundary, authentication/token handling, and possibly write/delete operations. Pi-Apex's generic MCP support is not an Obsidian-specific integration, nor evidence that an Obsidian MCP server is safe. Start read-only and narrowly scoped if later chosen. |

Obsidian's official URI scheme can open a vault/note and can create, append, or search via URI actions; it is useful for navigation, not a secure agent data API ([Obsidian URI docs](https://obsidian.md/help/uri)). The community `obsidian-local-rest-api` advertises authenticated REST and MCP interfaces, including writes/deletes; that is a third-party plugin and should be treated as a separately audited integration, not a core Obsidian feature ([project repository](https://github.com/coddingtonbear/obsidian-local-rest-api)).

### Important interaction with this build

- Pi-Apex's file tools are confined to the configured workspace root. Choosing a vault as that root means the *vault* becomes the project/workspace boundary; do not simply add a symlink or a broad parent folder to evade the boundary.
- Some Pi-Apex actions are Git-oriented (e.g. `/tree` rewind, worktree orchestration). A non-Git vault should not be assumed to support those operations. If Git is used, respect the vault's sync/backup workflow and avoid concurrent agent writes to the same note.
- Obsidian stores app/plugin settings in `.obsidian`. It is usually unnecessary for an agent to read or edit that folder. Exclude it by default, along with trash, hidden/config paths, attachments unless requested, and secret-like files.
- External file edits are visible to Obsidian, but simultaneous changes can still conflict. Default to read-only; for approved writes, use atomic replacement, preserve frontmatter/links, show a diff, and require operator confirmation for overwrite/delete/move.
- **Do not use Obsidian as an invisible substitute for the existing memory system.** The two should be separate: transcript/context recovery and private Pi-Apex state remain under `.harness`; personal knowledge stays in the selected vault. A future explicit memory export or retrieval adapter can bridge them with user consent.

### Safe implementation sequence if later authorized

1. Specification first: pick vault-selection UX, scope (one vault), allowed file types, read/write policy, and whether attachments are in scope.
2. Add an opt-in read-only connector, no auto-discovery of home directories and no automatic vault mutation.
3. Include canonical relative note paths and excerpts in every answer; cap files, bytes, depth, and result count; reject symlinks/path escapes; never load `.obsidian` by default.
4. Add an operator-controlled “open note in Obsidian” action using encoded URI, without letting note content control arbitrary URI/process execution.
5. Only then consider writes: preview diff, explicit approval, safe create-vs-overwrite distinction, durable atomic writes, conflict detection, and trash rather than permanent deletion.
6. Test malicious frontmatter/instructions as untrusted data, duplicate filenames, Unicode paths, sync races, external links, oversized attachments, symlink escape, and non-Git vault behavior.

## 3. Does a task automatically trigger browser calls?

### What the code establishes

- `src/ring2/ring2-extension.ts` registers `browser_control` as `exposure: "deferred"`. Its description covers page navigation, compact ARIA snapshots (`@e1` refs), click/fill with stale-reference checks, and PNG capture.
- Ring 0 sets active direct tools to `read`, `bash`, `edit`, `write`, and `codemode`. Other specialists are deferred so they do not inflate the active schema. The normal Pi resource loader also receives `skillsOverride: () => ({ skills: [], diagnostics: [] })` in `src/core/ring0-session.ts`.
- `src/ring2/agent-browser-ref.ts` and `src/ring7/chromium-cdp-driver.ts` provide virtual and real Chromium/CDP machinery. The agent-facing tool defaults to the virtual backend unless CDP is already active or `backend: "cdp"` is specified. There is also a separate Mission Control `/api/browser` operator endpoint.
- `test/ring2/run-ring2-tests.ts` explicitly asks Codemode tool discovery for `browser_control`, then executes it. This verifies **discoverability and callability**, not automatic browser use on arbitrary user questions.
- The Chromium implementation has navigation URL validation, including cloud metadata host blocks and confined `file://` checks; it starts a sanitized-environment browser process. These are meaningful controls, but do not amount to a full network sandbox/allow-list for all web destinations.

### Answer to the user's practical question

**No deterministic guarantee exists that “current facts,” “research,” or a URL in a prompt will cause a browser request.** The current architecture enables a model to find and call the specialist tool via Codemode when it chooses to. Task understanding, tool discovery, and invocation depend on the model/runtime/tool policy. A tool being registered/deferred is not equivalent to a browser call having happened. The build does not have a compulsory intent classifier or a citation gate that blocks an answer until evidence is retrieved.

The built-in `browser_control` is a browser automation tool, not a dedicated search engine. The user/model can navigate to a search or information site, but it does not by itself guarantee search quality, source coverage, or citations. Network restrictions and browser navigation should be treated separately from the sandboxed shell: the source's URL checks do not prove arbitrary web content or all DNS/network paths are safe.

### Practical policy recommendation

For personal research tasks, make browsing explicit in the system/tool guidance (“for current or externally verifiable claims, browse; report sources; say when no browser was used”), but keep it as an instruction until tests establish reliable behavior. If the user wants a hard guarantee, implement a task-routing gate that detects recency/source requirements, makes a browser/search capability available, and records tool-use evidence; add a failure path when browsing is unavailable. Do not claim that this policy is already present.

## 4. Are relevant skills automatically discovered, loaded, and used?

**No, not in the current runtime path inspected.** There are three different things the code/docs call “skills”:

1. **Skills Library inventory:** `src/ring3/skill-library.ts` walks bounded roots for `.agents/skills`, `.opencode/skills`, and `.claude/skills`; reads `SKILL.md` frontmatter; rejects symlinks; caps depth/files/bytes; and scrubs secrets from displayed file contents. Mission Control exposes list/detail, source/status, search/filter, and managed quarantine/archive operations (`src/ring5/mission-control-server.ts`, `mission-control-ui.ts`). This is discovery for the *operator UI*.
2. **Quarantine/curation:** `skill_curator` is a deferred tool for distilling/listing/promoting/archiving skills with scanner and approval checks. `src/ring3/skills-guard-quarantine.ts` keeps agent-created drafts in quarantine and requires operator approval to promote. This is skill management, not task execution.
3. **Agent-side skill loading/use:** Ring 0 explicitly overrides Pi's normal resource loader with an empty list of skills. There is no `skill` loading tool, per-task skill matcher, or automatic injection/execution path in the files inspected. The tests in `test/ring3/run-ring3-tests.ts` exercise the curator and Codemode discovery of that curator; they do not show an existing skill being selected for a user task.

So Pi-Apex can **find and display compatible skill files**, but the answer to “will a task automatically trigger relevant skill discovery/loading?” is **not today**. Skill metadata is not passed as a task-matched list to the model, and the skill file body is not dynamically injected by the agent. This is a material gap versus mature skill systems in OpenCode/Hermes.

### Recommendation

Keep the existing quarantine and path protections. If enabling use, implement a separate **read-only skill-load tool**: disclose only name/description initially; let the model request the full body only when relevant; validate provenance and status; label the content as untrusted instructions/data; enforce permissions at tool/action level; and log the skill ID/hash loaded. Never silently auto-run scripts shipped in a skill. Add tests that prove task-relevant retrieval, non-retrieval for unrelated tasks, prompt-injection containment, stale hash detection, and explicit handling of compatible external folders.

## 5. Persistence, compaction, and context retrieval

### What persists and where

| State | Location / mechanism | Retrieval/use |
|---|---|---|
| Conversation transcript and Pi session branch/tree | Pi `SessionManager` configured with workspace `.harness/sessions` (`src/core/ring0-session.ts`) | Continue/resume/reload through Pi session facilities; current context is projected from session entries. Compaction modifies the session context with Pi context-edit/compaction entries; it is not a separate general semantic memory search. |
| Safety/audit/checkpoint/episode state | `.harness/state.db`, SQLite WAL + FTS5 (`src/core/state-db.ts`) | Queryable by internal methods / explicit tools and endpoints; includes WAL intent, Git checkpoints, session docs, episode summaries. |
| Large tool outputs | `.harness/spill` via private spill store | Referred to from tool results and cleaned under configured retention; not semantic long-term memory. |
| Static prompt/memory surfaces | `surfaces/SYSTEM.md`, `TOOL_GUIDANCE.md`, `MEMORY.md` (workspace-local `surfaces/` if present, else package `surfaces/`; override via `--surfaces-dir`) | Read at session boot and frozen in RAM. `MEMORY.md` is part of the future session's prompt, not a live-updating mutable block. |
| Harness² experience | `surfaces/EXPERIENCE.md` | Optional domain experience/evolution tools; separate from transcript and `MEMORY.md`, with its own checks and token cap. |
| Provider/model preferences and credentials/catalog | Provider-manager files under configured Pi agent directory, plus runtime auth handling | Provider metadata/catalog and credentials; not session memory. models.dev catalog cache is operator-refreshed/advisory. |

The CLI chooses a workspace-local `surfaces/` only when it contains `SYSTEM.md`; otherwise it falls back to package-level `surfaces/` (`src/cli/pi-apex-cli.ts`). Do not assume a workspace `MEMORY.md` is used if the workspace lacks the marker file.

### Compaction

`src/ring1/two-stage-compaction.ts` describes and implements two stages at the turn boundary:

- **Stage 1:** deterministic pruning of older, sufficiently large tool results into compact stubs; no LLM request. It defaults to retaining the most recent four tool results, and preserves scoped-context blocks in the stub.
- **Stage 2:** only when measured utilization still crosses the configured stage-2 threshold (default 80% of the configured context window) and enough entries exist. It keeps a recent tail (default six entries), replaces older context with a `<compacted-summary>` and records an episode. The summary is deterministic unless a summarizer is supplied.
- The local implementation's defaults include a stage-1 trigger at 70%, prune minimum of 120 tokens, and stage-2 trigger at 80%; exact behavior depends on the routed model's window and options. Stage-1 may run without Stage-2.
- Tests demonstrate the context edits and memory surfaces, but those tests do not prove every provider has a matching token counter or that a summary preserves every important fact.

Compaction is **context management**, not full deletion of all history: Pi session files remain the durable history, while context-edit/compaction entries shape what is sent again. It is not the same as Dreaming or cross-session retrieval.

### Episodic and durable memory

When Stage 2 runs with a StateDb, it stores the summary, file paths, outcome, session ID, and repository root as an episode; SQLite triggers keep `episodes_fts` synchronized. `StateDb.searchEpisodes()` supports FTS5 search. But in the runtime inspected, that index is not automatically queried and injected before every user turn.

The separate Dreaming consolidator (`src/ring3/dreaming-consolidator.ts`) can select recent episodes or FTS5 matches, redact learned secret values, run the skill threat scanner against candidate bullets, deduplicate, and fit them into a **300-token** `surfaces/MEMORY.md`. That write is durable and explicitly says it applies on the next session boot. It is triggered explicitly (for example `/dream`, `dream_memory`, or `POST /api/dream`), rather than by a background schedule or every turn. Tests in `test/ring3/run-ring3-tests.ts` verify secret redaction, poisoned-episode rejection, token cap, zero live-prefix mutation, and next-boot loading.

Thus “persistent memory” means: session transcript/history persists; compacted episodes persist in local SQLite; a small curated summary can be manually consolidated into the next session's static prompt. It does **not** currently mean automatic, broad semantic recall from all past sessions on every task. Similarly, FTS5 is keyword/full-text retrieval, not a vector embedding store.

### Prefix and provider cache

`src/core/prefix-budget.ts` loads the prompt surfaces once, counts `o200k_base` tokens, snapshots the effective prompt and direct tool schemas, hashes them, and checks the same hash before provider requests. Session-level immutability is specifically intended to maintain stable prompt prefixes. The model router (`src/ring6/provider-router.ts`) stores `apex/auto` phase on the session branch and changes from planning to implementation after the first successful edit/write, limiting cache-affecting model-route switches to one per branch.

`computeSessionUsageTelemetry()` aggregates `usage.cacheRead`, `usage.cacheWrite`, input/output tokens, and reported cost from assistant messages. This is **telemetry from the model adapter/provider**, not proof of Pi-Apex maintaining a reusable prompt cache on disk or across providers. The in-repo cache-related file `models-dev-cache.json` is a separate advisory model-catalog cache. The Ring 8 test uses an `apex-bench` deterministic responder with synthetic cache pricing/usage; good for arithmetic/routing logic, not evidence that a specific cloud vendor or local model will produce a cache hit in production.

## 6. Upstream/open-source comparison

### Provenance boundary

`SPEC_BIBLE.md` and source headers attribute adaptations to Pi, OpenCode, Hermes Agent, Google Harness², DeepSeek Harness, Codex, and Vercel `agent-browser`, among others. Component-level provenance is specific in many source files: e.g. Ring 2 worktree/browser/PTY code; Ring 3 Hermes skill scanner and memory scrubber; Harness² evolution; Ring 6 Pi router; Ring 7 PR pipeline/handoff/browser; Ring 9 ledger, plugins, messaging and orchestration. These are **project-authored attribution statements**, not an independent legal audit. With no `.git` directory in this workspace, provenance cannot be checked against a local commit history. Maintain attribution/license/commit notices before redistribution and re-verify pinned commits and license compatibility.

T3 Code is included below as a current comparator because the request names it; the project provenance scan did **not** show `pingdotgg/t3code` as a code donor. Pi-Apex and T3 Code should not be described as sharing implementation without evidence. Likewise the upstream projects are not all the same kind of product.

### Comparative matrix

| Project | What Pi-Apex takes/adapts (per source) | Pi-Apex stronger / equivalent | Pi-Apex weaker, absent, or deferred |
|---|---|---|---|
| **Pi (`@earendil-works/pi-coding-agent`)** | Base runtime/session model, TUI/CLI/RPC integration; extension examples for router, handoff, presets, bookmarks, subagents; active tool and prefix integration. | Pi-Apex adds its own explicit guardrails, filesystem/shell confinement, audit/WAL, local state, UI, and personal workflow integrations around the Pi session engine. | Pi-Apex remains coupled to the pinned Pi runtime version. Upstream Pi is the source of session/runtime primitives; do not claim its capabilities are independently reimplemented. Upstream repository URL cited in project docs could not be fetched as a public GitHub repo during this assessment; verify the package registry/license/source distribution when changing dependency versions. |
| **OpenCode** | Worktree/git helpers, skill-format compatibility, LSP/rules concepts, PTY buffer patterns and other small adaptations (source headers/spec). | Pi-Apex's static-prefix freeze, explicit local guardrails, safety receipt/WAL path, custom memory and browser CDP affordances are more integrated in this personal build. | OpenCode has its own continuously maintained coding-agent app/runtime, agents, native `skill` tool, web tools, MCP and permission configuration. Pi-Apex's compatible skill folders are inventory-only; its provider/runtime and integrations are narrower. Current upstream documentation describes built-in `skill` loading and configurable tool permissions ([OpenCode docs/repo](https://github.com/anomalyco/opencode), [tools docs](https://opencode.ai/docs/tools/)). |
| **Hermes Agent** | Skill scanner/manager safeguards, quarantine-first skill curation, memory secret redaction/consolidation, gateway/messaging concepts, schedule/PTY patterns, ledger aspects (source headers). | Pi-Apex adds tight tool/workspace-scoped execution controls and a fixed boot-prefix model; specialized build workflows integrate code review, Git worktrees, GitHub issue bridge and Mission Control. | Hermes has a much more mature end-user agent surface for actual skills, cross-session memory/FTS recall, profiles, multi-platform messaging, cron, pluggable memory, and durable Kanban/delegation. Pi-Apex has copied/adapted parts, not functional parity. Hermes current docs describe persistent built-in memory, pluggable memory, FTS5 session search, skills, and a Kanban database ([Hermes repo](https://github.com/NousResearch/hermes-agent), [Kanban docs](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md)). |
| **DeepSeek Harness (DSH)** | Attribution includes the 4-gate promotion philosophy and compaction patterns; the local compaction implementation is Pi-based and not DSH's plugin system. | Pi-Apex offers a much narrower, understandable single-user build with strong explicit workspace constraints and a 300-token boot memory summary. | DSH is an extensive “everything is a plugin” harness with separate service/provider/consumer seams, extensible runtime and richer automatic compaction/overflow recovery. Pi-Apex's two-stage compaction is integrated and simple but less policy-rich/composable. DSH current docs show automatic pressure-based compaction, overflow recovery, manual `/compact`, and optional result pruning; do not label these as Pi-Apex features ([DSH repo](https://github.com/deepseek-ai/deepseek-harness), [compaction docs](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction)). |
| **Google Research Harness²** | Contrastive Propose–Probe–Compose, candidate IDs/selection, experience library, and prompt-injection/verdict protections are adapted by Ring 3/9. | Pi-Apex's implementation is guarded by local promotion/validation and immutable guardrails; a small local experience library is useful for one user's workflow. | It is not a faithful full Harness² runtime: the upstream is a recursive research framework, supports candidate-level probes/parallel/sequential recursion and benchmark executors; Pi-Apex's constrained local `EXPERIENCE.md` evolution is only a subset. Upstream README documents eight editable harness components and benchmark results; its own claims are benchmark- and configuration-specific ([Harness² repo](https://github.com/google-research/harness2)). |
| **T3 Code (`pingdotgg/t3code`)** | No source reuse is evidenced in Pi-Apex docs/source; comparison only. | Pi-Apex is a self-contained agent/runtime and security/workspace harness rather than merely a UI for other agents. | T3 Code is a local agent control plane for several installed/authorized CLIs, with desktop/web/mobile clients and multi-agent threads; Pi-Apex is not a multi-device agent-CLI manager or mobile UI. Conversely Pi-Apex owns its tool runtime and guardrails instead of delegating all execution to external CLIs. The current repo describes itself as an “agent harness control surface” and supports multiple installed agents ([T3 Code repo](https://github.com/pingdotgg/t3code)). |
| **OpenAI Codex** | Review-output/diff-review patterns and issue-fix workflow concepts are attributed; `Codex` is used as one reviewer model/style in the Pi-Apex pipeline, not as an embedded Codex runtime. | Pi-Apex's local safeguards and multi-provider runtime can orchestrate selected providers/tools under its own workspace boundaries. | Pi-Apex does not inherit Codex CLI's full agent/runtime/sandbox/review workflow. OpenAI Codex is a separate maintained open-source coding agent; line-level adaptation or format compatibility is not product parity. (Project upstream URL/license is documented in `SPEC_BIBLE.md`; verify current source before any future reuse.) |
| **Vercel `agent-browser`** | ARIA-tree/snapshot/ref interaction ideas and stale-reference protections are attributed, then extended by Pi-Apex's native Node CDP path. | Pi-Apex integrates browser operation with its own deferred-tool/Codemode architecture and can use real local Chromium/CDP, screenshot output, and local-file/metadata checks. | `agent-browser` is a focused browser product with a broader independently maintained CLI/extension surface; Pi-Apex has a narrower browser controller and no deterministic web-search/citation pipeline. Its browser tool is not guaranteed to be used. Any upstream feature comparison should be based on the pinned revision, not assumptions from the adaptation comment. |
| **Obsidian** | No current code attribution or direct integration found. | Local Markdown vault fits Pi-Apex's workspace file model without adding a service. | No vault selector, vault-specific index, backlink resolver, Obsidian API, or safe Obsidian write workflow currently exists. Integration remains a design recommendation only. |

### Other attributed sources found in project docs/source

These are component inspirations or dependencies, not necessarily comparable standalone coding-agent harnesses:

| Source | Pi-Apex use described in project files | Boundary/caveat |
|---|---|---|
| `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-mcp`, `pi-codemode` | Runtime, UI/RPC, model adapters, MCP, and deferred-tool/Codemode plumbing; these are foundational dependencies, not merely copied snippets. | Verify package provenance/license/source access before upgrades; the `earendil-works/pi-coding-agent` GitHub URL in project docs returned 404 in this check. |
| Cursor BugBot / Cursor rules | `REVIEW_RULES.md` review framing, rules-file loading/`.mdc` scope concepts, and CI review-loop inspirations. | These are adaptations of product behavior/conventions, not evidence of a supported Cursor extension or compatibility guarantee. |
| Google Antigravity | Trust-artifact/plan-review design inspiration is attributed in `SPEC_BIBLE.md`. | Not a core runtime dependency; the assessment does not claim code reuse or verified API compatibility. |
| Vercel `agent-browser` | ARIA snapshots, deterministic refs, browser action design, and stale-ref protections, per Ring 2/7 source headers. | Pi-Apex's current browser surface is a subset and its task-time use is not automatic. |
| OpenCode + Pi subagent examples | Git worktree/subagent orchestration, PTY lease buffering and cleanup fixes, and selected scoped-rules concepts. | A component-level adaptation; not upstream agent/runtime parity. |
| Hermes Agent | Skill security/curation and memory redaction, plus named messaging/channel/cron concepts in Ring 3/9. | Several surrounding product capabilities are absent or narrower; the names in attribution do not mean full feature port. |
| DeepSeek Harness | Compaction/promotion philosophy and selected concepts noted in Ring 3/8. | Pi-Apex uses its own Pi-bound implementation; not DSH's plugin framework. |
| OpenAI Codex | Review event/diff conventions and issue-to-PR review patterns. | Does not embed the Codex runtime; no broad CLI parity is implied. |

### Better / equivalent / worse summary

**Better (narrowly, by this build's stated/tested design):** fixed system/tool prefix immutability and hash checks; explicit per-workspace SQLite WAL/FTS state; guarded, auditable filesystem operations and approval modes; a compact integrated personal coding workflow that combines Pi runtime, local browser, multi-provider settings, Git worktrees/review and UI. “Better” here means the particular invariant/control is explicit in source/tests—not an overall benchmark win over upstreams.

**Comparable in component, not parity:** skill quarantine/static screening; lightweight memory summarization; worktree subagents; deferred specialist tools; multi-provider routing; ARIA browser control; Harness²-inspired learning. The local versions are intentionally scoped and do not replicate upstream product surfaces.

**Worse / absent / deferred:** automatic skills match/load; guaranteed browser/search routing and source-citation checks; automatic cross-session episodic recall; broadly configurable external memory; native agent CLI aggregation/mobile clients; breadth and maturity of upstream runtimes; DSH's plugin seams and richer overflow recovery; full Harness² recursive benchmark workflow. These are the principal capability gaps surfaced by this review.

## 7. Recommendations, in priority order

1. **Fix claims before adding features.** Update quickstart/spec copy to state “Skills Library discovery only; task-time loading is not wired” and “browser tool is available on demand, not guaranteed for every research question.” Mark mock/cache benchmark scope clearly. Reconcile old ring/version claims.
2. **Add a small eval gate for browser behavior.** Use tasks that truly require current external facts; record whether tool discovery/call occurred, whether sources are included, and the fail-closed response if browsing is unavailable. Avoid a success metric based only on model prose.
3. **Decide skill execution explicitly.** If wanted, specify and implement progressive disclosure + an explicit load tool, not silent auto-injection. Enforce per-skill trust/permissions and test prompt injection.
4. **Obsidian phase 0: document a safe manual workflow; phase 1: read-only vault selection.** Keep it optional and separate from the `.harness` memory store. Do not write to notes until conflict, approval, backup and diff policy are specified and tested.
5. **Improve memory retrieval only if needed.** Add a bounded, explicit episode-recall tool with per-session/workspace scoping and provenance before considering automatic retrieval; measure false matches and secret leakage. Keep Dreaming as a separately auditable, operator-controlled consolidation action until user explicitly wants automation.
6. **Keep OSS attribution component-scoped.** Add dependency/version/license inventory and preserve notices for copied code; avoid describing a port as full upstream feature parity. Recheck current upstreams before drawing roadmap conclusions.

## 8. Key source map inside this workspace

- Session/root wiring: `src/core/ring0-session.ts`; boot prefix: `src/core/prefix-budget.ts`; local state schema/FTS: `src/core/state-db.ts`.
- Compaction: `src/ring1/two-stage-compaction.ts` and turn-end wiring in `src/core/ring0-session.ts`.
- Browser: `src/ring2/ring2-extension.ts`, `src/ring2/agent-browser-ref.ts`, `src/ring7/chromium-cdp-driver.ts`; tests `test/ring2/run-ring2-tests.ts`.
- Skills: `src/ring3/skill-library.ts`, `src/ring3/ring3-extension.ts`, `src/ring3/skills-guard-quarantine.ts`; UI/API in `src/ring5/mission-control-{ui,server}.ts`; tests `test/ring3/run-ring3-tests.ts`.
- Dreaming: `src/ring3/dreaming-consolidator.ts`; next-boot test in Ring 3 and Ring 4.
- Router/cache telemetry: `src/ring6/provider-router.ts`; cache benchmark: `src/ring8/swe-eval-bench.ts` and `test/ring8/run-ring8-tests.ts`.
- Attribution and historical claims: source headers plus `SPEC_BIBLE.md`, `ARCHITECTURE.md`; skills design scope `skill-plugin-integrations-spec.md`.

## 9. External references checked

- [OpenCode repository](https://github.com/anomalyco/opencode) and [tools docs](https://opencode.ai/docs/tools/)
- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) and [Kanban feature docs](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/kanban.md)
- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and [compaction package docs](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction)
- [Google Research Harness² repository](https://github.com/google-research/harness2)
- [T3 Code repository](https://github.com/pingdotgg/t3code)
- [Obsidian data storage](https://obsidian.md/help/data-storage), [vault setup](https://help.obsidian.md/vault), [URI scheme](https://obsidian.md/help/uri), and third-party [Local REST API/MCP project](https://github.com/coddingtonbear/obsidian-local-rest-api)
- Pi repository link cited by the Pi-Apex project (`earendil-works/pi-coding-agent`) returned a GitHub 404 during this check. Pi-Apex depends on its published packages and records upstream adaptations in project source/spec; the public URL should be confirmed before relying on repository-level comparisons.
