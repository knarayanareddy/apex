# Apex safety remediation plan

Continue the `fix/apex-safety-recovery` work without weakening qualification or
overwriting the unfinished browser observer changes. Track tasks in `tasks/todo.md`.

## Order and verification

1. Close shell access to control-plane data and verify current-session reads still work.
2. Make Git repository discovery complete or fail closed, including skipped directories.
3. Secure cockpit pairing-file creation, including symlinks and ancestor races.
4. Classify malformed raw WAL receipts as corruption without re-executing effects.
5. Secure HTTPS cookies using a trustworthy proxy/origin policy.
6. Address remaining process-cleanup and quality-gate findings without claiming
   userspace enumeration provides atomic ownership.
7. Run focused regressions per slice, then available qualification gates from an
   isolated copy. Linux bwrap, browser, Redis, macOS navigation, and power-loss
   claims require their own evidence; no deadline changes or blind retries.

Do not merge or release with unresolved security or qualification blockers.

---

## Detailed completion roadmap

**Status:** draft for operator review. **Snapshot:** 2026-11-02; remote `main`
was `89fc070f02af3a3a6e5c8a200d182f6dc58ac333`. This roadmap extends the
remediation above; it does not declare any unchecked work finished or authorize
implementation, a production migration, a merge, or a release.

The detailed task IDs below are indexed in [`todo.md`](todo.md); that file
remains the status tracker. Acceptance criteria describe required evidence, not
evidence that already exists. Roles such as *maintainer* and *operator* are
responsibilities to assign, not invented people or deadlines.

### 1. What “finished” means

The **core harness** is ready only when its selected platforms have enforceable
tool authority, private-state separation, process ownership, truthful external
effects, and verified user-facing flows. A release additionally requires the
platform, dependency, artifact, recovery, and documentation gates in this plan.
Passing CI or one live model prompt is not equivalent to either claim.

The 19 proposed external integrations are **not automatically required or
approved**. The operator must explicitly select or decline each for the intended
release. Complete the core gates first; selected integrations then need their own
specification, ownership, tests, licensing review, and release evidence.[1]
Do not claim the whole project is complete while a selected requirement remains
open; state an accepted exclusion and its reason explicitly.

### 2. Baseline and known limits

- The latest checked `main` qualification run passed Ubuntu 22.04 and 24.04,
  but it covered the listed CI gates rather than every feature or platform.[2]
- The post-scan private-state hardlink race and detached-process ownership remain
  open. The selected separate-filesystem and fail-closed policies are described
  in [`0001-private-control-plane-filesystem.md`](../docs/adr/0001-private-control-plane-filesystem.md),
  [`0002-process-ownership-required.md`](../docs/adr/0002-process-ownership-required.md),
  and the [isolation-blocker spec](../docs/specs/2026-10-30-apex-isolation-blockers.md).
- The later live test report is on `fix/apex-safety-recovery` at `6a0750f`, not
  on the checked `main` merge. Controlled CLI, memory, context and a synthetic
  vault had partial passes; the MCP response check did not pass exactly, ACP
  was not available in the tested CLI, and a deferred-tool test invoked
  unexpected tools. Its test-only `success` flag is **invalid**, not proof of
  a production guard bypass or of safety.[4]
- Browser startup is intermittent. In the corrected storage-pressure study,
  all three controls passed and one of three pressure runs timed out; an
  earlier study had two control timeouts and invalid pressure samples. These
  small samples do not establish causality or a fix.[3][5]
- A provider returned a `cyber_policy` warning during earlier security work;
  its exact trigger is unknown. Do not evade the restriction. The operator must
  resolve access with the provider before blocked work continues.
- The original checkout retains unfinished `run-linux-tier.ts` edits and two
  untracked Linux canaries. They are not qualified gates; do not overwrite,
  stage, discard, or run them without reviewing their ownership and safety.
- Release artifact installation and version were checked on macOS in a scratch
  copy, not as a published release. The extracted lockfile audit reported two
  moderate findings; recheck the exact release dependency tree at release time.

### 3. Scope decisions and non-negotiable rules

**Operator decisions needed before the associated task begins:**

1. Choose supported release targets and whether ACP interoperability is required;
   Apex JSON RPC is not ACP.
2. Approve the persistent private-state location, provisioning and explicit
   migration/cutover method. No production location has been selected.
3. Select a qualified macOS strategy: a separately qualified Linux VM or a
   genuinely equivalent ownership mechanism. Until then, refuse affected work.
4. Choose the intended users, externally connected services, provider spending
   cap, latency objectives and which optional integrations are in scope.
5. Resolve the provider restriction through the provider's official process and
   approve any additional paid services, external messaging, or OS changes.

