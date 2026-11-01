# Apex Additive Integration Package

- **Fresh consolidated review:** 2026-11-01
- **Current Apex source reviewed:** [`89fc070f02af3a3a6e5c8a200d182f6dc58ac333`](https://github.com/knarayanareddy/apex/commit/89fc070f02af3a3a6e5c8a200d182f6dc58ac333) (`origin/main`)
- **Earlier comparison baseline:** `1ef6dd14ae259479206de7504e1669b66b97dd84`
- **Scope:** all 19 additive-integration candidates reviewed in the three review waves: the October 28 technology assessments (including SoL-Pi and LangExtract), the October 30 Pi-ecosystem assessments, and the DSH Superagent assessment.

This is a decision and integration document, not evidence that any external runtime has been merged or qualified as part of Apex. “Integrate” below always means through the stated narrow seam and acceptance gates; it never means installing the upstream product wholesale.

## 1. Executive decision

Apex should continue to prefer **narrow adaptations over new runtimes**. The strongest additions are:

1. **Versioned work Mandates and deterministic admission policy** from DSH, joining Ring 8/9 intake to Ring 7 execution without bypassing Ring 11 approvals.
2. **A durable outbound outbox** for Ring 9, redesigned around Apex’s WAL and explicit `OUTCOME_UNKNOWN` semantics.
3. **A reproduced, read-only spec-graph pilot** for Ring 3. The earlier package reported a green spike, but its files are absent from current `main`; it must be reconstructed and rerun before promotion.
4. **A SoL-Pi compatibility spike**, leading only to ObservationPack if Pi 1.4, schema, state-ownership, and recovery checks pass. Action Fusion remains blocked until it uses Apex’s confined/guarded/WAL tool path.
5. **Low-cost content/policy additions:** OCR’s deterministic per-language rule selection, selected pi-pstack skills, autoharness’s usage/probation/capacity lifecycle, and LangExtract’s grounded-extraction data contract.
6. **Optional, off-by-default capabilities:** open-ontologies through confined stdio MCP and cached compaction behind a provider-specific Apex adapter.

Full upstream applications—DSH, Pi-Remote, pi-phone, OpenMausBot, autoharness, OpenBot, and the complete pi-pstack extension—are not additive runtimes for Apex. They either duplicate existing authorities, introduce another security model, or belong as separate products.

### Evidence labels used in this package

- **Current source** — checked against Apex `89fc070` or the external commit named in the section.
- **Historical report** — a result from an earlier review whose artifact is not present in current Apex `main`.
- **Upstream test** — a test of the external project, not an Apex integration test.
- **Design only** — source/architecture assessment without a live Apex pilot.
- **Not qualified** — the necessary Apex, platform, security, or live-service evidence does not exist.

Promotional posts were lead sources only. Performance, cost, security, and productivity claims are not treated as independent evidence.

---

## 2. Current Apex review

### 2.1 What changed since the earlier baseline

Current `main` advanced from `1ef6dd1` to `89fc070`. The changes primarily harden isolation, recovery, Mission Control authentication, MCP spill handling, browser qualification, packaging, and CI. The principal integration seams used by the earlier recommendations remain present.

| Area | Current-source finding | Consequence for additive integrations |
|---|---|---|
| Ring 0 / Ring 2 execution | Process ownership, sandboxing, path handling, and unattended-execution code changed. | No external executor, shell shim, or consent broker may replace Apex’s boundary. External processes require a qualified execution boundary; an unverified host fallback is not acceptable. |
| Private control-plane state | `docs/adr/0001` and `docs/specs/2026-10-30-apex-isolation-blockers.md` remain explicit about unfinished private-state separation and migration requirements. | Mandates, outbox receipts, and sidecar state must use Apex’s verified state ownership path. Do not add a parallel database or silently create private state under a workspace. |
| WAL and recovery | Receipt validation and spill behavior changed; fail-closed `OUTCOME_UNKNOWN` handling remains. | External effects need durable intent, stable idempotency, recovery tests, and explicit ambiguity resolution. Blind at-least-once replay is insufficient. |
| Prefix and active tool schemas | Schema serialization was refactored, while per-request prefix verification remains. | New tools should remain deferred. No candidate may mutate the live pinned prefix or silently add active schema tokens. |
| Ring 5 Mission Control | Browser-session cookies, logout, SSE session ownership, and pairing-file protections were strengthened. | Remote UI ideas must compose with the current authenticated control plane rather than adding a parallel unauthenticated panel. |
| Ring 6 MCP | MCP result spills are now scoped using the trusted caller’s session identity. | The confined stdio MCP seam remains appropriate, but adapters must preserve session-scoped spill behavior and clean-environment execution. |
| Rings 1 and 13 | Compaction and document-ingestion source files are unchanged from the earlier baseline. | The review seams remain available, but Apex must retain one compaction policy owner; grounded extraction should extend rather than replace document parsing. |
| Rings 3, 7, 8, 9, 11 | Ring 3, `autonomous-pr-pipeline.ts`, `github-issue-bridge.ts`, `messaging-gateway.ts`, and Ring 11 are unchanged from the earlier baseline. | The proposed spec/skill, autonomous PR, GitHub intake, outbound delivery, and per-action approval seams remain source-compatible. |

### 2.2 Current verification position

- GitHub Actions run [`41338519955`](https://github.com/knarayanareddy/apex/actions/runs/41338519955), on `89fc070`, completed successfully on **Ubuntu 24.04 and Ubuntu 22.04**. The required steps include dependency installation, native build, typecheck, JavaScript inventory, security canaries, Linux confinement, Tier B integration, Ring 13 document sandboxing, and browser qualification.
- This is strong current CI evidence, not blanket live-feature certification. A single green browser run does not by itself close the documented intermittent-startup or isolation concerns.
- The workflow provisions Node `26.10.0`. Its green result is not direct qualification of Apex’s declared Node `>=22.19.0` floor.
- `pi-apex-harness/research/2026-11-01-live-feature-verification.md` is explicitly **partial** and tested `00c7566`, not the final `89fc070` merge. It reports controlled CLI/model read, memory, and Obsidian checks; MCP, ACP, plugins, and remaining features were still pending.
- This consolidation reviewed the current source and CI evidence. It did not rerun the complete Apex suite locally and does not claim physical power-loss, macOS containment, unrestricted-agent, or external-service qualification.

### 2.3 Correction to the previous package

The previous package said that six standalone `FEASIBILITY_*.md` documents and `pi-apex-harness/spikes/spec-graph/` remained in the repository. Those paths are absent from both current `main` and the earlier `1ef6dd1` baseline.

Accordingly:

- This file is now the self-contained consolidated review record.
- The spec-graph **7/7 historical spike report is retained as history**, not described as a currently reproducible in-repo proof.
- Two additional pre-existing worktree reviews, `FEASIBILITY_sol-pi.md` and `FEASIBILITY_langextract.md`, are incorporated as A12 and A13. They were not present in the old package, are not claimed to be on current `main`, and were left unchanged; this package does not depend on reading them.
- No recommendation below relies on a nonexistent local appendix or artifact.

---

## 3. Consolidated decision matrix

| # | Candidate | License position at reviewed source | Decision | Apex destination / boundary |
|---:|---|---|---|---|
| 1 | ThinkRail `spec-graph` | Apache-2.0 | **Reproduce, then read-only pilot** | Ring 3; deferred tools; `.agents/specs/`; no live-prefix mutation |
| 2 | ThinkRail `contracts` / delegation / DAG | Apache-2.0 | **Evaluate selectively** | Ring 5 typed wire first; Ring 2 delegation later; no IDE runtime |
| 3 | open-ontologies | MIT | **Optional sidecar, deployment-gated** | Ring 6 stdio MCP + Ring 3 skill; qualified confinement; network off |
| 4 | open-code-review (OCR) | Apache-2.0 | **Port rule selection; optional binary profile** | Ring 2/7 review; vault and explicit provider egress for binary |
| 5 | autoharness | MIT | **Know-how port only** | Ring 3 lifecycle and deterministic promotion policies |
| 6 | OpenMausBot | Apache-2.0 OSS; `enterprise/` excluded | **Security-design reference only** | Ring 6 MCP hardening; Ring 0/2 consent concepts |
| 7 | IBM STAIR | Paper CC BY 4.0; reference code unlicensed | **Reject code; optional retrieval idea** | Ring 13 heading-addressable FTS5/BM25; no training runtime |
| 8 | Huashu Design | MIT | **Quarantined skill candidate** | Ring 3; Python scanning and confined execution required first |
| 9 | Karpathy skills | No license | **Re-author; never copy** | Original Apex surface or canonical skill |
| 10 | Agent-Reach | MIT | **Gated external experiment only** | Separate CLI/profile; curated egress; prefer official APIs |
| 11 | OpenBot | PolyForm Noncommercial | **Reject code; UX reference only** | Ring 5 interaction ideas; no dependency |
| 12 | NVlabs SoL-Pi | MIT | **Compatibility spike; ObservationPack only if green** | Ring 0/session projection; Action Fusion blocked pending confined WAL path |
| 13 | Google LangExtract | Apache-2.0 | **Port data contract; optional sidecar later** | Ring 13 grounded extraction; Python/model runtime off by default |
| 14 | pi-cached-compaction | MIT declared in `package.json`; no standalone `LICENSE` at pin | **Off-by-default adapted pilot** | Apex session/compaction path; byte-prefix proof and fallback required |
| 15 | pi-ampersand | MIT | **Display-only opt-in observer only** | Ring 5 presentation; no model feedback, tools, or authority |
| 16 | Pi-Remote | MIT | **External companion only, conditional on qualification** | Keep separate from Apex; borrow reconnect/mobile/auth ideas |
| 17 | pi-phone | MIT plus recorded upstream licenses | **Separate platform/client** | Public-API coexistence; no wholesale vendoring |
| 18 | pi-pstack | MIT with upstream notices | **Selected content through quarantine** | Ring 3 skills; no full extension/auto-loop/authority import |
| 19 | DSH Superagent | MIT research prototype | **Adapt three narrow features; reject runtime** | Mandates, Ring 9 outbox, Ring 5 attention taxonomy |

---

## 4. Cross-cutting acceptance contract

Every proposed pilot must satisfy all applicable rules below before it can be called Apex-integrated.

1. **Preserve the execution boundary.** No permission-skipped agent, prompt-only sandbox, OS-user shell shim, or consent UI is a substitute for Ring 0/2 enforcement. Where process ownership or platform confinement is unqualified, execution remains refused or explicitly outside the Apex qualification claim.
2. **Keep authority deterministic.** Sender authentication, work authorization, path/tool scope, merges, and per-action approvals are host decisions. A model may classify inside those permissions but may never broaden them.
3. **Make effects durable and ambiguous outcomes explicit.** Persist intent before an external effect, use stable idempotency keys, and preserve `OUTCOME_UNKNOWN` after a crash when success cannot be proven. Do not blindly replay an external send or mutation.
4. **Use the owned private-state path.** New records belong in Apex-owned StateDb/state capabilities with migration, retention, scrubbing, and restart behavior. Do not create a second session store or assume `.harness` is already a verified private filesystem.
5. **Maintain prefix discipline.** Prefer deferred discovery and on-demand reads. Active schema-token changes require an explicit budget review. Prompt or tool defaults may change only at a new session or outside the pinned prefix.
6. **Treat all external content as untrusted.** Scan complete skill bundles through Ring 3 quarantine, including scripts and referenced assets. Issue comments, messages, MCP descriptions, observer text, and retrieved documents are data, never authority.
7. **Default-deny secrets and egress.** Credentials come from Ring 10 or an equivalent owned vault path, not inherited environment or logs. Third-party endpoints are off by default, explicitly allow-listed, and covered by data-leaving-machine disclosure.
8. **Pin provenance and honor licenses.** Record exact commits, checksums, copyright, and notices. No-license and noncommercial code is not vendored. A top-level license does not eliminate the need to audit bundled third-party material.
9. **Match the actual runtime.** Apex currently targets Node `>=22.19.0` and Pi `1.4.0`. Avoid wildcard peer assumptions, Bun/Electron/Android/runtime replacement, and duplicate agent loops.
10. **Qualify the actual integration.** Require unit and ring tests, negative authority tests, secret/egress tests, crash/restart cases, prefix/schema checks, and platform-specific evidence. Upstream green tests and promotional benchmarks are supporting evidence only.

---

## 5. Recommended sequence

### Wave 1 — narrow, high-value design and content work

1. Specify the **DSH-inspired Mandate** as an Apex-owned record and deterministic gate; begin proactive inference in `observe` mode.
2. Specify the **Ring 9 outbox** with pre-send scrubbed receipts and `OUTCOME_UNKNOWN` reconciliation; test it independently of autonomous execution.
3. Port **OCR’s glob-to-rule-document selection** without its binary or provider dependency.
4. Select **pi-pstack content** for Ring 3 quarantine and re-author the small Karpathy-style behavioral surface without copying unlicensed prose.
5. Extend the existing Mission Control attention projection with **delivery / answer / review / blocked / failed** autonomous-work states.
6. Reconstruct the **spec-graph spike**, rerun its tests on current Apex, and only then consider a read-only Ring 3 pilot.
7. Define LangExtract’s **grounded-extraction contract** in pure TypeScript, without its Python runtime.
8. Run the **SoL-Pi Pi 1.4 compatibility/schema spike**; only ObservationPack may advance if it passes, with Action Fusion still blocked.

### Wave 2 — optional pilots after their gates are met

- open-ontologies stdio MCP profile.
- LangExtract local sidecar, only if a document-extraction workstream justifies its Python/model weight.
- Provider-specific cached-compaction adapter, off by default.
- autoharness lifecycle policy and selected guard/redaction ideas.
- Huashu content after Python-aware scanning and confined runtime evidence.
- ThinkRail’s versioned wire, then delegation/DAG evaluation.
- STAIR-inspired heading retrieval without STAIR code or training.
- OpenMausBot-derived MCP result-budget, schema, timeout, and consent patterns.

### External or reference only

Pi-Remote, pi-phone, Ampersand, Agent-Reach, OpenBot, complete DSH, complete autoharness, complete OpenMausBot, and complete pi-pstack remain outside Apex’s runtime.

---

## 6. Review wave A — October 28 technology assessments

### A1. ThinkRail `spec-graph` — reproduce the evidence, then pilot read-only

**Source:** [`JetBrains/thinkrail`](https://github.com/JetBrains/thinkrail), `packages/spec-graph/core` at `9066aa9f4bb5c0dcb681235b4b936e8be73651f7`; Apache-2.0.

**Additive finding.** Apex’s living-spec and self-evolution material is primarily flat, token-capped Markdown. Spec-graph offers a multi-file, linked, validated, queryable model with parent relationships and `depends-on` / `references` / `implements` edges. Its pi-free core was assessed as the portable portion; the Bun/Electrobun/React product is not an integration target.

**Current evidence correction.** The earlier review reported that six core files, about 960 LOC, were vendored unchanged and passed **7/7 Node strip-types tests**. Current `main` contains neither `pi-apex-harness/spikes/spec-graph/` nor its test. Therefore the current status is **historical report / reproduction required**, not `SPIKE PROVEN`.

**Integration path.**

1. Re-vendor or re-implement the small core with its Apache notice and pinned upstream SHA.
2. Add `yaml` as a direct Apex dependency rather than relying on transitive hoisting.
3. Store specs under `.agents/specs/`; build only a derived, on-demand index.
4. Begin with deferred read tools: `spec_get`, `spec_graph`, `spec_grep`, and `spec_validate`.
5. Route any later write tools through Apex safe-path, approval, and content-scanning gates.
6. Reprove traversal/symlink refusal, graph validation, deterministic output, zero surface drift, and zero unexpected active-schema growth on current `main`.

**Decision:** strategically valuable, but **do not graduate it from the old document alone**.

### A2. ThinkRail contracts, delegation, and DAG — evaluate narrow protocols

**Source:** same ThinkRail repository; Apache-2.0.

The versioned client/host contracts are a candidate for hardening Mission Control’s HTTP/SSE wire. Delegation and DAG packages are possible references for generalizing Ring 2’s fixed subagent topology.

**Integration path:** evaluate `packages/contracts` first, with explicit protocol versioning and compatibility tests against current authenticated Mission Control. Only later compare delegation/DAG with Ring 2 and Ring 9’s existing orchestrators. Do not import ThinkRail’s IDE, Bun runtime, React shell, or a second session owner. Realign all Pi APIs to `1.4.0` and retain notices.

**Decision:** design evaluation, not an approved dependency.

### A3. open-ontologies — useful optional MCP sidecar, not a default dependency

**Source:** [`fabio-rovai/open-ontologies`](https://github.com/fabio-rovai/open-ontologies), reviewed at v2.1.0; MIT.

**Additive finding.** Formal RDF/OWL ontology validation, SHACL/SPARQL reasoning, change blast radius, and proof artifacts are net-new relative to Apex’s code retrieval, spec graph, and document extraction. The default architecture was assessed as local and credential-free.

**Integration path.**

- Consume a pinned release binary outside the workspace; verify the published SHA-256. Do not vendor its large source/benchmark tree.
- Register an operator-sourced **stdio** server through Ring 6 with `inheritEnv: false` and deferred `mcp_hub` discovery.
- Run only under a qualified confined profile with network disabled by default. `pull`/`push` requires a separate explicit destination grant.
- Disable the unauthenticated HTTP transport and WASM plugins.
- Onboard its skill through Ring 3 and treat ontology/MCP content as untrusted.
- Preserve current session-scoped MCP spill behavior.

**Constraints:** niche domain, native-binary supply chain, and maintainer concentration. Current Apex process-ownership/private-state blockers also mean “clean design” is not equivalent to “qualified deployment.”

**Decision:** optional profile after a small offline proof; never a required core dependency.

### A4. open-code-review — take the deterministic selector first

**Source:** [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review); Apache-2.0.

**Corrections to the headline.** OCR is not an offline SAST: an LLM renders findings. Its deterministic advantage is review orchestration and a glob-to-language-rule-document mapping. It is an MCP client, not an MCP server for Ring 6.

**Track A — preferred, zero binary.** Port the per-language rule-selection concept into Ring 2/7 so each changed file receives the appropriate reviewed rule document. Use Apex’s existing model and audit objects, preserve Apache notices, and test exact glob selection. This adds review focus without credentials, egress, Go, or a new runtime.

**Track B — optional external profile.** If the full engine is later justified, pin its checksum-verified binary as an optional dependency, invoke JSON/SARIF output from Ring 7 under qualified confinement, inject provider credentials from Ring 10, allow only the provider endpoint, disable telemetry/viewer, and deduplicate against existing BugBot/Codex findings.

**Decision:** Track A is a small additive improvement; Track B remains off by default because it overlaps existing review and adds provider spend and external process risk.

### A5. autoharness — port lifecycle policy, not the Claude plugin

**Source:** [`tigerless-labs/autoharness`](https://github.com/tigerless-labs/autoharness), reviewed at v0.5.3; MIT.

Autoharness is coupled to Claude Code hooks, CLI children, paths, and lifecycle events. Running it beside Ring 3 would create competing skill curators, so it is not a drop-in MCP sidecar.

**Useful additions.**

- `lifecycle.evaluate()` concepts: usage-rate fitness, probation before maturity, dormancy only after zero use and zero view, and capacity-driven deterministic eviction.
- Propose → intent queue → deterministic promoter separation.
- Compare-first skill distillation and explicit contradiction reconciliation.
- Selected injection-scanner and redaction ideas, revalidated rather than assumed stronger.

**Reject:** `--dangerously-skip-permissions`, Claude-specific packaging, automatic session-start prompt injection, and a new Python runtime.

**Decision:** reimplement the pure policies in TypeScript behind Ring 3’s existing quarantine and approval gates.

### A6. OpenMausBot — security reference, not an embeddable component

**Source:** [`milind-soni/OpenMausBot`](https://github.com/milind-soni/OpenMausBot); Apache-2.0 for OSS, with `enterprise/` explicitly excluded.

The project is a standalone Electron/React/server product, with Node `>=24` packaging and no clean library seam. Most product features overlap Apex.

**Borrow selectively.** MCP result budgets, strict handshake/schema validation, per-call timeouts, OAuth handling, read-only/open-world annotations, and its Pi MCP extension are useful Ring 6 references. Capability-token and per-turn consent ideas may inform Ring 0/2, but only inside Apex’s confinement.

**Reject:** Electron, PostHog, cloud-computer integration, `enterprise/`, user-privileged CLI execution as a security model, and any known-unclosed authorization route. A local Docker/noVNC computer would require a separate product need and isolation review; it is not implicitly approved.

**Decision:** pinned, attributed design references only; no product or sidecar import.

### A7. IBM STAIR — reject implementation, retain heading provenance idea

**Sources:** [arXiv:2609.03874](https://arxiv.org/abs/2609.03874), CC BY 4.0; `meghanadhpulivarthi/stair-clean`, assessed as unlicensed reference code.

STAIR’s per-corpus CUDA/LoRA training and weight-resident index conflict with Apex’s local, deterministic, CPU-friendly retrieval. The unlicensed code is not copyable, and code retrieval already has a structural AST representation.

**Optional idea.** Ring 13 can expose human-verifiable heading paths by persisting its existing section hierarchy into FTS5 and using BM25 over headings and body. A later constrained model step may select only from valid heading IDs and return cited provenance, but it is optional and must not be represented as reproducing STAIR’s fine-tuned benchmark results.

**Decision:** no STAIR code, model weights, or training runtime. A small Ring 13 retrieval experiment is permissible. Docling or other parsers require their own review rather than being implicitly approved here.

### A8. Huashu Design — content-generation skill with execution prerequisites

**Source:** [`alchaincyf/huashu-design`](https://github.com/alchaincyf/huashu-design); MIT.

HTML, deck, PPTX, infographic, and animation generation complements Ring 13’s read-side document parsing.

**Integration path:** onboard only through Ring 3 quarantine, localize operator-facing instructions, scan every script/reference, and execute under qualified confinement with egress off. Its Playwright/native Sharp/Python requirements remain optional dependencies, not core build requirements.

**Gate:** Apex’s historical scanner assessment found JS/shell-oriented rules but insufficient Python-specific coverage. Add and test Python rules for subprocess, evaluation, network, serialization, and obfuscation before enabling script-bearing use.

**Decision:** useful content candidate, not approved for unconfined execution.

### A9. Karpathy skills — original re-authoring only

**Source:** [`multica-ai/andrej-karpathy-skills`](https://github.com/multica-ai/andrej-karpathy-skills); no license at review.

Think-first, simplicity, surgical change, and goal-driven verification are useful ideas, but the repository’s prose may not be copied without permission. There is also no basis to treat a third-party repository as officially endorsed by its namesake.

**Decision:** write an original Apex canonical skill or surface using independent wording. No dependency and no copied text.

### A10. Agent-Reach — high-risk external data experiment

**Source:** [`Panniantong/Agent-Reach`](https://github.com/Panniantong/Agent-Reach); MIT.

Broad social/login-wall scraping fills a data-access gap but conflicts with default-deny networking and introduces cookies, platform terms, fragility, and legal/operational exposure.

**Decision:** if ever evaluated, use a separate explicitly enabled CLI/profile with its own narrow egress scope and vault-managed credentials. Prefer official APIs for GitHub, YouTube transcripts, and public Reddit. Never make scraping part of the default install or Tier A/B qualification.

### A11. OpenBot — no code; limited UX inspiration

**Source:** [`nightly-labs/openbot`](https://github.com/nightly-labs/openbot); PolyForm Noncommercial 1.0.0 at review.

The license blocks commercial reuse, while `danger-full-access` and `approvalPolicy: never` conflict with Apex’s authority model. Most workspaces, queues, browser, and messaging features already exist.

**Decision:** no code or dependency. Only general interaction ideas—queue lifecycle, single-owner shared channels, and per-agent workspace presentation—may inform original Ring 5 design.

### A12. NVlabs SoL-Pi — strong architectural match with a hard tool-boundary blocker

**Source:** [`NVlabs/SoL-Pi`](https://github.com/NVlabs/SoL-Pi) at `219568034fa54ed121ede80961655e33dfb9d0e3` (v0.1.1); MIT. This is the canonical NVIDIA repository. The npm name `sol-pi` was assessed as unrelated; do not install it from npm.

**Additive finding.** SoL-Pi is a public-API Pi extension on the same Node floor as Apex, with opt-in mechanisms and no third-party runtime dependency beyond Pi/typebox. Its four mechanisms have very different integration positions:

- **ObservationPack** replaces older large observations at the model-projection layer with stable handles and exact-page recall while retaining stored history. This is adjacent to Apex’s spill store but offers a distinct cross-turn paging model.
- **Evidence-Preserving Reducer** permits model compression only when retained quotations match an archived source, leaving the original result untouched on failure. It still creates model/egress cost and secret exposure.
- **Online Context Compact** adds plan/economic compaction policy and overlaps Ring 1’s existing two-stage compaction. Apex must have one owner for this policy.
- **Action Fusion** appends validation commands to mutations. Its upstream construction creates replacement edit/write/bash tools without Apex’s injected confinement, shell guard, and WAL wrapping.

**Hard blocker.** Loading the upstream extension unchanged could give the model a second shell/mutation path outside Ring 0’s `BashOperations`, monotonic shell gate, read-only admission, and WAL. Action Fusion is therefore disqualified until its command path is explicitly adapted into the exact Apex-owned tool path and denial canaries pass.

**Integration sequence.**

1. Vendor a pinned source snapshot with MIT/NOTICE for a compatibility-only spike. Run typecheck, the upstream suite, and `check-pi-compat.mjs --strict` against **Pi 1.4.0**; upstream development dependencies still target 1.3.0.
2. Measure active schemas with every mechanism off and again for each enabled mechanism. Do not assume the historical 1,073-token baseline remains valid with new tools.
3. If green, pilot **ObservationPack only**, off by default. Reuse or deliberately compose with Apex’s session-scoped SpillStore/private-state capability rather than accepting upstream writes to an arbitrary session directory.
4. Prove handle/recall fidelity, history immutability, compaction/resume behavior, secret scrubbing, output bounds, and crash recovery.
5. Keep Reducer off until its provider/egress policy is explicit. Keep Online Context Compact off while Ring 1 or another compaction adapter owns policy.
6. Consider Action Fusion only after confined operations, shell-guard, WAL, read-only, missing-sandbox, and interference-check tests all pass.

**Decision:** potentially one of the best native fits, but currently **design/compatibility-spike only**. No Pi 1.4 or Apex integration suite was run during this consolidation.

### A13. Google LangExtract — adopt grounded-extraction semantics before adopting Python

**Source:** [`google/langextract`](https://github.com/google/langextract), reviewed release v1.7.1 at tag commit `a4c0aa4c1be98f441ffc7e1d0f85b1067748e1f3`; Apache-2.0.

**Additive finding.** Ring 13 parses documents but does not semantically extract typed entities grounded to exact source character intervals. LangExtract’s combination of verbatim extraction text, source offsets, explicit ungrounded results, and alignment warnings matches Apex’s provenance model.

**Preferred zero-runtime phase.** Define an Apex-owned TypeScript extraction contract containing typed entities, verbatim text, `char_interval`, grounded/ungrounded state, and alignment diagnostics. Validate that every grounded interval exactly matches the source and filter or explicitly mark ungrounded output. This creates a stable Ring 13 interface for any future extractor without adding Python, a model, or egress.

**Optional later sidecar.** If a real document workstream justifies it:

- Pin a minimal, checksum-verified Python environment outside the workspace and invoke an Apex-owned JSON adapter under qualified confinement.
- Start with local Ollama and network disabled except the explicitly approved loopback endpoint. Cloud providers require separate operator consent, vault credentials, endpoint allow-listing, and document-egress disclosure.
- Onboard the first-party skill through Ring 3, but do not execute arbitrary examples.
- Treat extraction as advisory data; never auto-mutate the workspace or parse the HTML visualization as an authority.
- Run batch/document workflows, not per-turn multi-pass extraction.

The reviewed third-party TypeScript and MCP ports were stale and are not approved shortcuts. The default Python dependency tree is heavy even for local use and needs a separate resolved-tree audit.

**Decision:** the grounded data contract is a good small addition; the full library is an optional document-intelligence sidecar, not a core dependency. No live extraction or sidecar test was performed.

---

## 7. Review wave B — October 30 Pi-ecosystem assessments

Lead post: [`X/@GitTrend0x status 2116062652250112427`](https://x.com/GitTrend0x/status/2116062652250112427). Its cost and capability claims were not accepted as independent proof.

### B1. pi-cached-compaction — promising mechanism, Apex-specific pilot only

**Current source recheck:** [`nicobailon/pi-cached-compaction`](https://github.com/nicobailon/pi-cached-compaction) at `e1e20de0a7e433070414602f1105cdcac258ef4f` (v0.2.0). `package.json` declares MIT; no standalone `LICENSE` file was present at this pin, so clear license text must be retained or obtained before copying code.

**Additive finding.** The extension attempts to reuse a provider’s cached conversation for compaction and lets the summarizer see full tool output rather than short excerpts. This is potentially useful for long Apex sessions, but its savings are provider- and workload-specific. The author’s 667k-session cost comparison is not an Apex benchmark.

**Why direct installation is inappropriate.** Apex has stricter pinned-prefix, receipt, unattended-execution, and recovery invariants than an ordinary Pi extension assumes. Full tool output can also carry secrets or untrusted instructions. Automatic compaction before cache expiry must not become an unapproved background mutation.

**Required adaptation.**

- Off by default behind a provider-capability matrix.
- Prove the cached request’s prefix byte-for-byte using Apex-owned serialization/hash checks; otherwise fall back to existing compaction without sending.
- Keep pinned system/tool state unchanged and test model switches, edits, tree navigation, overflow, and other extensions.
- Define secret scrubbing and untrusted-content handling for full tool output.
- Route any expiry-triggered behavior through the existing unattended/approval policy.
- Test checkpoint receipts, restart/recovery, read/modified-file lists, and summary quality on Apex workloads.
- Report measured cache share, quality, latency, and cost separately; never promise the promotional percentage.

**Current upstream verification:** typecheck passed and **18/18 tests passed** at the pin above. No live provider cost or Apex compaction test was performed.

**Decision:** adapted, gated pilot only.

### B2. pi-ampersand — display-only observer, with upstream feedback removed

**Current source recheck:** [`y0usaf/pi-ampersand`](https://github.com/y0usaf/pi-ampersand) at `7893ced32b2d4ee740c9a6c5634a3b99c6f5b65e`; MIT.

Ampersand observes user and assistant text and normally remains silent. It does not receive tool calls or file edits, but it sends clipped conversation text to a third-party service and requires an API key.

**Critical boundary.** Upstream uses `pi.sendMessage(..., display: true)`, and its README explicitly says observer messages reach Pi’s model on the next turn. Therefore upstream is **not** merely a display observer: its text can influence subsequent tool-using behavior.

**Apex-safe shape.**

- Render observer output only in Mission Control, outside model-visible session history and outside the pinned prefix.
- No observer tools, action authority, approvals, or automatic steering.
- Explicit per-session opt-in, off by default and unavailable in unattended/print modes unless separately approved.
- Vault-managed key, endpoint allow-list, secret scrubbing, data-egress disclosure, size/retention limits, and failure isolation.
- Treat even display text as untrusted and sanitize its rendering.

**Verification:** the reviewed repository has no test script; no live service was contacted.

**Decision:** the “quiet second opinion” idea is optional UX; the upstream extension should not be installed unchanged.

### B3. Pi-Remote — separate companion, never a second Apex control plane

**Current source recheck:** [`Xpropel/Pi-Remote`](https://github.com/Xpropel/Pi-Remote) at `7a1abf13329c36dc50f3bcf8ed2486996fbcd979` (v2.1.10); MIT.

Pi-Remote combines an in-process Pi extension, relay, and web UI for session mirroring and remote commands. It overlaps Mission Control and can remotely inject messages, change models, compact, and optionally run bash. Its own documentation describes personal single-user use rather than a multi-user authorization model.

**Decision.** Keep it as an external companion for ordinary Pi, not an Apex dependency. Do not bridge its remote command authority into Ring 0 or create a parallel Apex relay.

**Reusable ideas.** Reconnect/catch-up behavior, mobile presentation, separate device/viewer credentials, explicit connection lifetime, and delivery receipts may inform future Mission Control work. Any such work must use current Apex browser sessions, logout, pairing protections, approvals, and origin/host controls.

**Qualification gate.** The earlier review did not approve it because its qualification suite was not green. The fresh `npm test` run at the current pin was also not green: **2,326 passed, 13 failed, 44 cancelled, and 11 skipped**. Failures included executable-bit assertions and cancelled asynchronous tests. No UI build, real relay, or remote-command qualification was performed. Even a green upstream suite would not by itself qualify its relay or remote-command model for Apex.

### B4. pi-phone — coexist as a separate Android/platform product

**Current source recheck:** [`picassio/pi-phone`](https://github.com/picassio/pi-phone) at `0084cb5e96b503237d77c3d8b512b747f2bc34df`; MIT, with `LICENSE-pi-pocket` and an upstream provenance ledger.

Pi-phone is an Android application carrying a Linux userland and running Pi Durable, with a large server/tool/UI surface. It is not a Pi extension or an additive Apex module.

**License update.** The earlier review required upstream permission before any vendoring. The current pin now visibly includes MIT license files and records pi-pocket/pi-termux-mobile provenance. That is improved evidence, but not a complete audit of its approximately 1,500-file tree and bundled third-party skills, binaries, fonts, and assets. Any future copying still requires a complete provenance check and all relevant notices.

**Decision:** evaluate only as a separate client/platform using public APIs. Durable-session and mobile-UX ideas may be studied, but do not import its Android runtime, broad tool catalog, server, browser automation, credentials, or second session/durability owner into Apex. No Android build or device qualification was performed in this review.

### B5. pi-pstack — selected licensed skills, not the whole autonomous extension

**Current source recheck:** [`jiangkoumo/pi-pstack`](https://github.com/jiangkoumo/pi-pstack) at `7af23c2b80a5157db82eeaca3e4976a41eb67448` (package v0.3.15); MIT, including Lauren Tan’s upstream copyright and third-party notices.

**Additive finding.** The engineering principles, verification checklists, investigation/review prompts, and selected playbook content can enrich Ring 3 without adding another runtime.

**Integration path.**

- Select individual skills/playbooks by product need; do not install all content by default.
- Run the complete selected bundles through Ring 3 quarantine, including scripts, references, and agent definitions.
- Preserve `LICENSE`, `LICENSES/`, and `THIRD_PARTY_NOTICES.md` and upstream source pins.
- Convert persistent Poteto-style behavior into explicit, on-demand Apex workflows rather than live system-prompt mutation.
- Map independent review and verification to existing Ring 2/7 roles and Ring 11 approvals.

**Exclude initially:** auto-continue/loop, writer gates that own execution, automatic commit/push behavior, alternate subagent ownership, TLC/process runners, and any fallback that calls an unconfined temporary worktree a sandbox. Apex’s boundary remains authoritative.

**Current upstream verification:** **38/38 top-level test-plan checks passed**. This supports upstream maintenance, not Apex approval. Dependency installation also reported three moderate and one high npm audit finding; no automatic remediation was applied, and the full dependency-bearing extension remains outside the recommendation.

**Decision:** high-value content source after selection and quarantine; not a full extension import.

---

## 8. Review wave C — DSH Superagent

**Source:** [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) at `6337fc823ce20251c8de8085948165c81aaa701e`; MIT. The README identifies it as a research prototype, not production-ready or an official DeepSeek product.

DSH is a separate DeepSeek Harness application with its own sessions, executor, SQLite schema, sources, channels, and UI. It is not a Pi extension. Wholesale integration would duplicate Apex’s authorities.

### C1. Versioned work Mandates and admission policy — highest architectural value

**Gap in Apex.** Ring 9 authenticates senders and Ring 11 approves individual actions, but Apex lacks a durable work-item record explaining who authorized autonomous work, whether authority was explicit or inferred, which scope/rules applied, and which policy version must be revalidated before resume.

**Adapt, do not copy.**

- Create an Apex-owned immutable Mandate with source, actor, originating Trigger, strength, structured scope, matched deterministic rules, policy version, and lifecycle state.
- Join Ring 8 GitHub intake and Ring 9 messages to Ring 7 runs through `mandateId`.
- Start inferred proactive work in `observe`; explicit operator acceptance is required before execution until stronger evidence exists.
- Let a model assess only within deterministic permissions; it cannot create capabilities or broaden paths/branches/tools.
- Revalidate external authority and policy before resuming. A context subscription or follow-up grants no authority by itself.
- Enforce scope through Ring 0/2/11, not through a prompt or DSH’s free-form scope string.

DSH’s `src/policy.ts` and `src/core/model.ts` are design references, not drop-in modules.

### C2. Durable outbound Effects/Outbox — concrete Ring 9 gap

Apex’s `OmniChannelGateway.send()` currently performs transport I/O and writes the outbound gateway record after success. DSH contributes pre-send receipts, transactional enqueue, post-commit dispatch, coalescing, per-conversation ordering, retries/backoff, and restart recovery.

**Required Apex redesign.**

- Persist a scrubbed outbound receipt before transport execution in Apex-owned state.
- Use stable ids/idempotency keys and adapter-specific idempotency where supported.
- Preserve per-conversation ordering and explicit withdrawal/drop states.
- Add `OUTCOME_UNKNOWN`: a crash after send but before settlement must not trigger blind duplicate replay.
- Reconcile through provider message IDs or operator resolution where the platform cannot provide idempotency.
- Cover transaction rollback, crash before send, crash after send, retry ordering, restart, scrubbing, and retention.

DSH’s queue is useful evidence but is not, by itself, an exactly-once external-delivery solution. Do not import its Store or replace Apex’s WAL.

### C3. Attention-first autonomous-work states — small Ring 5 extension

Apex already has a “Needs your attention” control driven by pending execution approvals. The additive idea is to project existing autonomous runs, outbound receipts, and approvals into states such as **delivery, answer, review, blocked, and failed**, alongside queued/working/idle.

Extend the current Mission Control API/UI; do not import DSH’s React panel or Ticket store. This should be a derived projection with links to the owning Apex receipt/run, not another authority or lifecycle.

### C4. Secondary ideas and exclusions

- **Observe-only GitHub Triggers:** cursor-based polling, deduplication, and source health can later extend Ring 8. Scan/quarantine external content before model assessment and require Mandate acceptance before Ring 7 execution.
- **Human-priority worker slot:** optional scheduling refinement only; Apex already owns process/worktree management.
- **Idempotent input delivery/read receipts:** compare with existing WAL and PTY/session ledgers before adding anything.

**Do not import:**

- DSH sessions, executor, Sources, Feishu/GitHub channels, Store, UI, or tool presets.
- OS-user shell execution or command shims represented as security controls.
- Prompt-only auto-merge requirements; merges remain host-enforced.
- Mutable per-request prompt versions; changes belong at `/new` or outside the pinned prefix.

### C5. DSH verification

At `6337fc8`:

- Frozen dependency installation: **passed**.
- Typecheck: **passed**.
- Build: **passed**.
- Tests: **1,196 passed, 1 failed** across 59 files.
- The failure was a Feishu consumer health assertion: after malformed event input, health remained `ready / Listening for bot events` rather than the expected error. The focused test failed identically when rerun alone.
- No real GitHub/Feishu accounts, workers, external messages, or Apex integration were exercised.

**Recommended DSH pilot:** observe-only GitHub Trigger → deterministic admission → immutable Mandate → explicit approval → existing Ring 7 pipeline. Pursue the outbound outbox as a separate infrastructure pilot. Do not merge the DSH runtime.

---

## 9. Verification and evidence register

| Item | Exact source | Evidence | What it does **not** establish |
|---|---|---|---|
| Current Apex | `89fc070f02af3a3a6e5c8a200d182f6dc58ac333` | Current-source review; CI run `41338519955` green on Ubuntu 22.04/24.04 required lanes | Full live-feature, macOS, physical power-loss, or unresolved isolation certification |
| Earlier Apex baseline | `1ef6dd14ae259479206de7504e1669b66b97dd84` | Used for source-delta comparison | That current worktree modifications are part of `main` |
| ThinkRail spec-graph | `9066aa9f4bb5c0dcb681235b4b936e8be73651f7` | Historical 7/7 spike report | Reproducible current-main proof; spike files are absent |
| SoL-Pi | `219568034fa54ed121ede80961655e33dfb9d0e3` | Source/manifest/security review; canonical repo and license rechecked | Pi 1.4 compatibility, safe Action Fusion, or an ObservationPack Apex pilot |
| LangExtract | v1.7.1 tag `a4c0aa4c1be98f441ffc7e1d0f85b1067748e1f3` | Source/architecture/license review | Live extraction quality, Python sidecar qualification, or current main-branch requalification |
| pi-cached-compaction | `e1e20de0a7e433070414602f1105cdcac258ef4f` | Typecheck passed; 18/18 upstream tests passed | Live provider savings, summary quality on Apex, or prefix-safe Apex integration |
| pi-ampersand | `7893ced32b2d4ee740c9a6c5634a3b99c6f5b65e` | Source/manifest review | Live-service behavior or display-only safety of the unmodified extension |
| Pi-Remote | `7a1abf13329c36dc50f3bcf8ed2486996fbcd979` | `npm test`: 2,326 passed, 13 failed, 44 cancelled, 11 skipped | Apex control-plane compatibility, UI build, production relay security, or a green qualification suite |
| pi-phone | `0084cb5e96b503237d77c3d8b512b747f2bc34df` | Current source, license, and provenance recheck | Android build/device behavior or complete third-party asset audit |
| pi-pstack | `7af23c2b80a5157db82eeaca3e4976a41eb67448` | 38/38 top-level upstream test-plan checks passed | Apex skill quarantine, full dependency approval, or autonomous-execution approval |
| DSH Superagent | `6337fc823ce20251c8de8085948165c81aaa701e` | Install/typecheck/build passed; 1,196/1,197 tests passed | External-service readiness, executor security, or Apex compatibility of the runtime |
| October 28 sources | Links and versions in Section 6 | Source/architecture/license assessments; no current Apex pilot | Current upstream HEAD verification or integration readiness |

### Consolidation notes

- The Pi-Remote test environment initially attempted to fetch a locked tarball from `registry.npmmirror.com`, which is outside this environment’s permitted registry path. That launcher/network failure is not reported as a product test failure. After installing through npm’s registry, the actual `npm test` result was **2,326 passed, 13 failed, 44 cancelled, and 11 skipped**, so Pi-Remote remains unqualified.
- pi-cached-compaction has no lockfile at the reviewed pin, so `npm ci` was inapplicable. Its tests were run after a no-lockfile install; the initial `npm ci` usage error was not counted as a test failure.
- No external credentials, live model calls, messages, scraping, Android operations, or autonomous Apex actions were used.
- No Apex source remediation is included in this document or authorized by it.

---

## 10. Final integration position

Apex’s differentiator is not the number of attached agent products; it is the ability to add capabilities without weakening authority, durability, provenance, or prompt determinism. The reviews therefore converge on one rule:

> **Import a narrow capability only when Apex remains the sole owner of execution, session state, external effects, and approval authority.**

The next best engineering investments are **Mandates**, a **crash-safe outbound outbox**, **small quarantined policy/content ports**, a **reproduced read-only spec-graph proof**, and a **gated SoL-Pi ObservationPack compatibility proof**. Everything else remains optional, external, reference-only, or rejected until its stated gates are met.
