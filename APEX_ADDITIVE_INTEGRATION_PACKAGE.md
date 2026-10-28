# Apex — Additive Integration Reviews (Single-File Package)

**Date:** 2026-10-28
**Purpose:** One self-contained Markdown file covering every external technology reviewed for *additive* integration into the Apex/pi harness: explicit sources, assessments, and how (and whether) each should be integrated.
**Contents:** Part I is the consolidated index and decision record; Part II embeds, verbatim, the full per-technology feasibility documents and the executable spec-graph spike evidence as Appendices A–G. No external file is needed to read this package.

---


**Date:** 2026-10-28 · **Scope:** Every external technology reviewed so far for *additive* integration into the Apex/pi harness, with its explicit source, the assessment, and **how** (and whether) it should land. Each item links to its full feasibility doc in this repo.

**Status legend:** `SPIKE PROVEN` = executable proof exists in-repo · `SIDECAR READY` = clean design, PoC not yet built · `OPTIONAL PROFILE` = operator-enabled, off by default · `KNOW-HOW PORT` = ideas/patterns only, no executable reuse · `SKILL/CONTENT` · `GATED EXPERIMENT` · `REFERENCE/REJECTED`.

## 1. Summary table

| # | Technology | Explicit source | License | Verdict | Where it lands | Status |
|---|---|---|---|---|---|---|
| 1 | **ThinkRail `spec-graph`** | github.com/JetBrains/thinkrail, `packages/spec-graph/core` @ `9066aa9f4bb5c0dcb681235b4b936e8be73651f7` | Apache-2.0 | Integrate the core | Ring 3 (living specs) | **SPIKE PROVEN** |
| 2 | ThinkRail `contracts` / `pi-delegation` / `pi-dag` | same repo | Apache-2.0 | Evaluate, cherry-pick | Ring 5 wire; Ring 2 generalization | Proposed |
| 3 | **open-ontologies** | github.com/fabio-rovai/open-ontologies v2.1.0 (Rust MCP server) | MIT | Integrate, opt-in sidecar | Ring 6 confined MCP + Ring 3 skill | **SIDECAR READY** |
| 4 | **open-code-review (OCR)** | github.com/alibaba/open-code-review; npm `@alibaba-group/open-code-review` | Apache-2.0 | Optional review profile + a zero-binary port | Ring 7 profile; Ring 2 rule selector | **OPTIONAL PROFILE** |
| 5 | **autoharness** | github.com/tigerless-labs/autoharness v0.5.3 | MIT | Do not integrate; port one policy | Ring 3 curator (`lifecycle.evaluate`) | **KNOW-HOW PORT** |
| 6 | **OpenMausBot** | github.com/milind-soni/OpenMausBot; npm `openmausbot` (Apache OSS only; `enterprise/` excluded) | Apache-2.0 | Do not integrate; mine security patterns | Ring 6 MCP hardening; Ring 0/2 consent | **KNOW-HOW PORT** |
| 7 | **IBM STAIR** | arXiv:2609.03874 (CC BY 4.0); code github.com/meghanadhpulivarthi/stair-clean (**no license**, CUDA-only) | Paper CC-BY / code none | Reject STAIR; borrow one idea | Ring 13 heading-addressable FTS5/BM25 | **REFERENCE/REJECTED** |
| 8 | **Huashu Design** | github.com/alchaincyf/huashu-design | MIT | Onboard as sandboxed skill | Ring 3 quarantine → `.agents/skills/` | **SKILL/CONTENT** |
| 9 | **Karpathy skills** | github.com/multica-ai/andrej-karpathy-skills | **NONE** | Re-author originals; do not copy | `surfaces/` or canonical skill | **SKILL/CONTENT** |
| 10 | **Agent-Reach** | github.com/Panniantong/Agent-Reach | MIT | Gated experiment only | external CLI, own egress scope, off | **GATED EXPERIMENT** |
| 11 | **OpenBot** | github.com/nightly-labs/openbot | PolyForm **Noncommercial** | Reject code; UX ideas only | Ring 5 Mission Control reference | **REFERENCE/REJECTED** |

> Items 1, 8–11 originated from one lead: X/@GitTrend0x status `2114877294892233190` (a promotional post); every repo was independently verified against the live GitHub API before assessment.

## 2. Per-technology assessment and integration instructions

### 1. ThinkRail `spec-graph` — INTEGRATE (highest-confidence item)
- **Source:** `https://github.com/JetBrains/thinkrail`, Apache-2.0. The pi-free graph core (6 files: `parse/graph/query/validate/store/index.ts`, 960 LOC, only dependency `yaml`) was vendored **unmodified** at commit `9066aa9` into `pi-apex-harness/spikes/spec-graph/core/` — attribution and pinned SHA in `spikes/spec-graph/NOTICE.md`.
- **Why:** fills a real Ring 3 gap — today's self-evolution memory is flat, token-capped markdown (`EXPERIENCE.md` ≤220 tok, `MEMORY.md` ≤300). Spec-graph gives a multi-file, linked, validated, queryable living-spec model (parent tree + `depends-on`/`references`/`implements` DAG) read on demand, outside the boot prefix. Runs green on Apex's actual runtime: Node 22 `--experimental-strip-types`, **7/7 tests, 0 failures**, no Bun.
- **How to integrate:** graduate `spikes/spec-graph/core/` into `src/ring3/` **verbatim**; keep `NOTICE.md`, keep the upstream SHA pinned, and re-sync deliberately — never edit vendored files in place (keeps upstream merges mechanical). Specs live in `.agents/specs/`. Add a ring test; the pi-coupled `tools/` layer stays deferred (zero schema tokens) until needed. Declare `yaml` as a direct dependency (it is currently only transitive).
- **Full doc:** `FEASIBILITY_review_agent-workbench-repos.md` §3.1; spike write-up `pi-apex-harness/spikes/spec-graph/{README,NOTICE}.md`.

### 2. ThinkRail `contracts`, `pi-delegation`, `pi-dag` — EVALUATE NEXT
- **Source:** same repo, Apache-2.0.
- **How:** (a) port the strict versioned `packages/contracts` client/host wire to harden Ring 5 Mission Control's ad-hoc HTTP/SSE JSON; (b) evaluate `pi-delegation`/`pi-dag` as a generalization of Ring 2's fixed depth-1 5-role subagent pool. Do **not** take the Bun/Electrobun/React IDE. Watch pi-version drift (thinkrail tracks pi 1.3→1.4; Apex is on 1.4.0) and carry NOTICE attribution.

### 3. open-ontologies — INTEGRATE AS OPT-IN SIDECAR (cleanest additive design)
- **Source:** `https://github.com/fabio-rovai/open-ontologies` v2.1.0, MIT. "Terraform for ontologies": plan/apply/rollback RDF/OWL changes with blast-radius and machine-checkable proofs; stdio MCP server, **116 tools + 6 prompts**, no LLM, no credentials, no outbound calls in the default build.
- **Why:** zero capability overlap — formal OWL2/SHACL/SPARQL reasoning that no ring has; composes with Ring 13 (extract → reason).
- **How (all seams already exist, no core change, no FFI, no harness `package.json` entry):**
  1. Install the **pinned Linux release binary by `SHASUMS.txt` SHA-256**, outside the workspace; never vendor Rust source.
  2. Register as an **operator-sourced stdio server in the Ring 6 Confined MCP Hub** (`ConnectStdioMcpParams`, `inheritEnv:false`); the deferred `mcp_hub` tool means all 116 `onto_*` tools cost **+0 active schema tokens**; Ring 6's tool-description poisoning scan still runs.
  3. Launch under Ring 0 `bwrap` with **`--unshare-net` by default**; `onto_pull/onto_push` fail closed until an operator allow-lists a destination. **stdio only** — disable the HTTP transport (its `serve-http 0.0.0.0` no-token mode is full read/write) and WASM plugins.
  4. Onboard its `SKILL.md` through Ring 3 `skills-guard-v10` quarantine; treat outputs as untrusted reference content.
- **Caveat:** native binary can't be JS-scanned — trust rests on MIT + pinned checksum + bwrap + clean env. Single-maintainer bus-factor risk.
- **Full doc:** `FEASIBILITY_open-ontologies.md` (includes a proposed PoC asserting deferred tools, offline `onto_validate`, and blocked `onto_pull`).

### 4. open-code-review (OCR) — OPTIONAL PROFILE, PLUS A CHEAP ZERO-BINARY PORT
- **Source:** `https://github.com/alibaba/open-code-review` (~48.8k★, Apache-2.0); npm `@alibaba-group/open-code-review` — a thin Node launcher with per-OS checksum-verified `optionalDependencies` (Go binary; never vendor Go, no Go toolchain in the build).
- **Reality corrections:** it is **not an offline SAST** — its multi-language "rules" are a deterministic glob→`rule_docs/*.md` prompt map; the LLM always renders the verdict. It is an MCP **client**, not a server; the surface is the CLI + `SKILL.md`.
- **How — track A (zero-binary, do first, pure TS):** port the `system_rules.json` **glob → rule-doc selection** idea into Ring 2's deterministic `REVIEW_RULES` (attach the matching per-language rule doc to the review prompt per changed file). No binary, no credentials, no egress. Also seed the currently empty default rule library.
- **How — track B (optional operator profile):** add the npm package as an **`optionalDependency`** (air-gapped/unsupported-platform installs must not break the build); invoke `ocr review --format json` (or SARIF) from a Ring 2/7 adapter **under bwrap, `--unshare-net` except the LLM provider host**, clean env, token injected from the **Ring 10 vault** (`OCR_LLM_URL`/`OCR_LLM_TOKEN`); map JSON/SARIF onto Apex review objects + Ring 14 audit; keep BugBot's deterministic P0/P1 gate and autofix loop as the hard gate, OCR as the semantic second layer; disable its local web viewer (DNS-rebinding surface). Pin versions (359 open issues), telemetry off.
- **Full doc:** `FEASIBILITY_open-code-review.md`.