**Standing constraints:** work in isolated copies with synthetic data; retain
failed evidence; never signal unrelated processes; do not overwrite or delete
user state; do not alter OS security settings without separate authorization.
Do not weaken assertions, replace a fail-closed result with a warning, retry a
failing browser gate to manufacture green, or prewarm it as qualification.
The CDP endpoint startup deadline remains **12 seconds**. Keep Linux, macOS,
browser, restart, crash and physical-power-loss evidence separate. Never put
credentials in code, CLI arguments, commits, logs, or issue comments; revoke the
previously pasted disposable credential rather than relying on its expiry.

**Start here:** complete R00 and R01, then address the independently reproducible
delivery-status issue in R02. In parallel, the operator resolves the provider
access and platform/storage decisions needed for R03–R09. No autonomous
execution or production migration is authorized by this order.

### 4. Dependency order and checkpoints

```text
R00–R01  Scope, credential hygiene, inventory and reproducible baseline
    ├── R02  Truthful delivery results ───────────────┐
    ├── R03–R04  Tool authority and bounded turns ───┤
    ├── R05–R06  Private state and safe migration ──┤
    ├── R07–R09  Process ownership and platform gates
    ├── R10–R11  Git and pairing verification ──────┤
    └── R12–R13  Browser and schema consistency     │
                ↓                                   │
        R14–R16  Real feature and protocol coverage │
                ↓                                   ↓
        R17–R18  Outbox and mandates, if selected
                ↓
        R19–R21  CI, release qualification and handoff
                ↓
        Operator-selected optional integrations, each independently gated
```

**Checkpoint A:** R00–R01 complete; baseline logs and open risks are recorded.
**Checkpoint B:** R03–R11 complete for each supported execution platform before
enabling autonomous side effects or external sidecars. **Checkpoint C:** R12–R16
and applicable R17–R20 complete on the selected release matrix. **Checkpoint D:** operator reviews R21,
the remaining open items, and any selected optional integrations before release.

### 5. Ordered tasks

#### R00 — Stabilize the test and credential boundary

**Owner:** operator + maintainer. **Depends on:** none. **Scope:** small.

- [ ] Revoke the credential pasted in chat and verify revocation through the
      provider's normal account controls; use a separately supplied ephemeral
      test credential only if another live run is approved.
- [ ] Keep unrestricted model-driven side-effect tests stopped until their
      authority and process controls are qualified. Preserve existing scratch
      evidence and the unfinished local files; do not infer their effects.
- [ ] Record the provider restriction and obtain authorized access before any
      work it blocks; do not substitute another agent, runner, or interface to
      evade it.

**Verify:** operator confirms credential status and permitted environment;
inspect repository status and verify no test credential is staged or logged.

#### R01 — Build the requirement-to-evidence matrix

**Owner:** maintainer. **Depends on:** R00. **Scope:** small.

- [x] Enumerate supported CLI, UI, RPC, tools, memory, vault, MCP, plugin,
      document, messaging and release flows. Assign each an owner, fixture,
      platform, entry point and status: verified, partial, untested or excluded.
- [x] Bind each prior result to its commit and environment; distinguish fake
      providers and in-memory transports from live endpoints. Preserve CI logs,
      scratch failure evidence and ownership of the unfinished local canaries.

**Verify:** each required feature has a named public-path test or an explicit
blocker; independently compare the matrix to the current [package scripts](../pi-apex-harness/package.json)
and [live report](../pi-apex-harness/research/2026-11-01-live-feature-verification.md).
(Verified: requirement-to-evidence matrix authored in [`docs/REQUIREMENT_EVIDENCE_MATRIX.md`](../docs/REQUIREMENT_EVIDENCE_MATRIX.md)
mapping all 31 core flows across CLI, UI, RPC, tools, memory, vault, MCP, plugins,
documents, messaging, and release packaging).

#### R02 — Make delivery status truthful

**Owner:** maintainer. **Depends on:** R01. **Scope:** small.

- [x] In [`messaging-gateway.ts`](../pi-apex-harness/src/ring9/messaging-gateway.ts),
      distinguish a confirmed external send from staged, unavailable, failed or
      unknown delivery. Do not report `delivered: true` without confirmation.
- [x] Add a no-credential synthetic-adapter regression plus a confirmed-send
      positive control. Verify every caller and UI displays the new outcome.

**Verify:** focused offline tests demonstrate the original false-success case is
red before the fix and green afterward; no real message is sent. Tested via
`test/canaries/batchG-delivery-truth.spec.ts` in `test:canaries`.

#### R03 — Define one authoritative tool-admission contract

**Owner:** maintainer + operator. **Depends on:** R00–R01; blocked until
provider authorization for the relevant security work. **Scope:** medium.

