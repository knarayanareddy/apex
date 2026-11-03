# Apex remediation plan

This is proposed work, not completed work. Findings: [REVIEW.md](REVIEW.md). Keep autonomous execution restricted pending owner acceptance. Commands are **planned**, not executed; use approved disposable environments.

## Phase 0 — establish a reproducible baseline

**T0 — baseline and scope** (preventive; prerequisites: owner-approved isolated Linux host, pinned revision). Observed paths: `pi-apex-harness/package.json`, `.github/workflows/apex-linux-qualification.yml`.
1. Record SHA, Node, OS, namespace support, mounts and credentials policy; separate the nested projects.
2. On disposable Linux, install locked dependencies; run existing `npm run build:native`, `npm run typecheck`, `npm run test:canaries`, `npm run test:linux`, and `npm run test:browser` when prerequisites permit.
3. Reproduce APX-01 and APX-02 with synthetic state; redact logs.

**Deliverable/verification:** revision-bound baseline matched to exit status and assertions. **DoD:** [ ] environment recorded; [ ] tiers pass/fail/skip recorded; [ ] findings reproduced or explicitly blocked.

## Phase 1 — correct confirmed defects

**T1 — fail closed on unknown topology** (APX-01; depends T0). Observed path: `pi-apex-harness/src/core/private-state-boundary.ts`; proposed test path: `pi-apex-harness/test/canaries/private-state-preflight.spec.ts`.
1. Define which topology violations always deny operation and which explicit development exceptions are permitted; never let an unknown device masquerade as separation.
2. Change preflight to reject invalid or incomplete reports, preserving specific diagnostics; ensure any dev override is narrowly scoped and visible.
3. Exercise inaccessible/missing device information, symlinks, exposed nested mounts and valid separate devices through the public preflight and its real callers.

**Deliverable/verification:** corrected validator and regression tests. Deliberately restore the old null-device behavior and verify the test fails, then restore the fix. **DoD:** [ ] unknown topology denied; [ ] valid topology accepted; [ ] override behavior and caller handling verified.

**T2 — make migration receipts truthful** (APX-02; depends T0 and T1). Observed path: `pi-apex-harness/src/core/private-state-boundary.ts`; observed existing test: `pi-apex-harness/test/canaries/batchE-private-state-migration.spec.ts`.
1. Specify separate statuses for source integrity, destination integrity, copied-file hashes and source retention; represent checks not performed as such.
2. Correct dry-run and real-migration receipts; inventory callers before changing the receipt contract, and add compatibility handling if needed.
3. Use synthetic SQLite/WAL, sessions and spills to compare before/after contents; inject copy corruption and interruption and verify rollback leaves pre-existing files untouched.

**Deliverable/verification:** receipt schema and independently compared artifacts. Mutate a copied file and receipt separately; tests must fail. **DoD:** [ ] dry-run never claims destination checks passed; [ ] real copy verifies content and database; [ ] cleanup and retained source observed.

**Phase exit:** regression evidence for both defects; never lower thresholds.

## Phase 2 — secure the actual execution boundary

**T3 — cockpit and sandbox threat tests** (APX-05, APX-06; depends T0, T1). Observed paths: `pi-apex-harness/src/ring5/mission-control-server.ts`, `pi-apex-harness/src/core/bwrap-sandbox.ts`; proposed tests under `pi-apex-harness/test/canaries/`.
1. Trace CLI startup to server binding, token issuance, authentication and every MCP, PR, browser and credential route; enumerate trust transitions for operator input and model/tool output.
2. With synthetic credentials and a disposable workspace, test missing/invalid token, cross-origin requests, replay, malicious tool content, command arguments, egress and unconfined overrides; inspect logs and artifacts for canaries.
3. Fix demonstrated boundary failures, require explicit confirmation for unsafe modes, and document supported host/mode combinations; use negative controls that fail when guards are disabled.

**Deliverable/verification:** route-to-guard matrix and real-path positive/negative tests. **DoD:** [ ] auth verified per sensitive route; [ ] injection and secret tests exercise boundaries; [ ] unconfined modes visibly identified.

**T4 — nested Redis and dependency integrity** (APX-04; depends T0 and owner deployment decision). Observed paths: `metrics-pipeline/docker-compose.yml`, `metrics-pipeline/package-lock.json`, `pi-apex-harness/package-lock.json`.
1. Determine whether Redis is fixture-only or deployed and establish intended network exposure and persistence requirements.
2. For any deployed profile, eliminate unnecessary host publishing or restrict it, authenticate where needed, and select a reviewed immutable image digest; evaluate lockfile advisories and provenance separately per project.
3. In an isolated environment, test both permitted and denied network connections, restart persistence, and dependency/image reproducibility; document unresolved advisories without suppressing gates.

