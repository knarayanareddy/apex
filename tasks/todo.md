# Apex remediation and qualification

## Security
- [ ] **Shell control-plane isolation:** bwrap masks `.harness`; local checks reject pre-existing aliases but a controlled post-scan hardlink still bypasses reads. The operator selected persistent separate-filesystem state; validate mount topology and migrate without deleting old data before closing.
- [ ] **Nested Git isolation:** deep and formerly skipped directories are scanned, failures and limits fail closed; a depth-eight object was masked in both Linux Tier B lanes. Further audit of alternate paths and concurrent mutation remains open.
- [ ] **Pairing-file safety:** credentials use a private out-of-workspace agent directory and descriptor-relative atomic replacement; real-server leaf-symlink canaries passed on macOS and both Linux lanes. A controlled macOS destination-swap probe preserved the external file but replaced the raced symlink; automated and Linux race tests remain open. Legacy workspace pairing files are not removed automatically.
- [x] **Malformed raw WAL:** preserve corruption evidence and classify it as corrupt on later startups without re-executing effects. Batch 7 and A test malformed, missing and valid receipts.
- [x] **HTTPS cookies:** every issuance route and logout use `Secure` when any trusted HTTPS origin is configured; spoofed forwarding headers cannot downgrade it. This conservative policy also affects local HTTP sessions while an HTTPS origin is configured.
- [ ] **Process ownership:** the operator selected refusal when a kernel-owned boundary is unavailable. Apply the same denial before WAL dispatch and to shell, PTY and cron; retain existing positive assertions on a qualified Linux boundary. Detached processes may still survive; kernel-backed ownership and atomic PID identity remain unverified.

## Quality and verification
- [x] **Read-tool spill wiring:** current session is passed and sessionless/foreign reads denied; existing live-tool canary covers this. Shell isolation remains open above.
- [ ] **Exact schema token invariant:** a canary pins the default five-tool schema to 1,053 tokens across two workspace paths and detects schema drift; a mutation changed the count to 1,061 and failed the canary. E2E-2 now measures its live schemas; a controlled report mutation changed its reported count from 1,053 to 1,063. Reconcile historical 1,073 claims and multiple allowed values in other tests without weakening budget or drift checks.
- [x] **JavaScript inventory gate:** missing or unclassified files fail; both cases are tested and the gate runs in Linux CI. Dependency and generated directories are explicitly excluded.
- [x] **Linux CI exists:** two Ubuntu lanes include security, confinement, Tier B, and document gates; this does not establish complete qualification.
- [ ] **Linux and browser qualification:** run gates on final changes; resolve intermittent 12-second Chromium startup failure causally. Historical macOS `Page.navigate` timeout is separate.
- [ ] **Remaining release evidence:** qualify applicable Redis/chaos, macOS, live-provider and release-artifact paths; distinguish restart testing from physical power-loss evidence.

## Current local evidence
- Isolated macOS scratch copy: `npm run test:canaries` and `npm run typecheck` passed with the current remediation changes.
- `test:control-plane` proved the old mask/discovery checks red and the new argument checks green; it does not execute Linux bwrap.
- GitHub run `40961275401` at `4c6fcb2` passed security canaries, Linux confinement, Tier B, and document sandbox on Ubuntu 22.04 and 24.04; the new actual bwrap tests covered pairing, foreign spills, and a depth-eight Git blob. Ubuntu 24.04 browser qualification passed; Ubuntu 22.04 failed Chromium startup at the unchanged 12-second deadline.
- GitHub run `41056241787` at `be25961` passed both Ubuntu lanes, including the new static hardlink checks and browser qualification. This single green run does not establish that concurrent-hardlink races or intermittent browser startup are fixed.
- GitHub run `41130120768` at `6d32223` passed Ubuntu 24.04 and failed Ubuntu 22.04's required browser startup deadline. Fresh Ubuntu 22.04 probes started Chromium in 4,967 ms and Chrome in 8,281 ms, while both post-failure binaries timed out on the qualification runner. Separate runners do not establish a unique cause; the one-shot diagnostics are not automatically retried.
- The Linux natural-leader-exit diagnostic could not establish a result because scanning `/proc/882/ns/pid` returned `EACCES` during cleanup and obscured any prior assertion. A corrected one-shot probe uses an owned Unix-socket peer identity instead of scanning unrelated processes. Parent-death and cancellation remain unqualified.
- The Linux cross-device fixture confirmed same-device hardlink creation and cross-device `EXDEV`. It used volatile `/dev/shm` and does not implement or validate persistent state migration.
- A scratch-only fail-closed prototype denied uncontained shell, PTY and cron execution and recorded the live WAL refusal as `ABORTED_CLEAN`. Four existing macOS canary commands still expect the former uncontained fallback and fail under that policy; no assertions have been removed and the prototype is not deployed.
- Browser observer edits predate this remediation and remain separate, unfinished working-tree changes.