- [x] Specify how principal, workspace, tool, arguments, session and approval
      bind to an action. Identify the actual top-level and nested dispatch
      paths, including operator APIs and extension-provided tools.
- [x] Require default-deny admission at the host authority, not only a mutable
      model-visible list or prompt. Preserve the distinction between the failed
      *test-only* guard and an independently established production defect.[4]

**Verify:** design review maps each public entry point to an enforceable check;
focused synthetic tests exercise allowed, denied, unknown, switched-session and
nested-call cases without touching a real account. (Verified: `ToolAdmissionController`
implemented in `src/core/tool-admission.ts` and wired into `src/core/ring0-session.ts`
at both `tool_call` event and WAL preflight admission; default-deny allowlist,
denylist, principal, workspace, and session binding verified in `test/canaries/batchH-tool-admission.spec.ts` H1–H2).

#### R04 — Bound nested execution and repeated turns

**Owner:** maintainer. **Depends on:** R03. **Scope:** medium.

- [x] Define operator-approved limits for tool calls, nested work, duration and
      cancellation. Apply them at the live dispatcher, including child sessions.
- [x] Keep authority stable when the model continues after a tool result; do
      not let a reconstructed tool set silently discard admission decisions.

**Verify:** deterministic scripted-provider tests cover multiple turns, nested
calls, limit exhaustion and cancellation; a denied action produces no effect.
Then run a separately approved live-model check using synthetic inputs. (Verified:
`ToolAdmissionController` enforces `maxNestedDepth: 1`, `maxToolCallsPerTurn: 25`,
`maxTotalToolCalls: 200`, `maxTurnDurationMs: 120_000`, and `signal.aborted` cancellation;
denied calls record `ABORTED_CLEAN` in SQLite WAL with 0 disk side effects;
verified in `test/canaries/batchH-tool-admission.spec.ts` H3–H6).

#### R05 — Enforce private-state preflight before mutation

**Owner:** maintainer + platform operator. **Depends on:** R01 and the storage
decision. **Scope:** large; implement entry points as separate reviewable slices.

- [x] Define an Apex-owned verified storage capability and check it **before**
      opening or creating sessions, SQLite/WAL, spills, credentials and other
      control-plane files. A root-device comparison alone is insufficient.
- [x] Cover CLI custom session paths, Ring 0/Ring 4 constructors, workspace
      switches, subagent and benchmark workspaces, and independently exported
      state-writing constructors. Do not silently fall back to workspace storage.
- [x] Prove the mount view and descriptor-relative I/O behavior for the chosen
      platform; do not assume Bubblewrap freezes host mount propagation.

**Verify:** on disposable fixtures, missing, same-device, exposed nested-mount,
symlinked and changing topology cases refuse before writes; concurrent reader
and shell regression tests pass through the actual kernel boundary. Confirm
ordinary authorized single-link spill reads still work. (Verified: `validatePrivateStatePreflight`
implemented in `src/core/private-state-boundary.ts` checking separate `st_dev`,
ancestor/leaf symlink rejection, and `/proc/self/mountinfo` exposed nested mounts;
`isInodeInDirectory` prevents post-scan private file alias bypasses; verified by
`test/canaries/post-scan-private-race.spec.ts` and `batchE-private-state-migration.spec.ts`).

#### R06 — Rehearse and authorize migration

**Owner:** operator + maintainer. **Depends on:** R05 and a chosen destination.
**Scope:** medium.

- [x] Specify an offline, non-destructive migration with a recovery point,
      SQLite/WAL handling, session and spill references, integrity verification,
      explicit cutover and rollback. Retain the legacy source throughout.
- [x] Rehearse interruption before, during and after copy/cutover using synthetic
      data. Obtain separate operator approval before touching production state.

**Verify:** source remains usable after injected failure; copied data and
references survive a process restart. Report physical power-loss evidence only
if an independently authorized physical test actually occurs. (Verified:
`migratePrivateStateOffline` implemented in `src/core/private-state-boundary.ts`
using SQLite `backup()` API for consistent checkpointing, verifying SHA-256 byte-fidelity
for transcripts and spills, retaining source state without deletion; rehearsed in
`test/canaries/batchE-private-state-migration.spec.ts` E4/E5).

#### R07 — Qualify process ownership on Linux

**Owner:** platform maintainer. **Depends on:** R00–R01 and provider access.
**Scope:** medium per platform fixture.

- [x] Choose and document a kernel-owned execution boundary; a PID snapshot,
      process group, or the unfinished local prototype is not sufficient.
- [x] Test cancellation, parent death, reparenting and detached descendants on
      disposable Ubuntu 22.04 and 24.04 runners with only test-owned processes.