**Deliverable/verification:** owner-approved topology and evidence of actual network behavior. **DoD:** [ ] exposure decision recorded; [ ] dependency and image findings triaged; [ ] relevant access tests observed or deployment explicitly excluded.

## Phase 3 — repeatable qualification and operator experience

**T5 — browser regression gate** (APX-03; depends T0; proposed `.github/workflows/apex-browser-qualification.yml`, observed `pi-apex-harness/package.json`).
1. Agree supported browsers, runner versions and required versus diagnostic tiers; retain the existing one-shot workflow as historical evidence unless owner approves a change.
2. Create a repeatable PR gate covering browser-affecting harness paths, using the existing `test:browser` script after checking its prerequisites; pin actions and preserve least privilege.
3. Introduce a deliberate navigation failure to show the gate turns red, then restore behavior and verify success with recorded browser versions and skips.

**Deliverable/verification:** reproducible CI result on the exact revision, plus negative-control run. **DoD:** [ ] trigger covers agreed changes; [ ] failures propagate; [ ] diagnostic comparison is not presented as qualification.

**T6 — operator UX and accessibility** (preventive; depends T2, T3, T5). Observed paths: `pi-apex-harness/src/ring5/mission-control-server.ts`, `pi-apex-harness/src/ring5/mission-control-ui.ts`.
1. Trace the real UI messages for isolation mode, preflight denial, migration dry-run and approval; define comprehensible, non-secret status text.
2. Test keyboard-only operation, focus, screen-reader labels and failure recovery in a running cockpit; fix only observed issues.
3. Repeat using a non-owner tester and synthetic failed operations; ensure status reflects the actual backend receipt rather than a client-side assumption.

**Deliverable/verification:** observed operator flows. **DoD:** [ ] unsafe mode distinct; [ ] dry-run not presented as restore; [ ] accessibility checks recorded.

## Phase 4 — deployment, recovery and independent acceptance

**T7 — recovery and release rehearsal** (APX-02, APX-04, APX-06; depends T2-T4). Observed paths: `pi-apex-harness/scripts/package-release.sh`, `pi-apex-harness/src/core/private-state-boundary.ts`.
1. Owner chooses backup location, credentials, encryption, retention, recovery objectives, signing and supported deployment platform.
2. In a disposable environment, back up and restore private state onto a separate filesystem, validate SQLite and representative session/spill contents, and measure actual recovery time and data loss.
3. Build the release using the observed `package:release` script, inspect package contents and checksums with synthetic canaries, then rehearse rollback to the previous verified artifact and state.

**Deliverable/verification:** restore log, measured RPO/RTO, provenance and rollback record. **DoD:** [ ] restored application reads state; [ ] canaries absent from artifacts; [ ] previous artifact and state recover.

**T8 — independent acceptance** (preventive; depends T1-T7). Observed paths: all cited paths in [REVIEW.md](REVIEW.md).
1. A reviewer not responsible for fixes traces each changed path from the real entry point and repeats the original reproductions.
2. Run deliberately broken guard, receipt and browser negative controls; confirm tests fail for the intended reason and then pass after restoration.
3. Review CI evidence, authorization matrix, recovery observations and unresolved risk with the owner; record revision-specific acceptance or rejection.

**Deliverable/verification:** signed-off evidence ledger. **DoD:** [ ] dispositions cite evidence; [ ] negative controls demonstrate sensitivity; [ ] owner accepts residual risks.

## Dependency map and release policy

`T0 → T1 → T2 → T6`; `T0 + T1 → T3 → T6`; `T0 → T4`; `T0 → T5 → T6`; `T2 + T3 + T4 → T7`; `T1–T7 → T8`. Phases may overlap only where prerequisites are met.

**Production acceptance:** [ ] APX-01/02 corrected; [ ] security boundaries tested; [ ] selected gates observed; [ ] restore and rollback rehearsed; [ ] accessibility and risks reviewed; [ ] owner approves revision and artifact.

Owner approval is required for credentials, network exposure, unsafe execution, backups, signing, publication and deployment. Release only after acceptance; retain the previous verified artifact and state backup. On failure, stop autonomous work, restore both, observe behavior and document data loss or rollback limits. No deployment or restore is implied.