### 5. autoharness — DO NOT INTEGRATE; PORT ONE POLICY INTO RING 3
- **Source:** `https://github.com/tigerless-labs/autoharness` v0.5.3, MIT, pure-Python, Claude-Code-coupled. It is not a standalone sidecar and overlaps Ring 3's skill curator, so running both creates competing curators.
- **What to take (re-implemented in TypeScript, behind existing Ring 3 gates):**
  - **`lifecycle.evaluate()` (~40-line pure function) — the clearest win.** Survival = calls ÷ requests since creation; new skills in **probation** (can't be evicted before maturity); graduates go dormant only on zero-use **and** zero-view, and are evicted only on **capacity contention**, lowest rate first, deterministic hash tiebreak. More principled than Ring 3's age-only staleness. Map it onto the Ring 3 SQLite skill ledger (probation/capacity fields) with a ring test.
  - Secondarily: the propose→intent-queue→**deterministic promoter** separation (LLM only proposes, a separate gate validates), and compare-first distillation discipline; its injection-guard/redaction ruleset also informs the missing Python scanner rules (see #8).
- **Reject:** `--dangerously-skip-permissions` child sessions (conflicts with fail-closed/`DENY_UNATTENDED`), the Claude hooks/`.claude` packaging, and any Python sidecar runtime.
- **Full doc:** `FEASIBILITY_autoharness.md`.

### 6. OpenMausBot — DO NOT INTEGRATE; MINE ITS SECURITY PLUMBING
- **Source:** `https://github.com/milind-soni/OpenMausBot` (~6k★, Apache-2.0) and npm `openmausbot` (a standalone Node ≥24 **server/CLI**, no library surface; Electron/React desktop app). **Exclude `enterprise/`** (source-available, non-Apache). Its default runs CLIs with user privileges behind a consent broker — weaker isolation than Apex's bwrap, so it must never regress Ring 0.
- **What to take (Apache-2.0 TypeScript, re-implemented):**
  1. **Ring 6 MCP hardening** — its large tested `server/mcp-*` surface: result budgets, strict handshake, schema validation, per-call timeouts, OAuth store/discovery, remote proxy, read-only/`openWorldHint` annotations. It even ships a **pi MCP extension** (`server/drivers/pi-mcp-extension.ts`, typebox, `-e`-loaded) — a near-direct reference for Apex's pi+MCP ring.
  2. **Ring 0/2 consent model** — capability-token/per-turn capabilities + permission cards + read-only tool annotations (`shared/approval-mode.ts`, `server/admission.ts`, `agent-tool-policy.ts`), layered *inside* existing confinement, never replacing it.
  3. Optional later: per-agent local **Docker VM with noVNC** (local only — never the paid boat.dev cloud path).
- **Reject:** Electron/UI, PostHog analytics, cloud-computer integration, Node ≥24 runtime assumptions, and the known-unclosed loopback route documented in its `SECURITY.md`.
- **Full doc:** `FEASIBILITY_openmausbot.md`.

### 7. IBM STAIR — REJECT; BORROW ONE RETRIEVAL IDEA (and prefer Docling)
- **Source:** paper arXiv:2609.03874 (CC BY 4.0); reference code `github.com/meghanadhpulivarthi/stair-clean` — **no LICENSE**, unmaintained, CUDA-only fine-tuning, per-corpus weights. Conflicts with Apex's local, deterministic, CPU-only, fail-closed model and largely duplicates Ring 1's AST retrieval for code.
- **The one borrowable idea:** heading-addressable retrieval that returns a human-verifiable section path instead of an opaque chunk id. Re-implement **without any fine-tuning**: persist Ring 13's existing `DocumentSectionSpec { heading, sections[] }` tree into the SQLite **FTS5** store and use **BM25 over headings + body** (the paper itself shows BM25 beats zero-shot LLM heading picking, 59.5 vs 45.6 R@1).
- **Better IBM move if document intelligence is the theme:** **Docling (MIT)** to upgrade Ring 13's parse layer (currently `officeparser`+`pdf-lib`); the STAIR-inspired heading retriever is phase two. STAIR itself goes on a watchlist, reconsidered only if Apex ever gains local-GPU/LoRA and a document-Q&A line.
- **Full doc:** `FEASIBILITY_stair-ibm-rag.md`.

### 8. Huashu Design — SANDBOXED SKILL ONBOARDING (best plug-and-play feature)
- **Source:** `https://github.com/alchaincyf/huashu-design`, MIT. HTML/deck/PPTX/MP4/infographic generation — a real gap since Ring 13 only parses; already uses `pdf-lib` which Apex vendors.
- **How:** onboard through the standard Ring 3 **quarantine → promotion** flow into `.agents/skills/`; execute only inside **bwrap with egress off**; it needs `playwright` + native `sharp` + `python3`, so first **extend `skills-guard-v10` with Python rules** (subprocess/eval/urllib/pickle — the current guard is JS/shell-oriented); localize the Chinese `SKILL.md`.

### 9. Karpathy skills — RE-AUTHOR, NEVER COPY
- **Source:** `https://github.com/multica-ai/andrej-karpathy-skills` — **no LICENSE (all rights reserved)**; third-party repo trading on Karpathy's name, no official endorsement.
- **How:** the four principles (think-first, simplicity, surgical changes, goal-driven verification) are ideas, not copyrightable expression — write an equivalent **original canonical skill or `surfaces/` entry**. Do not copy prose. Low novelty (Apex already enforces most of it) but high signal-to-noise.

### 10. Agent-Reach — GATED EXPERIMENT, OFF BY DEFAULT
- **Source:** `https://github.com/Panniantong/Agent-Reach`, MIT, Python scraping CLI for ~14 social platforms.
- **Why gated:** login-wall scraping needs broad egress + session cookies, ToS/legal exposure, and the project is monetized via residential-proxy/anti-bot sponsors — directly opposed to Ring 0 default-deny (3-host allowlist).
- **How (if ever):** wrap as an explicitly opt-in **external CLI/MCP outside the default bwrap ring** with its own egress scope; cookies in the **Ring 10 vault** with masking; prefer **official APIs** for the low-risk subset (YouTube transcripts, GitHub, public Reddit). No default-install path.

### 11. OpenBot — REJECT CODE; UX REFERENCE ONLY
- **Source:** `https://github.com/nightly-labs/openbot`, **PolyForm Noncommercial 1.0.0** (blocks commercial reuse), and it runs agents with `danger-full-access` + `approvalPolicy: never` — the inverse of Ring 0. ~90% feature overlap.
- **How:** borrow only interaction ideas for Ring 5 Mission Control — FIFO queue lifecycle (pause/resume/reassign/archive), single-owner shared channel, per-agent workspace panel. No code, no dependency.

## 3. Cross-cutting integration rules (apply to every item)

1. **Never weaken Ring 0.** Everything runs under bwrap/openat2 fail-closed, `network_egress: default-deny`; egress is opened per host, explicitly, and off by default. Reject anything requiring permission-skipped agents (autoharness, OpenBot).
2. **Secrets only via Ring 10 vault** (0600, masked, never in env inheritance, argv, logs, or SSE) — OCR tokens, Agent-Reach cookies.
3. **Third-party skills/code enter through Ring 3 `skills-guard-v10` quarantine**; extend the guard with Python rules before any Python-bearing skill (Huashu); native binaries can't be JS-scanned, so their trust chain is license + **pinned SHA-256** + bwrap + clean env + Ring 6 description scan (open-ontologies, OCR).
4. **Prefer existing seams over new runtimes:** stdio MCP + deferred `mcp_hub` (+0 schema tokens) for sidecars; no Python/Go/Electron in the harness build; no new harness `package.json` hard dependency — use `optionalDependency` where a binary is unavoidable.
5. **License hygiene:** Apache-2.0/MIT are usable with NOTICE/attribution and pinned commits; **no-license (Karpathy, STAIR code) and PolyForm-NC (OpenBot) are never copied**; OpenMausBot `enterprise/` is off-limits.
6. **Pin and re-sync deliberately:** vendored files stay unmodified with upstream SHA recorded (spec-graph NOTICE model); external engines get pinned versions given their open-issue load.
7. **Deterministic gates stay local and hard; LLM/network capabilities stay optional and advisory.** OCR and any scraping are operator-enabled profiles, never part of Tier-A/B ring tests.

## 4. Recommended priority

1. **Now:** graduate the **spec-graph spike → Ring 3** (proof already green); do the **OCR zero-binary glob→rule selector** and seed the empty `REVIEW_RULES.md`; re-author the **Karpathy-style canonical skill**.
2. **Next, low-risk builds:** **open-ontologies Ring 6 sidecar PoC**; **autoharness `lifecycle.evaluate` → Ring 3** TS port; **Huashu** skill after the Python scanner upgrade.
3. **Design work:** OpenMausBot-derived **Ring 6 MCP hardening + consent broker** backlog; ThinkRail `contracts` wire for Ring 5; Ring 13 **FTS5/BM25 heading retriever** (+ Docling parse upgrade).
4. **Optional/heavy:** OCR binary Ring 7 profile; `pi-delegation`/`pi-dag` Ring 2 generalization; local Docker-VM computer use.
5. **Gated/avoided:** Agent-Reach (egress-scoped experiment only); no code from OpenBot, STAIR, or OpenMausBot-as-product; no autoharness/OpenMausBot sidecars.

## 5. Source documents in this repo (all embedded in Part II)
- `FEASIBILITY_review_agent-workbench-repos.md` — ThinkRail, Agent-Reach, Karpathy, Huashu, OpenBot → **Appendix A**
- `FEASIBILITY_stair-ibm-rag.md` — IBM STAIR (+ Docling note) → **Appendix B**
- `FEASIBILITY_autoharness.md` — tigerless-labs/autoharness → **Appendix C**
- `FEASIBILITY_open-ontologies.md` — fabio-rovai/open-ontologies → **Appendix D**
- `FEASIBILITY_open-code-review.md` — alibaba/open-code-review → **Appendix E**
- `FEASIBILITY_openmausbot.md` — milind-soni/OpenMausBot → **Appendix F**
- `pi-apex-harness/spikes/spec-graph/{README,NOTICE}.md` — executable spec-graph port evidence → **Appendix G**

> In this single-file package every document above is included verbatim in Part II, so the file is fully self-contained. The original files remain in the repository unchanged.

---
---

# Part II — Full Source Reviews (Appendices)

The documents referenced in Part I, Section 5 are embedded here in full.


---

## Appendix A — Five trending "agent workbench" repos (ThinkRail, Agent-Reach, Karpathy skills, Huashu, OpenBot)


**Date:** 2026-10-28 · **Source:** X/@GitTrend0x status 2114877294892233190 (promotional post; sponsor/referral links)
**Method:** Each repo was verified against the live GitHub API (existence, license, language, activity, tree) and its README/key docs/source layout were inspected. Star figures below are **current API values**, not the post's "daily gain" framing.

## 1. Verified snapshot

| # | Repo | Stars (live) | Lang | License | Last push | One-liner |
|---|------|-------------:|------|---------|-----------|-----------|
| 1 | `JetBrains/thinkrail` | 3,967 | TypeScript (Bun/Turbo monorepo) | **Apache-2.0** | 2026-10-27 | Real IDE/host built **in-process on the same `pi` engine Apex uses**; living specs, subagents, DAGs, typed client/host wire |
| 2 | `Panniantong/Agent-Reach` | 104,906 | Python (CLI, `requests`) | MIT | 2026-10-25 | One CLI to read/search Twitter, Reddit, YouTube, GitHub, Bilibili, Xiaohongshu, etc., incl. login-walled content, "zero API fee" |
| 3 | `multica-ai/andrej-karpathy-skills` | 225,483 | Markdown only | **NONE (all-rights-reserved)** | 2026-04-20 | Single `CLAUDE.md` of 4 behavioral principles; ships `SKILL.md` + `.cursor/.mdc` |
| 4 | `alchaincyf/huashu-design` | 27,728 | HTML skill + Python/Node scripts | MIT | 2026-10-23 | Design-generation **skill**: HTML prototypes, decks, editable PPTX, MP4/GIF animation, infographics; self-evolving taste ledger |
| 5 | `nightly-labs/openbot` | 2,398 | TypeScript/Electron | **PolyForm Noncommercial 1.0.0** | 2026-10-27 | Desktop workspace: per-agent workspaces, FIFO queues, embedded browser, agent-to-agent chat; **dev preview, `danger-full-access`** |

All five are real, active, and fast-growing. The post itself is marketing (Chinese-language, proxy/scraping sponsors), so treat its framing as hype even though the repos are legitimate.

## 2. What Apex already covers (the novelty baseline)

Most themes in the post are **already implemented** in Apex's rings:

| Theme in the post | Apex today |
|---|---|
| Multi-workspace isolation | Ring 2 disjoint `git worktree` pool; Ring 9 multi-workspace cockpit |
| Reusable skills + quarantine | Ring 3 `.agents/skills/SKILL.md` curator + `skills-guard-v10`; Ring 9 QuickJS plugin host |
| Living specs / self-evolution / memory | `surfaces/` (SYSTEM/TOOL_GUIDANCE/MEMORY/EXPERIENCE), Ring 3 Harness² evolver + dreaming, Ring 2 plan/trust artifacts |
| Subagents, delegation, DAG/swarm | Ring 2 5-role depth-1 pool; Ring 9 orchestrator (`dag`/`supervisor`/`debate`/`map_reduce`) + blackboard |
| Background commands / scheduling | Ring 2 PTY leases + `DENY_UNATTENDED` cron |
| Browser / computer control | Ring 7 Chromium CDP; Ring 2 agent-browser; Ring 3 approval-gated CUA |
| Agent-to-agent messaging | Ring 9 omni-channel gateway + blackboard |
| Documents | Ring 13 **ingestion/parsing** (PDF/DOCX/XLSX/PPTX/HTML/OCR) — read side only |
| Behavioral discipline | Plan mode, trust artifacts, ThreeStrikeLoopGuard, scoped `.mdc` rules |

Genuine **gaps** these repos could fill: (a) a *queryable graph* of living specs rather than flat markdown; (b) a *versioned typed wire* for the cockpit; (c) design/*content generation*; (d) broad web/social data access; (e) a compact canonical "behavior rules" doc; (f) polished FIFO queue / multi-agent desktop UX.

## 3. Per-repo feasibility

### 1) ThinkRail — **most strategically relevant; cherry-pick, don't fork**
- **Why it fits:** runs `createAgentSession` in-process on the same `@earendil-works/pi` engine (its docs cite the same pi PRs/catalog as Apex). Explicitly ships **portable packages**: `spec-graph` (`spec_*` tools + a pi-free graph read model = *living specs as a graph*), `pi-delegation`, `pi-dag`, `pi-subagents`, `pi-background-commands`, plus a strict versioned **`packages/contracts`** client/host wire and `ask-user-question`/`visualize` extensions.
- **New vs Apex:** spec-graph and the typed wire are real upgrades (Apex specs are flat `.md`; Mission Control is ad-hoc HTTP/SSE JSON). Delegation/DAG generalize Apex's fixed depth-1 pool.
- **Effort/risk:** Medium. Pull individual portable packages, align to **pi 1.4.0**, do **not** take the Bun/Electrobun/React IDE. Apache-2.0 requires NOTICE/attribution. Watch pi-version drift (thinkrail tracks pi 1.3→1.4 catalog changes).
- **Verdict: NOTEWORTHY — best source for the "living specs moat" and a hardened cockpit contract.**

### 2) Agent-Reach — **fills a real gap but fights the security model; opt-in subset only**
- **What it is:** ~14 per-platform `channels/*` scrapers (twitter, reddit, youtube transcript, bilibili, xiaohongshu, linkedin, instagram, github, …) behind one Python CLI; deps are light (`requests`).
- **Conflict with Apex:** Ring 0 is `network_egress: default-deny` with a 3-host allowlist. Login-wall scraping needs **broad egress + session cookies**, carries ToS/legal exposure and fragility, and the project is monetized via residential-proxy/anti-bot sponsors (Bright Data, stealth/captcha vendors). "Zero API fee" = scraping, not a safe primitive.
- **How to do it safely (if at all):** wrap as an **explicitly opt-in external CLI/MCP** outside the default bwrap ring, with its own egress scope; route any cookies through the Ring-10 0600 vault + masking; prefer **official APIs** for the low-risk subset (YouTube transcripts, GitHub, public Reddit).
- **Verdict: NOTEWORTHY but high operational/legal risk — curated, egress-scoped, off by default.**

### 3) Karpathy skills — **cheap content win, but re-author; no license**
- Four principles (think-first, simplicity, surgical changes, goal-driven verification). Mechanically a perfect match for Apex conventions (`SKILL.md`, `.mdc` scoped rules, `AGENTS.md`).
- **Blocker:** the repo has **no LICENSE** → default "all rights reserved"; copying the prose is not legally safe. The *ideas* aren't copyrightable, so re-write an equivalent canonical rule surface/skill. Third-party repo trading on Karpathy's name (no official endorsement).
- **Novelty:** low (Apex already enforces most of this operationally), but high signal-to-noise; the post's own top comment argues "rules before eyes/workbenches."
- **Verdict: do it as a small original-content addition to `surfaces/` or a bundled canonical skill — not a dependency.**

### 4) Huashu Design — **strongest plug-and-play feature add (uses the existing skill pipeline)**
- **What it adds:** design *generation* — a gap, since Ring 13 only parses. Outputs high-fidelity HTML prototypes, 1920×1080 decks, timeline animation/MP4/GIF, editable PPTX (`pptxgenjs`), infographics, with a 6-thumbnails→3-directions workflow and a self-evolving preference/lesson ledger (conceptually a domain-specific EXPERIENCE.md). Already depends on **`pdf-lib`, which Apex already vendors**.
- **Fit:** installs through Apex's quarantine→promotion skill flow (`.agents/skills/`); MIT is clean.
- **Costs/hardening:** needs `playwright` + native `sharp` + `python3`; `SKILL.md` is Chinese (localize). Apex's scanner **does read/hash `.py` files and refuses symlinks**, but its threat rules are JS/shell-oriented with **no Python-specific patterns** — so execute only inside bwrap with egress off, and extend `skills-guard-v10` with Python rules (subprocess/eval/urllib/pickle).
- **Verdict: NOTEWORTHY — best immediate feature; onboard sandboxed, then harden the scanner.**

### 5) OpenBot — **do not integrate code; UX reference only**
- **License:** PolyForm **Noncommercial** — blocks reuse in anything potentially commercial.
- **Security:** explicitly runs agents with `danger-full-access` + `approvalPolicy: never` after one consent — the opposite of Apex's fail-closed Ring 0; the post itself flags it ⚠️.
- **Overlap:** ~90% already exists (workspaces, queues, browser, CUA, compaction, agent messaging). Electron desktop shell + telemetry/accounts add weight.
- **Borrow only ideas:** FIFO queue lifecycle (pause/resume/reassign/archive), shared channel chat with a single task owner, per-agent workspace panel.
- **Verdict: skip code; reference for Mission-Control UX.**

## 4. Recommended sequencing

1. **Now / low-cost:** re-author the Karpathy-style rules as an original canonical skill/surface (3); prototype **Huashu** onboarding behind bwrap + a Python-aware scanner (4).
2. **Strategic spike:** port ThinkRail **`spec-graph`** and the **`contracts`** typed wire into Rings 3/5; evaluate `pi-delegation`/`pi-dag` as a generalization of Ring 2 (1).
3. **Cautious/optional:** an opt-in, egress-scoped Agent-Reach wrapper using official APIs where possible (2).
4. **Avoid:** pulling OpenBot code (license + insecure defaults) (5).

## 5. Cross-cutting cautions
- **License hygiene:** Apache-2.0 (thinkrail) and MIT (reach/huashu) are usable with attribution; **no-license (karpathy) and PolyForm-NC (openbot) are not** copyable.
- **Security-first framing:** any scraping (2) or script-bearing skill (4) must stay behind the existing fail-closed confinement, default-deny egress, secret vault, and quarantine scan — not weaken them.
- **Localization:** 2–4 are Chinese-first; budget English localization of prompts/docs.
- **Don't trust the hype:** validate maintenance/issue load (thinkrail 224 open issues, openbot 221) and pin versions; treat these as inputs to Apex's roadmap, not guaranteed-stable dependencies.

---

## Appendix B — IBM STAIR (ToC-based generative RAG)


**Date:** 2026-10-28 · **Context:** follow-up to the 5-repo agent-workbench feasibility review
**Sources:** arXiv:2609.03874 (CC BY 4.0), the authors' GitHub/Hugging Face links, GitHub API metadata, and the Apex codebase.

## 1. What STAIR actually is

**STAIR = STructure Aware Information Retriever**, an IBM Research paper (Kumar, Pulivarthi, Kumar, Sen, Bhat, Joshi; arXiv v2 2026-10-13). The lead author notes "work done while at IBM, currently at Amazon."

- **Idea:** instead of splitting documents into fixed-size chunks, fine-tune an LLM so that, given a query **plus the document's Table of Contents**, it *generates* the specific ToC leaf heading that answers the query (constrained decoding over valid headings). There is **no vector database** — the corpus index lives in the fine-tuned weights ([arXiv abstract](https://arxiv.org/abs/2609.03874)).
- **Method:** Stage 1 synthetic QA generation from the document → Stage 2 LoRA fine-tune (Mistral-7B-Instruct-v0.2, LoRA r=16/α=32, **up to 200 epochs**, 14k-token input) → Stage 3 constrained inference to valid ToC nodes.
- **Results on SearchTome** (18 books, 6 domains — education/finance/law/med/natsci/socsci): Recall@1 **82.6%** vs DSI 76.9%, DPR 68.7%, BM25 59.5%, zero-shot Mistral 13.8%; claimed hallucination **<0.05%**.
- Important nuance from the paper's own table: a strong modern LLM asked to just *pick* a heading with no fine-tuning (Claude Haiku 4.5) reaches only **45.6% R@1** — the fine-tuning is what carries the quality, not the ToC idea alone.

## 2. Availability & maturity reality check

| Artifact | Reality |
|---|---|
| Paper | arXiv 2609.03874, CC BY 4.0 (ideas usable with attribution) |
| "Official" code | `github.com/meghanadhpulivarthi/stair-clean` — **personal repo, not an IBM org**; **no LICENSE** (all-rights-reserved); 6 stars; 66 commits; no pushes since 2026-09-30; README states training **"requires a local CUDA GPU — the vendored trainer has no CPU fallback"** (vendored FSDP trainer, Python 3.12/`uv`) |
| Dataset | Hugging Face `meghanadh/SearchTome` (18 books) |
| Third-party reimpl. | `Eyna-A/STAIR-ToC-RAG` (MIT, 7 stars) — but it uses **Qdrant + embeddings**, i.e. it abandons STAIR's core "index in weights" premise; effectively a ToC-aware *vector* RAG |
| IBM production RAG stack | **Docling** (`docling-project/docling`, MIT, ~69.7k stars, daily commits) for parsing; **InspectorRAGet** (`IBM/`, Apache-2.0, active) for RAG evaluation; **Blended-RAG** (89 stars, NOASSERTION, notebooks, stale since May 2025); **OpenRAG** framework (Langflow+Docling+OpenSearch, described on ibm.com) |

**Verdict on maturity:** STAIR is a ~6-week-old research paper with effectively unmaintained, unlicensed reference code and a tiny benchmark — not a dependency candidate. IBM's *maintained* RAG assets are Docling and InspectorRAGet, not STAIR.

## 3. Fit with Apex — the full approach is a poor match

Apex's codebase currently contains **zero** embedding/vector/fine-tuning/training code (verified by grep). Its retrieval is Ring 1 Tree-sitter Merkle AST + PageRank/BM25, FTS5 episodic memory, and LSP — all local, deterministic, CPU-friendly.

| STAIR requirement | Apex constraint | Conflict |
|---|---|---|
| Per-corpus LoRA fine-tuning of a 7B model, CUDA/FSDP, no CPU fallback | Local-first, SQLite/WASM, runs on laptops & locked-down Linux; offline deterministic test suite | **Hard.** No GPU story; non-deterministic; can't be exercised by any current test ring |
| Download multi-GB base weights; long training jobs | Ring 0 `bwrap` default-deny egress, 3-host allowlist, fail-closed confinement | Training/weights don't fit the confinement model; would have to live entirely outside Ring 0 |
| One fine-tuned model per corpus, retrained as docs change | Ephemeral worktrees/sessions, immutable prefix budgets, skill quarantine | No lifecycle for model artifacts; `.safetensors`/checkpoints are outside `skills-guard-v10`'s threat model (pickle/checkpoint supply-chain risk) |
| Targets long structured **prose** (textbooks, manuals, contracts, reports) | Apex's center of gravity is **code**, whose "ToC" is the AST — already exploited by Ring 1's Merkle repo map (rank #1 retrieval in the brownfield benchmark) | STAIR solves a problem Ring 1 largely already handles for code; overlap is mainly Ring 13 documents |
| Unlicensed reference code | Apex vendors only MIT/Apache-clean dependencies | Cannot legally copy `stair-clean`; paper ideas are CC-BY but code is not |

## 4. The borrowable idea (cheap, and Apex already holds the raw material)

The *concept* — structure-aware, **heading-addressable retrieval that returns a human-verifiable section path instead of an opaque `chunk_0417`** — aligns strongly with Apex's provenance/trust-artifact ethos. And Ring 13 already parses documents into `DocumentSectionSpec { heading, sections[] }` hierarchies (≤50 sections, validated), so no new parser is needed.

A pragmatic **no-training "STAIR-inspired" retriever** could be:
1. Persist Ring 13's heading tree + section bodies into the existing SQLite **FTS5** store.
2. Backbone retrieval with **BM25/FTS over headings and body** (the paper shows BM25 alone already beats zero-shot LLM heading picking: 59.5 vs 45.6 R@1).
3. Add an optional **constrained LLM step** via Apex's existing model providers: feed the ToC + query, force the output to one of the valid heading IDs (JSON-enum tool-call style), return the heading path as a cited trust artifact.
4. Keep it deterministic-testable with the `faux/faux-1` pattern used across existing rings.

This captures STAIR's verifiability/provenance benefit without GPUs, weights, or license risk — at the cost of not matching its fine-tuned 82.6% R@1 (honest expectation: BM25-class performance plus LLM reranking). If document Q&A becomes a real product surface, evaluate it with **InspectorRAGet** (Apache-2.0) rather than inventing metrics.

## 5. If Apex wants RAG seriously, these IBM assets beat STAIR

- **Docling (MIT, ~70k★, actively maintained):** industry-grade PDF/DOCX/PPTX/HTML structural parsing. Ring 13 currently uses `officeparser` + `pdf-lib`; Docling would be a direct, license-clean upgrade to the *parse* layer and emits exactly the heading hierarchy a ToC-retriever needs.
- **InspectorRAGet (Apache-2.0, IBM org, active):** RAG/trace evaluation platform — useful as the verification harness for any retrieval feature, consistent with Apex's canary/ring testing discipline.
- **OpenRAG / Blended-RAG:** reference only. Blended-RAG is stale notebooks with an unclear license; OpenRAG is a heavyweight Langflow/OpenSearch platform mismatched with Apex's embedded, local-first shape.

## 6. Verdict & priority

**STAIR itself: do not integrate.** Research-stage, unlicensed, CUDA-only, per-corpus training, prose-domain — it conflicts with Apex's local-first, deterministic, fail-closed architecture and its code-retrieval strengths. Put it on a **watchlist**; reconsider only if Apex ever gains a local-GPU/LoRA capability (e.g., via Ollama-adjacent tooling) and a document-Q&A product line.

**Adopt the idea, not the implementation:** a Ring-13-native structural retriever (FTS5/BM25 over the heading tree + constrained heading selection + cited provenance) is a small, testable, in-architecture feature.

**Relative to the earlier five repos:** lower priority than ThinkRail `spec-graph` (strategic) and Huashu (plug-and-play skill); roughly on par with Agent-Reach as a "gated experiment," and clearly above OpenBot-style code reuse. If document intelligence is the theme, **Docling for Ring 13 parsing is the highest-ROI IBM move**, with a STAIR-inspired heading retriever as a natural phase two.

---

## Appendix C — tigerless-labs/autoharness


**Date:** 2026-10-28 · **Question:** Is it a good addition to Apex, and is it *additive*?
**Method:** Inspected the live repo via GitHub API (manifest, hooks, `src/`, agents, lifecycle/guard/redaction internals, tests). No clone (small repo, ~980 KB).

## 1. Snapshot

| Attribute | Finding |
|---|---|
| What it is | "Self-learning skill layer for Claude Code" — distills skills from real sessions, merges same-scenario ones, prunes by real usage. **No daemon, no benchmark on the active path.** |
| License / deps | **MIT**; **pure Python 3.11+, zero third-party dependencies** (stdlib only; no `pyproject`/`requirements`) |
| Packaging | A **Claude Code plugin**: `.claude-plugin/plugin.json` + `hooks/hooks.json` (SessionStart/Stop/PreToolUse/SessionEnd) + a stdio MCP server `stage_skill` |
| Engine | Two Haiku subagents — **reflector** (episode → skill intents) and **curator** (umbrella consolidation) — that only *propose*; a deterministic **promoter** validates and lands; a pure **lifecycle** module archives by usage |
| Maturity | ~10.4k★, 630 forks, 50 open issues, v0.5.3 (pre-1.0), single org (Tigerless Labs), pushed 2026-10-27; Linux/macOS only; **40+ pytest files**, rigorous concurrency/atomicity tests |
| Evidence | Claims CORE-Bench **42% → 78%**, citing the HAL paper (arXiv:2510.11977, "Big Model vs Big Harness"). Single, vendor-run benchmark — directional, not independent proof |
| Default posture | Local, stdlib-only; no outbound calls except an opt-in, fail-open notifier (argv, not shell; redacted; timeout-bounded) |

## 2. The decisive integration fact: it is not a standalone sidecar

Unlike `open-ontologies` (a generic stdio MCP server that any MCP client can spawn), autoharness's MCP server is **only an append-only intent queue** (`stage_skill` "never touches any skill tree"). The actual behavior is inseparable from **Claude Code itself**:

- Hook events are Claude Code's lifecycle (`hooks.json` → a Python dispatcher keyed off `hook_event_name`).
- Reflection **shells out to the Claude CLI** — `spawn.py` builds `[claude_bin, "-p", "--agent", agent, "--dangerously-skip-permissions"]` (and a `--resume --fork-session` mode), with a `CHILD_SESSION_ENV` recursion guard. Tests inject a fake reflector "in place of the real claude."
- Skills/state paths are Claude's (`.claude/skills/`, `~/.claude/autoharness/`, `${CLAUDE_PLUGIN_ROOT}`).

Apex runs on `@earendil-works/pi-coding-agent`, not Claude Code. There is therefore **no "register this MCP server and you get the feature" path**; adopting the system means re-hosting its triggers, subagent launch, and storage on pi primitives.

## 3. Overlap with Apex Ring 3 is large — it is not additive as a *system*

Ring 3 already implements the same conceptual loop, so running both would create two competing curators over the same skill directory.

| Capability | Apex Ring 3 today | autoharness |
|---|---|---|
| Distill lessons from sessions | Quarantine-first skill distiller | Reflector subagent + compare-first intents |
| Merge / umbrella consolidation | Curator with `absorbedInto` umbrella guard (#29912) | Curator folds narrow skills, `absorbed_into` provenance |
| Pruning | **Time-based**: 14d stale → 30d archived; zero-use protection | **Usage-rate-based**: probation → maturity → capacity eviction |
| Static safety scan | `skills-guard-v10` (Hermes-derived, JS/TS-oriented) | Independent 6-family Python guard, **injection-first** |
| Secret/redaction | Two-pass learned-token scrub; spill scrub | ReDoS-aware `redaction_rules.toml` (AWS/PEM/GitHub/Slack/bearer/PII) |
| Recall | `memory_recall` FTS5, explicitly **on-demand, never auto-injected** | Session-start grouped index **auto-injection** (with kill-switch + char budget) |
| Trust boundary | `canonical` vs `community` source kinds | `created_by:agent` markers; only ever edits its own skills |
| Provenance | Hash-chained self-learning ledger (Ring 9); skill ledger | Per-skill evidence ledger + pre-run snapshots |
| Trigger | On-demand/scheduled; cron behind `DENY_UNATTENDED` | Event cadence every N tool calls via hooks; no daemon |
| Skill subfiles | `references/templates/scripts/assets` allowlist | Same three + `assets`, with package-integrity folding |

## 4. What *is* genuinely additive (portable, MIT, host-agnostic)

The value is in the **deterministic policies and data artifacts**, which are plain Python/stdlib and re-implementable in TypeScript — not the plugin.

1. **Usage-rate fitness model (the clearest win).** `lifecycle.evaluate()` is a ~40-line pure function: survival = calls ÷ requests-since-creation (adherence, not wall-clock); new skills sit in **probation** (denominator below a maturity threshold → can't be evicted); at graduation, zero-use **and** zero-view means dormancy; graduates die only by **capacity contention**, evicting lowest rate with a deterministic hash tiebreak. This is more principled than Ring 3's age-only staleness and is directly portable to the Ring 3 curator/SQLite counters.
2. **Propose → intent-queue → deterministic promoter.** The LLM subagents can only append proposals; an independent deterministic gate validates schema, security, and membership before any write, across separate processes with drain locks. This is the same trust philosophy as Apex's Harness² 4-gate validator, applied end-to-end to skills — a good reference design for hardening the Ring 3 distiller.
3. **Injection-first guard + redaction ruleset.** Its `skills_guard.py` explicitly models the SKILL.md body as an indirect-injection vehicle (six families: exfiltration/injection/destructive/persistence/network/obfuscation) and calls its threat model stronger than the Hermes scanner Apex's guard descends from. The `redaction_rules.toml` is careful about ReDoS (possessive quantifiers, bounded backtracking). Both are useful to **strengthen Apex's JS scanner — including the missing Python-specific rules flagged in the Huashu review — and its secret scrubbing**, as MIT reference material.
4. **Compare-first distillation discipline.** "Patch the loaded skill → patch a class skill → subfile → only then create a class-level umbrella," plus mandatory contradiction reconciliation before adding a rule. A concrete prompt/policy upgrade for Ring 3 distillation that targets the near-duplicate accretion problem.
5. **Evidence/undo mechanics.** Intent ledger, `absorbed_into` merge provenance ("a merge is never mistaken for a death"), and N pre-run snapshots for the one operation a single atomic rename can't undo.

## 5. What to reject or heavily adapt

- **`--dangerously-skip-permissions` autonomous child sessions.** This directly conflicts with Apex's fail-closed, approval-gated, `DENY_UNATTENDED` posture. Any native version must run reflection through the **Ring 2 worktree subagent pool with normal approval/confinement**, never a permission-skipped child.
- **Session-start index auto-injection.** It fights Apex's zero-static-prefix-drift invariant and the explicit "recall is not automatic" design in `TOOL_GUIDANCE.md`. If wanted, expose it as a **deferred/budgeted** tool rather than a per-session prompt injection.
- **Global + project two-layer management.** Apex is workspace-scoped with out-of-workspace vault separation; a global auto-managed layer broadens blast radius and should stay opt-in/project-only initially.
- **The Claude hook/CLI/MCP packaging and `.claude` paths** — not reusable; re-host on pi session events, Ring 0/2/3 primitives, and `.agents/skills/`.
- Treat the CORE-Bench number as motivation, not a spec; validate any port against Apex's own deterministic ring tests.

## 6. Effort and verdict

- **As a drop-in component: do not integrate.** Hard Claude-Code/CLI coupling, large functional overlap with Ring 3, a permission-skipping child-process model, and auto-injection that tensions with prefix discipline make wholesale adoption (or side-by-side running) a poor fit. A Python sidecar would also sit awkwardly in a TypeScript, bwrap-confined harness and add a runtime the core doesn't otherwise need.
- **As a policy source: selectively mine the deterministic core.** A focused Ring 3 enhancement could port, in TypeScript, behind the existing quarantine/approval gates:
  1. the **rate/probation/capacity lifecycle** (replaces age-only pruning) — small, pure, high value;
  2. the **intent-queue + deterministic promoter** separation for the distiller;
  3. selected **injection-family and Python-aware guard patterns + redaction rules**;
  4. the **compare-first/umbrella authoring policy**.

**Bottom line:** *not additive as a product, but additive as know-how.* It is best treated as a well-tested, MIT-licensed reference implementation for the specific Ring 3 policy upgrades above — most immediately the usage-rate lifecycle, which Apex currently lacks. It ranks below `spec-graph` (a portable, directly runnable core) and `open-ontologies` (a clean confined MCP sidecar) on integration ease, because none of autoharness's executable surface is reusable without re-architecting it onto pi.

### Suggested next step
A small design note mapping `lifecycle.evaluate` onto Ring 3's SQLite skill ledger (probation/capacity fields + a deterministic `evaluate` TS port with a ring test), kept behind the existing curator gates — no Python, no hooks, no autonomous child processes.

---

## Appendix D — fabio-rovai/open-ontologies


**Date:** 2026-10-28 · **Question:** Is it a good Apex integration, and is it *additive*?
**Method:** Inspected the live repo via GitHub API (metadata, `Cargo.toml`, `.mcp*`, `SKILL.md`, `SECURITY.md`, release assets). No clone — the repo is ~232 MB (its `benchmark/` alone is referenced as ~23 GB).

## 1. Snapshot

| Attribute | Finding |
|---|---|
| Purpose | "Terraform for ontologies": **plan → apply → roll back** semantic changes to production RDF/OWL, with blast-radius reports, conservativity checks, and **machine-checkable proofs** |
| License | **MIT** (engine "stays MIT"; a hosted platform is the commercial layer) — no license blocker |
| Language / shape | **Rust, single self-contained binary**, no JVM, in-memory **Oxigraph** triple store, bundled `rusqlite` |
| MCP | stdio MCP server (`open-ontologies serve`, `rmcp` 1.4); `.mcp/server.json` reports **116 tools + 6 prompts** (108 in default build; 8 behind optional Cargo features) |
| Security posture | Local engine, **no LLM, no credentials, no outbound calls in a default build**; explicit `SECURITY.md` threat model; fail-closed "undetermined" verdicts |
| Distribution | Per-OS release binaries + `SHASUMS.txt` (923 B) and a GHCR OCI image; also a Python `open_ontologies_lite` MCP server (pyoxigraph wheel) |
| Maturity | ~1.85k★, 227 forks, **10 open issues**, pushed 2026-10-26, v2.1.0; effectively single-maintainer (`fabio-rovai` / Tesseract Semantics) — bus-factor risk |
| Heavy extras (optional) | Lean4/Isabelle/Dafny/Rocq/Aeneas proof toolchain; ONNX embeddings (`tract-onnx`/`tokenizers`), DuckDB, Postgres, WASM plugins (`wasmi`, fuel-metered) |

## 2. Is it additive? — **Yes, on both axes, but niche and opt-in**

### 2.1 Capability: genuinely net-new (zero overlap)
No Apex ring does semantic/ontology reasoning or formal verification:

| Apex today | open-ontologies adds |
|---|---|
| Ring 1 — code AST / PageRank / BM25 over *source* | OWL2/SHACL/SPARQL reasoning, SHIQ tableaux satisfiability, conservativity/blast-radius over *RDF data* |
| spec-graph spike — markdown frontmatter DAG of code decisions (no reasoner) | A real inference engine that **derives** consequences and refuses forged edges with an independently re-checkable Lean certificate |
| Ring 13 — document/table **extraction** (CSV/XLSX/Parquet in) | Consumes the same tabular/serialized inputs to **model, validate and govern** them — complementary (extract → reason), not replacement |
| Rings 0–15 — no knowledge-graph / description-logic / theorem-proving surface | All of it, plus audit-grade proof artifacts |

It is **not** a retrieval system (different from IBM STAIR) and **not** a code-intent graph (different layer from ThinkRail spec-graph). It occupies an empty slot.

### 2.2 Architecture: the *cleanest* kind of additive — a sidecar, not a dependency
It integrates as an **external stdio MCP server + a skill**, requiring **no changes to Apex core, no FFI, and no new entry in the harness `package.json`**:

- Apex **Ring 6 Confined MCP Hub** already speaks stdio MCP (`McpClient` + `StdioTransport`), spawns third-party servers with `inheritEnv: false`, runs a prompt-injection/tool-poisoning scan over server instructions and tool descriptions (`SkillVerdict`, `safeTools`/`poisonedTools`), and exposes everything behind the **deferred `mcp_hub` tool**.
- Because it is deferred, all **116 `onto_*` tools add +0 active schema tokens** — an important property given the exact-token-count brittleness found in the earlier review. Agents discover them on demand via `codemode` instead of paying prefix cost.
- The shipped `SKILL.md` is well-formed agent metadata (it self-declares the required MCP server, binaries, and outbound network direction), which routes naturally through Ring 3's `skills-guard-v10` quarantine.

So it extends Apex's *capability catalog* without touching the confinement spine or the boot-pinned prefix.

## 3. Target integration design (fits existing primitives)

**Install (out-of-band, never build at runtime):**
- Fetch the pinned platform binary (e.g. `open-ontologies-x86_64-unknown-linux-gnu`, ~81 MB) from Releases, verify against `SHASUMS.txt`, place in a trusted bin path **outside the workspace** (same pattern as the `.pi/agent/bin` native tools). Do **not** use `cargo install --git` inside a session (build weight + egress). Optionally consume the GHCR OCI image if the deployment already runs containers.

**Register as an operator-sourced stdio server in Ring 6** (`ConnectStdioMcpParams`):

```jsonc
// operator-trusted MCP profile (not workspace-config, which fails closed on untrusted repos)
{
  "name": "open-ontologies",
  "command": "/home/user/.local/bin/open-ontologies",
  "args": ["serve"],
  "source": "operator"            // Ring 6 runs inheritEnv:false + tool-poisoning scan
}
```

**Confinement & egress:**
- Launch under the Ring 0 `bwrap` profile with `--unshare-net` by default. Their default build makes **no** outbound calls, so local validate/query/diff/proof work fully offline; `onto_pull`/`onto_push` then fail closed unless the operator explicitly allow-lists a destination — matching the tool's own "user-provided URL only" design.
- Apply the existing memory/timeout limits and the 128 MB SIGKILL ceiling to the reasoner (their `SECURITY.md` explicitly treats crafted Turtle/RDF-XML/SHACL as attacker-controlled and parser DoS as in-scope).

**Skill & content trust:**
- Onboard `SKILL.md` through Ring 3 quarantine; present ontology text and MCP results as **untrusted reference content**, consistent with `skill_access`.
- **Use stdio only.** Their `SECURITY.md` warns `serve-http` on `0.0.0.0` without a token grants full read/write; stdio under Ring 6 has no listening socket at all.
- Leave the **WASM `plugins` feature off** unless individually vetted — the project itself states fuel metering "bounds runtime, it does not sandbox intent."

**Effort:** low-to-moderate for a local, read-only ontology profile (install/verify script + Ring 6 profile + quarantined skill). Egress-enabling `pull/push`, the HTTP transport, plugins, or the Lean/prover certificate pipeline are separate, larger phases.

## 4. Risks and caveats

1. **Domain-specific.** It pays off only on ontology / knowledge-graph / semantic-data / data-governance tasks. It should ship as an **optional MCP profile**, never a default dependency — for ordinary code work it is dead weight.
2. **Native binary supply chain.** A Rust binary can't be meaningfully scanned by the JS-oriented `skills-guard-v10`. Trust must come from MIT + pinned SHA-256 + bwrap confinement + clean env + Ring 6's tool-description scan. This is a weaker static-assurance path than an in-process TS module.
3. **Single-maintainer / commercial sponsor.** High individual bus factor; the hosted platform is the business. MIT licensing and a pinned binary mitigate lock-in, but track abandonment and pin versions deliberately.
4. **Footprint & toolchain.** ~80 MB native binary per platform; the formal-proof re-check story additionally needs Lean4 (and friends) for full certificate verification, though the core reasoner/SHACL/SPARQL is all in the one binary and a proof is independently re-checkable offline.
5. **Their own version/doc drift.** `SKILL.md` says 110 tools while `.mcp/server.json` says 116; versions diverge across `SKILL.md` (0.5.1), `Cargo.toml` (2.1.0) and `server.json` (0.1.9). Expect to pin and validate against the actual binary, not the docs.
6. **Don't vendor the source** (232 MB repo, 23 GB benchmark data) — consume releases only.
7. **Optional embedding/vector features** (`tract-onnx`, `instant-distance`) are feature-gated off in the default build; keep them off to avoid overlapping/confusing the retrieval story and widening the attack surface.

## 5. Verdict

**Additive: yes — and unusually cleanly.** It introduces a capability Apex entirely lacks (formal ontology reasoning with auditable proofs) while integrating through the exact extension seam Apex already hardened for untrusted third-party tools (Ring 6 confined stdio MCP, deferred `mcp_hub` for +0 schema tokens, Ring 3 skill quarantine, Ring 0 egress/resource confinement). The project's local-default, credential-free, fail-closed security model is well aligned with Apex, and MIT removes licensing friction.

It is **not** a candidate for the core/default install: it is a specialized, opt-in MCP profile whose adoption should be gated on (a) checksum-pinned binary installation outside the workspace, (b) stdio-only with network namespaced off unless explicitly opened, (c) the HTTP and WASM-plugin surfaces disabled by default, and (d) a Ring 3-quarantined skill. Under those conditions it is a low-risk, high-value addition *for semantic-data workstreams*, and it composes with — rather than competes with — Ring 13 extraction, the spec-graph spike, and the rest of the rings.

### Suggested next step
A short proof-of-concept mirroring the spec-graph spike: pin the Linux release binary by `SHASUMS.txt`, register it in a Ring 6 operator stdio profile on a sample `.ttl`, and assert (i) the 116 tools stay deferred with zero active-schema-token change, (ii) `onto_validate`/SPARQL work with `--unshare-net`, and (iii) `onto_pull` is blocked until an egress allow-list entry is added.

---

## Appendix E — alibaba/open-code-review (OCR)


**Date:** 2026-10-28 · **Question:** Does it fit the Apex *build*, and is it additive?
**Method:** Inspected the live repo via GitHub API (manifest, `cmd/`, `internal/`, npm launcher, rules, assurance case, docs). No clone (56 MB, ~1,125 blobs).

## 1. Snapshot

| Attribute | Finding |
|---|---|
| What it is | Alibaba's internal AI code-review assistant (2 yrs, tens of thousands of developers), open-sourced. Reads git diffs and emits precise line-level review comments via an LLM agent with tool-use |
| License | **Apache-2.0** (NOTICE required); OpenSSF **Gold** badge; ships a written `ASSURANCE_CASE.md` with an explicit threat model |
| Language / runtime | **Go 1.26.9**, single CLI binary `ocr` (Bubble Tea TUI); separate `acp/` Go module (Agent Client Protocol, stdio) |
| Distribution | npm package **`@alibaba-group/open-code-review`** — a thin Node launcher + per-OS **optionalDependencies** (`@alibaba-group/ocr-{os}-{arch}`), HTTPS-only fetch with redirect cap + **sha256 verification**; GitHub Action; raw release binaries |
| Commands | `review`, `scan` (whole-file audit), `delegate`, `session`, `rules`, `config`, `auth`, `llm`, `viewer`, `completion`; outputs text/JSON/**SARIF**; `--preview` lists files offline |
| LLM | **Required** for any finding — Anthropic, OpenAI Chat/Responses, AWS Bedrock, ChatGPT auth, or any OpenAI-compatible gateway |
| Telemetry | OpenTelemetry, **disabled by default** (`OCR_ENABLE_TELEMETRY=1` to opt in) — compatible with default-deny egress |
| MCP | OCR is an **MCP *client*** (consumes external MCP tools to enrich review). There is **no MCP server** command; the only stdio server is the separate ACP adapter, which pi does not natively speak |
| Maturity | ~48.8k★, 3.6k forks, 359 open issues, active (pushed 2026-10-22); very large Go test suite; benchmark "AACR-Bench" (50 repos, 200 PRs, 10 languages, 1,505 engineer-annotated issues) |

## 2. Two corrections to the headline description

1. **It is not an offline static analyzer.** The "built-in multi-language ruleset (NPE, thread-safety, XSS, SQLi)" is `internal/config/rules/system_rules.json`: a deterministic **glob → `rule_docs/<lang>.md` map** (50+ languages). The engineering guarantees are *process* constraints — exact file selection, smart file bundling into isolated sub-agents, deterministic rule matching to focus attention, and separate comment-positioning/reflection modules. The **verdict itself is always the LLM**. Only `ocr rules` (which rule matches a path) and `--preview` (which files would be reviewed) run without a model.
2. **It is not an MCP server.** The realistic integration surface is the **CLI + its agent `SKILL.md`** (which already drives `ocr review …` through a shell), not the Ring 6 MCP hub.

## 3. Build-fit for Apex (the core question)

OCR does **not** enter the TypeScript compile/typecheck/lint/test graph and needs no Go toolchain in the Apex build — it is consumed as an external, checksummed native binary, the same category as the harness's existing `fd`/`rg` native tools (and the open-ontologies pattern), but with a more polished delivery story.

Recommended packaging:

- Add **`@alibaba-group/open-code-review` as an `optionalDependency`**, not a hard one, so an unsupported platform or an air-gapped `npm install` never breaks the harness build. The platform binary then arrives through `registry.npmjs.org` — already an allow-listed egress domain in `GUARDRAILS.yaml` — and the launcher verifies sha256; the GitHub-release fallback uses `github.com`, also allow-listed. Never vendor the Go source.
- Invoke the resolved `ocr` binary from a Ring 2/7 adapter **under Ring 0 `bwrap`**: `--unshare-net` by default, opening egress only to the configured LLM host; run with a clean env and inject the provider token from the **Ring 10 vault** (`OCR_LLM_URL`/`OCR_LLM_TOKEN`), never from the inherited environment.
- Consume machine-readable output only (`--format json` / SARIF via `--output`) so findings map deterministically onto Apex review objects, the Ring 14 audit trail, and the existing PR gate — never parse the TUI.
- Onboard the Apache-2.0 `SKILL.md` through **Ring 3 quarantine** (`skills-guard-v10`) like any other skill; its shell invocations still pass the shell AST gate and bwrap.
- Treat it as a **PR/CI-gate only** tool (reviews run sub-agents, concurrency 8, multi-minute timeouts), never a per-turn call; apply the existing timeout/128 MB kill discipline.

This is a cleaner supply-chain story than a manual binary drop: optional platform packages, checksum, signal-correct launcher (it maps signal deaths to `128+signo` rather than exiting 0), HTTPS-only, telemetry off.

## 4. Is it additive? — *Yes, but as a mature upgrade in an occupied category, not a new capability*

Apex already has code review (Ring 2 BugBot `REVIEW_RULES.md` + Codex `ReviewOutputEvent` with `mergeBase...HEAD`, and the Ring 7 autonomous PR pipeline with a P0 gate and CI autofix). So unlike open-ontologies (empty category), OCR overlaps an existing ring. Its genuine deltas:

| Gap in Apex today | OCR adds |
|---|---|
| LLM-driven review with markdown rules; quality sensitive to prompt drift | Deterministic **review orchestration**: exact file selection, related-file bundling into isolated concurrent sub-agents, template rule matching, independent **positioning** and **reflection** modules that specifically kill "cut corners / line drift / unstable quality" |
| One generic rule surface | **50+ language rule libraries** (`rule_docs/*.md`) with glob-accurate selection, incl. `ts_js_tsx_jsx.md`, Java, Go, Rust, Solidity, Terraform… |
| Comments only | **SARIF** + JSON output, whole-file `scan` (no-diff audits), resume/session, `--preview` dry-run |
| No external benchmark | AACR-Bench: higher Precision/F1 than generic Claude Code at **~1/9 the tokens**, deliberately precision-biased (lower recall, fewer false alarms) |
| Single-shot posting | Incremental, non-destructive PR comments with sticky summary (the GitHub Action) |
| Ring 1 LSP diagnostics (per-file, semantic) | Repo-level, cross-file, rule-guided review that complements rather than replaces LSP |

### A zero-binary additive path
The `rule_docs/*.md` content and the `system_rules.json` glob→rule map are plain Apache-2.0 markdown/JSON. Apex could adopt the **per-language rule-selection idea** directly into Ring 2's `REVIEW_RULES` (deterministically attach the matching rule doc to the review prompt per changed file) with no Go, no new credentials, and no extra process — a small, in-architecture improvement even if the binary is never adopted.

## 5. Risks and constraints

1. **LLM dependency = egress, credentials, spend.** Unlike the offline tools, every review calls a model. Needs an explicit egress allow-list entry for the provider host and a vault-managed token; double model configuration unless pointed at Apex's own OpenAI-compatible router. Cost is claimed low (~1/9 tokens) but non-zero.
2. **Two-reviewer conflict.** Running OCR alongside BugBot/Codex risks duplicate/contradictory comments and gate confusion. Pick a division: e.g. OCR as the **precision diff gate**, keep BugBot for the bounded **autofix** loop, and de-duplicate findings before posting.
3. **Native binary outside static scanning.** A Go binary can't be meaningfully inspected by the JS-oriented `skills-guard`; trust rests on Apache-2.0 + checksum + OpenSSF Gold + bwrap confinement + clean env (same model as open-ontologies, slightly stronger provenance).
4. **Git ≥ 2.41 and diff-based operation** — fine for Ring 2 worktrees/Ring 7 branches, but a host prerequisite to verify; adversarial diffs are explicitly in its threat model (LLM responses validated before use).
5. **Weight and pace.** Heavyweight vs. the fast ring tests; cannot be part of Tier-A/B. Resource behavior under bwrap (process groups, the optional local web viewer's DNS-rebinding surface) needs a validation pass; keep the viewer disabled.
6. **359 open issues and rapid iteration** — pin a version and treat updates deliberately, as with any external engine.

## 6. Verdict

**Build-compatible: yes, cleanly — via the checksummed npm optional-dependency binary driven under bwrap, with no Go in the Apex build and telemetry off by default. Additive: moderately — it strengthens an existing ring rather than opening a new one.**

It is a high-quality, scale-proven, supply-chain-conscious review engine whose orchestration discipline, language coverage, SARIF output and measured precision/token efficiency are real improvements over Apex's current LLM-only review. But it is LLM-required, overlaps Ring 2/7, and brings a native process + provider egress, so it should land as an **optional, operator-enabled Ring 7 review profile** (not a default/core dependency), with an explicit split of responsibilities versus BugBot.

### Ranking against the earlier candidates
- Below **spec-graph** (the only source-level, directly runnable TS core) on integration depth.
- Comparable to **open-ontologies** in sidecar mechanics, but OCR needs live LLM egress/credentials while open-ontologies runs offline; OCR has the more polished npm delivery but sits in an already-occupied category (lower novelty).
- Above **autoharness** (whose executable surface is Claude-coupled and non-portable).

### Suggested next step
Two-track, cheapest first:
1. **No-binary spike:** port the `system_rules.json` glob→`rule_docs` selection into a Ring 2 deterministic rule-attachment step with a ring test (pure TS, uses Apex's existing model).
2. **Binary spike (optional profile):** pin the Linux npm package by checksum, wire `ocr review --format json` into a Ring 7 PR-gate action under `--unshare-net` with vault-injected provider env, and assert deferred registration (+0 active schema tokens), SARIF/JSON parsing, and egress blocked until the provider host is explicitly allow-listed.

---

## Appendix F — milind-soni/OpenMausBot


**Date:** 2026-10-28 · **Question:** Is it an additive integration for Apex?
**Canonical repo:** `milind-soni/OpenMausBot` (the ~6k★ original). The search returns ~80 similarly named repos/forks, many unlicensed or low-quality — only the canonical Apache-2.0 project is considered here.
**Method:** GitHub API inspection (manifest, workspaces, `server/`, `shared/`, `electron/`, `skills/`, security docs, npm registry). No clone (~312 MB).

## 1. Snapshot

| Attribute | Finding |
|---|---|
| What it is | Open-source "Grok Bot alternative": a **messaging-app-style roster of AI agents** as an Electron/React 19 desktop app + a local harness server on `127.0.0.1` |
| Engines | Drives real external CLIs — `claude`, `codex`, `grok`, ACP agents (Kimi/Hermes), and **`pi`** (it ships `server/drivers/pi-mcp-extension.ts`) — using existing logins; no model proxy |
| Per-agent "computer" | Cloud Linux desktop (**boat.dev**, paid third party), isolated **Local VM (Docker)** with noVNC takeover, or opt-in host control (macOS/Ubuntu Xorg) |
| License | **Apache-2.0** for OSS, with an open-core carve-out: `enterprise/` is source-available under a separate license (production needs a key) and must be excluded from any reuse |
| Packaging | Repo root is `private: true`, no `main`/library. npm `openmausbot@0.1.130` is a **standalone server/CLI** (`bin: openmausbot`, **Node ≥24**, native deps `@duckdb/node-api`, `@resvg/resvg-js`, `@1password/sdk`) — a runnable product, not an importable module |
| Stack | pnpm monorepo: Electron + React 19 + ag-grid + mermaid + DuckDB + PostHog; large `server/` (admission, MCP broker/gate/oauth/proxy, drivers) and `electron/` IPC layer |
| Maturity | ~6.0k★, 993 forks, **497 open issues**, single maintainer (security contact is a Gmail address), created 2026-08 (~2.5 months), pushed daily |

## 2. Build-fit for Apex — **not an embeddable component**

- **No library surface.** The repo is a private application and the npm artifact is a server you run and pair devices to, with no `main` and a Node **≥24** requirement (Apex targets ≥22.19 and is validated on 22.x). There is no `npm i` path that yields callable modules for the harness.
- **Stack mismatch.** Electron/React desktop + heavy UI/native dependencies vs Apex's headless pi harness with a lightweight web cockpit. Pulling it in would drag in Electron, ag-grid, mermaid, DuckDB, PostHog and a ~300 MB footprint.
- Realistic options are therefore limited to: **(a)** run it as a separate product (coexistence, not integration), or **(b)** cherry-pick Apache-2.0 TypeScript *patterns/functions* into Apex (never from `enterprise/`), or **(c)** re-implement a design in Apex's own style. There is no clean version-pinned dependency path, so any borrowed code is a maintenance fork.

## 3. Additive? — **Mostly overlapping; a few specific, valuable deltas**

Much of OpenMausBot is a productized, UX-first expression of capabilities Apex already has as rings:

| OpenMausBot feature | Apex equivalent today |
|---|---|
| Multi-agent roster, agent-to-agent threads | Ring 9 orchestrator (`dag/supervisor/debate/map_reduce`) + blackboard, Ring 2 subagent pool |
| Chat cockpit / approval cards | Ring 5 Mission Control (HTTP/SSE, plan & steer) |
| Browser / computer use | Ring 7 Chromium CDP, Ring 3 approval-gated CUA, Ring 2 agent-browser |
| Permission/approval modes | Ring 0 approval policy + Plan/Trust artifacts |
| MCP client hub | Ring 6 confined MCP hub |
| Skills | Ring 3 skill library + `skills-guard-v10` |
| Provider keys / OAuth | Ring 10 vault (0600, masked), Ring 12 provider manager |
| Messaging channels | Ring 9 omni-channel gateway |

The genuinely additive parts are concentrated in **security plumbing and isolation design**, not features:

1. **Capability-token consent broker (strongest borrow).** Per-launch and narrow **per-turn capabilities**, explicit permission cards, read-only tool annotations (`agent-tool-policy.ts`), and "Full access" treated as a standing, clearly-scoped grant — with a documented rule that it must never silently broaden credential/routine/skill confirmations. Apex's approval model is coarser; this is a concrete target design, largely pure TypeScript (`shared/approval-mode.ts`, `server/admission.ts`, `call-consent.ts`, `harness-mcp-token.ts`).
2. **Deeper MCP hardening than Ring 6.** A large, well-tested MCP surface: strict handshake, schema validation, **result budgets**, output trimming, OAuth store/discovery, remote HTTP proxy, directory/catalog, per-call timeouts, gate config, and read-only/`openWorldHint` annotations. Most directly useful: it already includes a **pi MCP extension** (`pi-mcp-extension.ts`, typebox, `-e` loaded, mounts MCP servers as pi tools with scope gating and an `ask_user` tool) — a near-direct reference for Apex's own pi+MCP ring.
3. **Per-agent Local VM (Docker) with visual noVNC takeover.** A fuller desktop-isolation/computer-use model than bwrap process confinement. Conceptually additive for "give an agent a whole machine," but heavy; the cloud variant depends on boat.dev (paid, outbound) and should be avoided under Apex's local-first/default-deny model.
4. **Multi-engine driver + permission mapping.** A pure `supportsApprovalMode(driver, mode)` matrix across claude/codex/grok/ACP/pi and a provider-switch guard — useful input for Ring 12 routing.

The bundled `skills/` (three skills) and the chat UI itself offer little Apex doesn't already have.

## 4. Security and posture conflicts

- **Weaker default isolation than Apex.** OpenMausBot runs real CLIs **with the user's privileges**, gated by a consent broker; the strong isolation is an opt-in separate VM. Apex's default is kernel `bwrap`/`openat2` fail-closed confinement. Borrowing patterns must not regress Ring 0 — the broker is a *complement* to confinement, not a substitute.
- **Telemetry and cloud egress.** PostHog product analytics (anonymous, toggleable) and boat.dev cloud computers (paid, data leaves the machine) conflict with default-deny egress; both would be off/absent in an Apex port.
- **Not airtight.** `SECURITY.md` openly documents an unresolved route where a bot's shell can reach Full-access threads; useful honesty, but a reason to treat the broker as a reference rather than trusted code.
- **Open-core boundary.** Anything under `enterprise/` is not Apache-licensed; exclude it.
- **Supply-chain noise.** Single maintainer, very young project, 497 open issues, and dozens of no-license fork-clones. Only the canonical repo should be referenced, with pinned commits and NOTICE attribution.
- **Runtime gap.** Node ≥24 vs Apex's 22.x line; borrowed modules must be back-ported and re-tested, not installed.

## 5. Verdict

**Not additive as a component or sidecar; additive as a design reference.** OpenMausBot occupies the same problem space Apex already covers across Rings 2/3/5/6/7/9/10/12, wrapped as a standalone Electron product that cannot be imported and whose default (user-privilege CLI + consent broker) is less confined than Apex's kernel sandbox. It is a better citizen than the similar `nightly-labs/openbot` (Apache-2.0 vs PolyForm Noncommercial, and a far more mature, tested, documented permission/MCP model), but it still belongs in the "reference, do not integrate" bucket.

Where it can materially improve Apex, in priority order:
1. **Ring 6 MCP hardening** — port the result-budget, strict-handshake, schema-validation, timeout and OAuth patterns, guided by the existing **pi MCP extension** (highest relevance, same engine).
2. **Ring 0/2 permission redesign** — adopt the capability-token/per-turn consent model and read-only tool annotations as a layer inside the existing confinement, never replacing it.
3. **Optional Docker-VM computer-use** — evaluate a per-agent Local VM with noVNC only if a product need emerges; keep it local, never the boat.dev cloud path.

### Ranking against earlier candidates
Below **spec-graph** (a runnable, pi-compatible TS core) and **open-ontologies** (a clean, offline, confined MCP sidecar) on component fit; comparable in category to **OpenBot** but with stronger, license-clean reference material; clearly ahead of OpenBot for actual code-pattern reuse. Treat any takeaway as a pinned-commit, Apache-2.0-attributed, re-tested port into the relevant ring — not a dependency.

### Suggested next step
A focused Ring 6 hardening note: diff OpenMausBot's `server/mcp-*` (budget, gate, schema, timeout, oauth) and `pi-mcp-extension.ts` against Apex's `mcp-confined-hub.ts`, and produce a backlog of pure-TS, pi-compatible improvements with ring tests — no Electron, no PostHog, no cloud, no `enterprise/` code.

---

## Appendix G — spec-graph spike evidence (ThinkRail → Apex Ring 3)

### G.1 Spike README


**Date:** 2026-10-28 · **Status:** Spike — proven portable, not yet wired into the product
**Upstream:** JetBrains/thinkrail `packages/spec-graph` @ `9066aa9` (Apache-2.0), see [NOTICE.md](NOTICE.md)

## 1. Verdict

**Feasible and low-risk to adopt the core; medium effort for the full tool surface.**
ThinkRail's spec-graph is split into a **pi-free `core/` (960 LOC, only `yaml` + Node built-ins)**
and a thin pi-coupled `tools/` layer. The core was vendored **unmodified** into `./core` and runs
green on Apex's actual runtime (Node 22 `--experimental-strip-types`, no Bun):

```bash
node --experimental-strip-types --test spikes/spec-graph/spec-graph.spike.test.ts
# 7 tests, 0 failures (~0.2s)
```

It fills a genuine Ring 3 gap: today's self-evolution knowledge is **flat, token-capped markdown**
(`EXPERIENCE.md` ≤220 tokens, `MEMORY.md` ≤300). Spec-graph adds a **multi-file, linked, queryable,
validated living-spec model** (parent tree + `depends-on`/`references`/`implements` DAG) that lives
on disk and is read on demand — outside the boot-pinned prefix.

## 2. What the proof establishes

| # | Property proven | Evidence in `spec-graph.spike.test.ts` |
|---|---|---|
| 0 | **Portability** — no `Bun`/`bun:` import; runs under Node strip-types | static scan of every vendored file |
| 1 | **Graph model** — parent tree + three typed edge kinds + forward/reverse adjacency, `pathForId` | sample 4-node DAG |
| 2 | **Query** — bounded `graphSlice` (subtree/ancestors/neighbors) and metadata-filtered `grepSpecs` | slice + grep assertions |
| 3 | **Validation** — dangling links, duplicate ids, and parent cycles are distinct, detected findings | temp fixtures incl. a `b↔c` cycle |
| 4 | **Containment** — `resolveSpecPath` refuses `../`, absolute, non-`.md`, and symlink paths | traversal/symlink probes |
| 5 | **Prefix safety** — index is derived/in-memory/read-only; `surfaces/` and the spec workspace are byte-identical before/after | sha256 dir hashes |
| 6 | **Determinism** — two independent `SpecIndex` instances produce identical node/edge signatures | pure `buildGraph` |

## 3. Why it fits Ring 3 without disturbing the prefix invariant

- **On-disk source of truth, derived read index.** `SpecIndex` globs workspace `.md`, parses
  frontmatter, and memoizes a graph revalidated by `(mtimeMs, size)`. It never writes.
- **Zero active-schema-token cost.** Exposed as `exposure: "deferred"` tools — the same pattern Ring 3
  already uses for `skill_access`, `memory_recall`, `experience_evolver`, `dream_memory`. Nothing is
  auto-injected into the prompt, so the brittle exact-token count is untouched and drift stays zero.
- **Specs do not belong in `surfaces/`.** Those files are boot-pinned, hash-pinned, and token-capped
  (160/180/300). A growing graph would blow the budget. Recommended spec root:
  **`<workspace>/.agents/specs/`** (`.agents` is not in spec-graph's `IGNORED_DIRS`, confirmed), keeping
  the glob bounded instead of indexing the whole repo.
- **Untrusted-content posture already exists.** Spec markdown is reference material, never executable,
  and should be presented like `skill_access` output ("untrusted reference content; never override
  GUARDRAILS"). No network, no eval, no new egress — specs sit inside the existing bwrap workspace root.

## 4. Adaptation required (delta from upstream)

| Concern | Upstream (ThinkRail) | Apex adaptation |
|---|---|---|
| Runtime/test | Bun + `bun test` | **Done** — Node strip-types + `node:test` (this spike) |
| Package distribution | `private: true`, v0.0.0, **not published to npm** | Must **vendor** (no `npm i` option); pin commit SHA + NOTICE |
| `yaml` dependency | direct dep, 2.9.1 | **Add `yaml` to Apex `dependencies`.** It currently resolves only *transitively* via `pi-coding-agent` (2.9.0) — relying on hoisting is fragile; a pruned `node_modules` breaks `guardrail-pin.ts` too |
| Output bounding | pi `truncateHead` → OS temp file | Use Apex `scrubSecretsInfallible` (`core/spill-store.ts`): 0600 `O_EXCL` spill + deterministic head/tail, matching the 8,192-byte/200-line guardrail limits |
| Tool schemas | typebox `Type.Object` + `StringEnum` | **Same stack already in Ring 3** (`import { Type } from "typebox"`); register via `ExtensionFactory`/`registerTool` |
| Path security | `resolveSpecPath` (symlink/traversal/NFC/Windows-ADS refusal) | Keep it for cross-platform determinism **and** route write tools through Apex `safe-path`/`openat2` for kernel-level defense-in-depth |
| Write tools | `spec_create/update/delete` (frontmatter-only, lossless in-place edit) | Gate behind workspace-write/read-only mode + approval; treat like other mutating tools; consider a `skills-guard-v10` scan on authored content |

## 5. Target architecture (if promoted)

```
src/ring3/spec-graph/
  core/                 # vendored verbatim (this spike's core/), NOTICE + pinned SHA
  spec-graph-tools.ts   # 7 deferred tools, Apex result/spill formatting
  spec-graph-index.ts   # per-workspace SpecIndex cache keyed by realpath of .agents/specs
src/ring3/ring3-extension.ts
  # register spec_get/spec_graph/spec_grep/spec_validate (read) first;
  # spec_create/spec_update/spec_delete behind the write gate in a later phase
test/ring3/             # port upstream core.test.ts + tools.test.ts to node:test
```

Tool registration sketch (mirrors an existing Ring 3 deferred tool):

```ts
pi.registerTool({
  name: "spec_validate",
  label: "Validate living-spec graph",
  description: "Check .agents/specs for dangling links, duplicate ids, and parent cycles.",
  parameters: Type.Object({}),
  exposure: "deferred",                 // +0 active schema tokens, zero prefix drift
  async execute() {
    const report = validateGraph(getSpecIndex(workspaceRoot).graph());
    const text = JSON.stringify({ valid: isValid(report), ...report });
    return { content: [{ type: "text", text: scrubSecretsInfallible(text).text }], details: report };
  },
});
```

The seven upstream tools map 1:1: `spec_grep`, `spec_get`, `spec_graph` (read),
`spec_validate` (read), `spec_create`, `spec_update`, `spec_delete` (write; frontmatter-only, prose is
edited with normal write/edit tools).

## 6. Phased plan & effort

- **Phase 0 — spike (done):** vendored core + 7 node:test proofs; typecheck unaffected (`spikes/` is
  outside the `tsconfig` include, so no schema-token or build regression).
- **Phase 1 — read-only, ~2–3 days:** add direct `yaml` dep; move `core/` to `src/ring3/spec-graph/core`;
  port upstream unit tests; ship the four **read** deferred tools + `.agents/specs` root. No mutation
  surface, minimal security review.
- **Phase 2 — authoring, ~2–3 days:** the three write tools behind read-only/workspace-write gates and
  `safe-path` containment; Mission Control read-only viewer; bundle the upstream `SKILL.md` guidance
  (localized) so agents treat specs as ground truth and update them in the same change as the code.
- **Phase 3 — workflow, ~2 days:** link validation into Plan/Trust Artifacts and the Harness² evolver;
  optional Ring 15 "frontier parity" framing.

## 7. Risks & non-goals

- **Not semantic/vector RAG.** It is structural + keyword retrieval (graph traversal, content grep),
  complementing Ring 1's AST/PageRank/BM25 for *code*; it targets prose decisions/contracts. Do not
  conflate with the IBM STAIR direction (which needs per-corpus fine-tuning).
- **Vendoring drift.** 960 LOC to maintain; mitigate with the pinned SHA + verbatim policy in NOTICE and
  mechanical re-syncs. The pi-free boundary makes this cheap.
- **Trust.** Authoring tools create workspace content; reuse the existing quarantine/scan and approval
  machinery rather than inventing a new trust path.
- **Scope discipline.** Keep specs lean (the upstream `SKILL.md` enforces intent-over-inventory,
  say-each-thing-once) to avoid recreating an unstructured wiki.

## 8. Reproduction

```bash
cd pi-apex-harness
npm install                       # ensures transitive yaml is present
node --experimental-strip-types --test spikes/spec-graph/spec-graph.spike.test.ts
```

Sample graph: [`samples/specs/`](samples/specs) — four specs exercising `parent`, `depends-on`,
`references`, `implements`, `tags`, and nested directories.

### G.2 Third-party attribution (NOTICE)

# Third-party attribution — spec-graph core

The files under `./core/` are **verbatim, unmodified copies** of the pi-free
`packages/spec-graph/core/` directory from the ThinkRail project.

- Upstream: https://github.com/JetBrains/thinkrail
- Path upstream: `packages/spec-graph/core/{parse,graph,query,validate,store,index}.ts`
- Vendored from commit: `9066aa9f4bb5c0dcb681235b4b936e8be73651f7` (branch `main`)
- License: Apache License 2.0 (ThinkRail repository `LICENSE`)
- Sole runtime dependency: `yaml` (ThinkRail pins 2.9.1; Apex currently resolves 2.9.0 transitively)

No `@earendil-works/*`, `@thinkrail/*`, or Bun-only API is imported by `core/` —
this is the property that makes the module portable to Apex's Node
`--experimental-strip-types` runtime, as demonstrated by `spec-graph.spike.test.ts`.

If this spike graduates into `src/`, retain this notice, keep the upstream commit
SHA pinned, and re-sync deliberately rather than editing the vendored files in
place (so future upstream merges stay mechanical).


---

*End of package. Individual source documents remain available separately in the repository; this file is the authoritative single-file bundle as of 2026-10-28.*