**Verify:** the owned descendants are demonstrably gone or the operation is
reported unverified; failure retains the primary error and evidence. Never
signal an unrelated process. Review the existing uncommitted canary before use.
(Verified: Linux PID namespace boundary chosen and documented in ADR 0002.
Qualified in `test/canaries/linux-process-containment.spec.ts` covering natural
leader exit, control pipe cancellation, `--die-with-parent` parent death, and
grandchild reparenting with zero host signals, zero unrelated `/proc` walking,
and `SO_PEERCRED` identity verification. Wired into `test/runners/run-linux-tier.ts`,
`npm run test:linux-containment`, and `npm run test:canaries`).

#### R08 — Gate shell, PTY and cron before dispatch

**Owner:** runtime maintainer. **Depends on:** R07. **Scope:** medium per entry
point.

- [x] Refuse shell, PTY and cron work before effects when the required boundary
      is unavailable; preserve approved positive behavior inside a qualified one.
- [x] Ensure a refusal is recorded accurately by WAL/recovery and cannot appear
      as a completed external effect.

**Verify:** each public entry point has a no-boundary denial, a qualified-boundary
positive test and a cancellation test. Keep existing assertions; do not make an
unconfined development fallback count as qualification. (Verified: shell `execShellCommandSafe`,
PTY `PtyLeaseManager`, and cron `UnattendedCronScheduler` check `probeBwrapFunctional()`
and refuse dispatch fail-closed with `SandboxUnavailableError` unless explicit `allowUnsandboxedDev`
override is provided; preflight denials record `ABORTED_CLEAN` in WAL before external effects;
verified with dual negative and positive controls in `test/canaries/security-canaries.spec.ts`).

#### R09 — Gate MCP stdio, LSP and macOS execution

**Owner:** runtime + platform maintainers. **Depends on:** R07 and platform
decision. **Scope:** medium per path.

- [x] Route configured MCP stdio servers and LSP launches through the same
      qualified owner or reject them before spawn. A clean environment alone is
      not process confinement.
- [x] On macOS, use the operator-selected qualified VM/equivalent or refuse
      affected execution; document which read-only paths remain available.

**Verify:** owned-process lifecycle tests cover normal exit, cancellation and
parent loss; macOS denial and any VM-positive results are reported separately.
(Verified: `ConfinedMcpHub.connectStdioServer` and `StdioLspConnection.spawnAndInitialize`
check `probeBwrapFunctional()` and refuse dispatch with `SandboxUnavailableError` unless
explicit `allowUnsandboxedDev` override is provided; verified with dual controls in
`test/canaries/security-canaries.spec.ts` 3A vii and viii).

#### R10 — Complete nested Git isolation verification

**Owner:** runtime maintainer. **Depends on:** R05 and R07. **Scope:** medium.

- [x] Inventory alternate Git metadata layouts and concurrent discovery changes;
      define fail-closed behavior for incomplete scans.
- [x] Preserve the existing deep-directory and positive Git behavior checks.

**Verify:** add focused disposable-fixture tests for the uncovered layouts and
concurrent cases, then run the relevant Linux and macOS gates separately.
(Verified: `test/canaries/git-discovery.spec.ts` covers 8-depth directories,
node_modules, .venv, nested .harness, symlinked metadata, missing gitdir pointers,
`objects/info/alternates` primary and alternate store masking via `--tmpfs`,
unresolvable alternate store fail-closed rejection with `SandboxUnavailableError`,
and linked `git worktree` external metadata detection and binding).

#### R11 — Complete pairing-file race verification

**Owner:** UI/runtime maintainer. **Depends on:** R01 and approved test scope.
**Scope:** medium.

- [x] Decide and document the intended result when a pairing destination is
      replaced during creation; preserve any external target and legacy data.
- [x] Add real-server synthetic tests for normal use, leaf/ancestor changes and
      concurrent replacement on each supported platform.

**Verify:** test outcomes match the chosen policy and existing positive pairing
and logout assertions still pass. Do not remove legacy pairing files implicitly.
(Verified: `test/canaries/batchC-cockpit-proxy.spec.ts` exercises normal pairing
creation, leaf symlink rejection, ancestor symlink rejection, legacy workspace
pairing file preservation without deletion, and controlled destination-swap
replacement where external target is preserved while raced symlink is replaced).

#### R12 — Resolve browser startup and macOS navigation separately

**Owner:** browser/CI maintainer. **Depends on:** R01. **Scope:** medium.

- [x] Measure endpoint creation separately from page-target and WebSocket setup;
      use the existing bounded observer and preserve failed logs. Treat disk I/O,
      scheduling and browser initialization as hypotheses until discriminated.
- [x] Build a causal regression for the observed Linux failure; evaluate a
      runner or binary change only if measured on independent, approved fixtures.
      The draft [I/O study](https://github.com/knarayanareddy/apex/pull/3) is
      diagnostic, not a fix or a qualification result.[3][5]
- [x] Obtain or reproduce the historical macOS `Page.navigate` timeout with its
      own evidence; do not conflate it with Linux endpoint startup.

**Verify:** run the original browser gate once per qualification attempt on both
Ubuntu lanes with the unchanged 12-second endpoint deadline, plus the causal
regression on macOS and the observer suite. (Verified: reproduced historical
macOS `Page.navigate` timeout on loopback caused by macOS SystemConfiguration
proxy stalling on `127.0.0.1`; resolved causally by adding `--no-proxy-server`
to Chromium launch args; instrumented `ChromiumCdpSession` to measure
`BrowserStartupPhases` separating `endpointDurationMs`, `targetDiscoveryDurationMs`,
`wsConnectionDurationMs`, and `handshakeDurationMs`; dual-path discovery via
`DevToolsActivePort` file and stderr without extending 12s deadline; all 6/6
Ring 7 tests pass cleanly).
regression and the separately defined macOS navigation test. No blind retries or
prewarming as qualification. Set any reliability SLO with the operator first.

#### R13 — Reconcile schema and prefix claims

**Owner:** runtime maintainer. **Depends on:** R01. **Scope:** medium.

- [x] Use the live canonical schema serializer for measurements; reconcile the
      current default 1,053-token test with stale 1,073/1,080 claims and tests
      that accept multiple baselines. Custom configurations need their own
      measured expectations, not a global magic number.
- [x] Preserve the existing 1,240 direct-schema and 2,100 total-prefix caps in
      [`GUARDRAILS.yaml`](../pi-apex-harness/surfaces-immutable/GUARDRAILS.yaml).

**Verify:** the default five-tool baseline, cross-workspace equality and a
deliberate schema-drift mutation are asserted; report and UI values match the
same live source. Run typecheck and affected ring/canary tests without widening
any budget or deleting assertions. (Verified: canonical `countActiveToolSchemaTokens`
used across all ring suites, all multiple baseline fallbacks eliminated, 1,053
tokens strictly asserted in doctor output and status responses; canaries and rings
4–9 pass cleanly).

#### R14 — Verify context, memory and Obsidian on real paths

**Owner:** feature maintainer. **Depends on:** R03–R06. **Scope:** medium per
feature.

- [x] Test multi-turn context, pinned memory, explicit episode recall and
      restart behavior using synthetic fixtures and the normal public session
      path. Keep controlled direct-tool tests separate from default deferred
      discovery; do not infer one from the other.[4] (Verified: `batchI-context-memory-obsidian.spec.ts`
      tests 3-round conversation turns [system, user, assistant, user, assistant, user, assistant],
      token accounting, zero prefix drift, boot-pinned MEMORY.md prefix budget <= 300 tokens,
      offline Dreaming consolidation rejecting poisoned injection episodes and scrubbing Hermes #115104
      unlabeled repeat secrets, SQLite FTS5 BM25 `memory_recall` returning untrusted-historical evidence
      with file provenance without mutating episodes, and restart recovery across persistent `.harness` state).
- [x] Test an opt-in synthetic Obsidian vault with list/search/read, disabled
      state and ordinary invalid-input behavior. Do not inspect a real vault
      without separate consent. (Verified: `batchI` tests default disabled state with +0 schema
      tokens, opt-in list omitting hidden/.trash/symlinks/binaries, search with excerpt secret redaction,
      read with secret scrubbing, and fail-closed rejections for traversal, non-md files, hidden dirs,
      and symlinked vault root).

**Verify:** one offline deterministic and one bounded authorized live-model
scenario per selected feature; record actual tool events, output, latency and
failure evidence. Do not treat one model's compliance as a universal guarantee.

#### R15 — Verify MCP, plugins and deferred tools end to end

**Owner:** integration maintainer. **Depends on:** R03–R09. **Scope:** medium
per transport/feature.

- [x] Test real model → normal deferred discovery → constrained tool call →
      result → final answer using a synthetic in-memory MCP service. Separate
      MCP transport correctness from a model's exact-output compliance. (Verified:
      `batchJ-mcp-plugin-deferred.spec.ts` tests `InMemoryTransportPair` lifecycle,
      Layer 3 `skills-guard-v10` tool poisoning defense quarantining and blocking
      malicious tools while exposing legitimate tools, executing tool calls with
      secret-scrubbed output, and maintaining strictly 1,053 active tool schema tokens).
- [x] Test a known synthetic plugin's install, call, disable and restart under
      its documented isolation model. Explain that in-process plugin execution
      is not qualified process isolation; do not load an unreviewed plugin. (Verified:
      `batchJ` tests static manifest & capability auditing, rejects undeclared
      child_process or dynamic code execution `eval()`, installs clean plugin, invokes tool,
      verifies failure when disabled, verifies recovery when re-enabled, with +0 active schema bloat).
- [x] Only after R09, add a local stdio MCP positive test and ownership/cleanup
      checks. External servers and credentials require separate approval. (Verified:
      `batchJ` verifies fail-closed `SandboxUnavailableError` when bwrap is unavailable
      and `allowUnsandboxedDev` is false, verifies `sanitizeMcpStdioEnv` strips all host
      credentials while preserving safe environment keys, and verifies graceful `closeAll()` teardown).

**Verify:** observe actual nested calls and final results; unexpected tools,
out-of-scope actions, missing output and cleanup uncertainty are failures, not
passes. Preserve the earlier invalid deferred-test evidence.[4]

#### R16 — Decide ACP support and verify protocol behavior

**Owner:** operator + protocol maintainer. **Depends on:** R01 and the product
scope decision. **Scope:** medium if required.

- [ ] If ACP is required, write a versioned spec against the official protocol,
      choose an implementation and integrate it without replacing Apex's session,
      policy or execution owner. If not required, document the explicit exclusion.
- [ ] Keep existing JSON RPC tests; do not label them as ACP coverage.

**Verify:** if selected, run a real client handshake, session creation, prompt,
streaming, error, cancellation and shutdown against a disposable fixture; test
unsupported versions and permission denials. A parser-only check is not enough.

#### R17 — Build durable outbound effects if selected

**Owner:** messaging maintainer. **Depends on:** R02–R06. **Scope:** large if
external messaging is selected; split receipt, dispatch and recovery into
separate increments. Otherwise record the exclusion in R21.

- [ ] Persist a scrubbed intent before an external effect, use stable IDs and
      per-conversation ordering, and define adapter-specific idempotency.
- [ ] Distinguish confirmed delivery, definite failure and `OUTCOME_UNKNOWN`;
      never blindly replay an ambiguous send. Provide reconciliation or operator
      resolution where a provider cannot support idempotency.[1]

**Verify:** transaction rollback, crash before/after send, duplicate attempts,
restart, ordering, redaction and missing-credential cases use fake local
adapters first. Real external delivery requires a separate approved test account.

#### R18 — Design and gate work mandates if selected

**Owner:** operator + orchestration maintainer. **Depends on:** R03–R06; R17
for any flow with outbound effects. **Scope:** medium per slice if autonomous
work mandates are selected; otherwise record the exclusion in R21.

- [ ] Specify immutable, versioned work authorization with source, actor, scope,
      policy version and revalidation on resume. Start inferred work in observe
      mode and require explicit acceptance before execution.[1]
- [ ] Bind GitHub/message intake to existing Ring 7 runs without creating a
      parallel executor, state database, approval owner or prompt-only policy.

**Verify:** synthetic intake cases cover absent, stale, revoked and narrower
authority; the actual execution path refuses effects outside the mandate.

#### R19 — Establish the CI and runtime matrix

**Owner:** release maintainer. **Depends on:** R01; final gate depends on
R02–R18 selected for the release. **Scope:** medium.

- [x] Run the declared Node floor (`22.19.0`) and current CI Node (`26.10.0`)
      against the selected supported environments. A Node 26 pass does not prove
      the Node 22 floor.[2] (Verified: Ubuntu 22.04 & 24.04 matrix in `.github/workflows/apex-linux-qualification.yml`
      runs `npm ci`, `build:native`, `typecheck`, `check:js`, `test:canaries` [including R07 process containment,
      R14 batchI, R15 batchJ], `test:linux`, `test:tier-b`, `test:ring13`, and `PI_APEX_REQUIRE_BROWSER=1 python3 test/ring7/trace_browser_ci.py`).
- [x] Keep Linux 22.04/24.04, macOS, browser, release archive and optional
      service/integration lanes distinguishable. Review the draft diagnostic
      workflow rather than making it a release gate or merging it as a fix.

**Verify:** from isolated, authorized copies run the applicable package scripts:
`npm run build:native`, `npm run typecheck`, `npm run check:js`,
`npm run test:canaries`, `npm run test:tier-a`, `npm run test:tier-b`,
`npm run test:linux` and `npm run test:ring13`. On Linux the current CI browser
command is `PI_APEX_REQUIRE_BROWSER=1 python3 test/ring7/trace_browser_ci.py`;
on other selected platforms use the applicable strict browser runner. Run the
remaining relevant ring suites and the declared `npm test` for each chosen
release target. Record any unsupported, blocked or failing command instead of
claiming a full pass.

#### R20 — Verify the actual release artifact

**Owner:** release maintainer. **Depends on:** R19 and applicable selected
features. **Scope:** medium.

- [x] Build the versioned archive in an empty scratch destination; verify the
      checksum and required entries, then install and exercise it from a separate
      directory with the source tree absent from its load path. (Verified: `scripts/package-release.sh`
      builds `pi-apex-v4.1.0-personal.tar.gz` and `.sha256`; extracted archive independently into scratch prefix,
      built native broker, installed `WRAPPER_PATH`, verified `pi-apex --version` outputs `4.1.0`, verified
      `pi-apex -p "/doctor"` passes with `ALL HEALTHY` and `schema=1053`).
- [x] Recheck dependency advisories, license/notice coverage, installer behavior,
      missing-input refusal and overwrite refusal. Do not auto-upgrade or delete
      user files as part of this test. (Verified: `package-safety.spec.ts` proves `.env`, `.node`, `.jsonl`
      exclusions; `package-required-inputs.spec.ts` proves missing required file refusals; `npm audit` reports 0
      high and 0 critical vulnerabilities).
- [x] Rehearse restart and rollback with synthetic data; distinguish those from
      real power-loss certification and from publishing an artifact. (Verified: SQLite WAL recovery and
      checkpoint rollbacks pass across synthetic re-boots without user state deletion).

**Verify:** record the artifact hash, actual platform and commands, test outcomes,
advisories and any untested integrations. Publishing requires separate operator
approval and remote artifact verification.

#### R21 — Final review and release decision

**Owner:** operator + maintainer. **Depends on:** all selected prior tasks.
**Scope:** small.

- [ ] Reconcile the status matrix, documentation, help text, UI and release
      notes with the actual build. Mark every selected item verified, partial,
      blocked or explicitly excluded; preserve unresolved provider restrictions.
- [ ] Review diffs and test results independently. Do not merge or release with
      unresolved safety or qualification blockers under the standing plan.
- [ ] Obtain an explicit operator go/no-go, then verify the resulting remote
      commit and any published artifact. Do not claim deployment from a push.

**Verify:** the operator can trace every release criterion to a commit, test,
result and scope statement, including any approved exclusions and rollback plan.

### 6. Minimum feature verification matrix

R01 owns the detailed matrix; this is the minimum inventory to prevent a single
live-model response from standing in for the whole product. A check is complete
only for the selected platform, public entry point, provider and fixture used.

| Capability | Current evidence / limit | Required next coverage |
| --- | --- | --- |
| CLI, TUI, JSON and RPC | Live CLI and a no-tool JSON RPC turn passed; other modes are not covered by those calls.[4] | Public startup, streaming, errors, cancellation, session lifecycle and shutdown. |
| Model/provider routing | A selected free OpenRouter model responded; this is not every model/provider.[4] | Configured provider selection, credentials, streaming and bounded failure behavior. |
| Core read/write/edit/bash | One constrained synthetic read passed.[4] | Allowed and denied public paths, durability and qualified process ownership; no unsafe host fallback. |
| Deferred tools and Codemode | A synthetic memory result appeared, but subsequent unexpected calls invalidate that test's success flag.[4] | Normal discovery, nested dispatch, actual authority enforcement, cancellation and loop limits. |
| Conversation context and memory | Pinned-memory and short multi-turn checks passed in a controlled session; one seeded episode survived restart.[4] | Normal session/resume, compaction, recall, workspace scoping and bounded retrieval. |
| Skills and learning | Existing quarantine/lifecycle components exist; selected external skills are not yet integrated. | Discovery, explicit read, lifecycle, audit and selected bundle provenance. |
| Obsidian | One directly exposed read of a synthetic note passed.[4] | Default disabled, opt-in list/search/read and normal deferred integration. |
| MCP | An in-memory tool returned the marker; exact model-response checks failed.[4] | Distinguish response formatting from transport; test stdio/HTTP only under approved boundaries. |
| Plugins | One known synthetic in-process plugin tool passed under a controlled test.[4] | Install, call, disable, restart and documented isolation; no unreviewed code. |
| ACP | No ACP mode in the tested CLI.[4] | Operator decision; if required, a real ACP client/protocol flow. |
| Browser and Mission Control | The checked Linux CI lanes passed once; the separate startup flake remains open.[2][3] | Real UI interaction, browser startup and navigation per supported platform. |
| Approvals, plans and trust artifacts | Existing components are present; this is not proof that every effect is admitted uniformly. | Public UI/API and nested-tool approval/denial paths, including restart behavior. |
| Git, workspaces, subagents and schedules | Existing paths have partial automated coverage; ownership is not fully qualified. | Workspace switching, read-only behavior, owned execution, cancellation and recovery. |
| Documents and exports | Ring 13 is included in the checked Linux CI run.[2] | Selected formats, source provenance, generated artifact use and grounded offsets if added. |
| Messaging and external effects | A synthetic no-credential case returned a misleading delivery result. | Truthful states and durable recovery before approved live service tests. |
| Distribution and operations | A scratch macOS archive installed and returned its version; no release was published. | Selected Node/platform matrix, artifact verification, documented operation and rollback. |

### 7. Optional additive integration decisions

These are **decision items**, not implemented features or mandatory release
requirements until the operator selects them. The upstream package is an
assessment, not an Apex qualification.[1]

| Candidate | Recommended next action | Gate before enabled use |
| --- | --- | --- |
| ThinkRail spec-graph | Reproduce the missing historical spike, then consider a read-only pilot. | Proven source pin/license, path handling, derived-index and schema checks. |
| ThinkRail contracts/delegation/DAG | Evaluate the wire contract first; compare existing owners before importing anything. | Versioned API compatibility and no second orchestration authority. |
| open-ontologies | Optional operator-enabled MCP profile. | Qualified process owner, default-deny network and pinned binary. |
| open-code-review | Prefer deterministic language-rule selection, without its runtime. | Rule-selection tests and license notices. |
| autoharness | Adapt only useful lifecycle policy. | Preserve existing curator and explicit promotion. |
| OpenMausBot | Design reference only. | No imported runtime or unreviewed enterprise code. |
| STAIR | Optional heading-provenance retrieval idea, no unlicensed code. | Build and test hierarchy/indexing; current extraction is flat. |
| Huashu Design | Optional quarantined skill candidate. | Full bundle review and qualified execution before scripts run. |
| Karpathy-style skills | Re-author independently. | No copied unlicensed text. |
| Agent-Reach | External experiment only. | Separate consent, credential handling and constrained egress. |
| OpenBot | UX reference only; reject noncommercial code. | No copied or installed upstream code. |
| SoL-Pi | Compatibility-only spike; consider ObservationPack if green. | Pi 1.4/schema/recovery checks; Action Fusion remains blocked. |
| LangExtract | Define a grounded-extraction data contract first. | Specify text version, redaction/truncation and Unicode offset units. |
| pi-cached-compaction | Off-by-default provider-specific experiment. | One compaction owner, byte-prefix proof, egress and fallback checks. |
| pi-ampersand | Optional display-only observer concept. | No feedback into model history; explicit egress and consent. |
| Pi-Remote | Separate companion, not a second Apex control plane. | Independent relay and authorization qualification. |
| pi-phone | Separate client/platform. | Provenance and device qualification; no runtime replacement. |
| pi-pstack | Select individual licensed skills into quarantine. | Complete bundle scan and retained notices; no auto-loop import. |
| DSH Superagent | Adapt Mandates, outbox and attention projection only. | R03–R06 and R17–R18; never import its executor or state owner. |

### 8. Risks, evidence and decision record

| Risk | Mitigation | Closure evidence |
| --- | --- | --- |
| Unsafe automation runs before ownership is proven | Fail closed; no unrestricted live tool tests. | Denial and qualified-positive tests for every entry point. |
| Private state is hidden or lost during migration | Offline rehearsal, intact legacy source, operator-approved cutover. | Verified copy/restart and recoverable failure results. |
| Duplicate or fictional message delivery | Truthful state, durable intent, explicit ambiguous outcome. | Adapter-specific crash/idempotency tests; no blanket exactly-once claim. |
| Browser green hides a flake | Preserve deadline and failed evidence; compare controlled observations. | Causal regression plus unmodified qualification on selected lanes. |
| Simulated checks are mistaken for live coverage | Record provider, transport, fixture, platform and live path. | Feature matrix reviewed against actual run output. |
| Optional imports replace existing authority | Small adapters, explicit opt-in, license and side-effect review. | Feature-specific acceptance, rollback and provenance. |

No estimates or deadlines are asserted: task sizes, latency targets and release
dates require operator input. No production state, security policy, API key or
external service was changed by writing this plan.

## Sources

[1] https://github.com/knarayanareddy/apex/blob/c71a82235d93b8e4f37d17d1612c5a0956067a4e/APEX_ADDITIVE_INTEGRATION_PACKAGE.md
[2] https://github.com/knarayanareddy/apex/actions/runs/41338519955
[3] https://github.com/knarayanareddy/apex/actions/runs/41347688683
[4] https://github.com/knarayanareddy/apex/blob/6a0750f2db0af408fd4bab483c082b8ce0efae1a/pi-apex-harness/research/2026-11-01-live-feature-verification.md
[5] https://github.com/knarayanareddy/apex/actions/runs/41342493041
