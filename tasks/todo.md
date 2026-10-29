# Apex remediation and qualification

## Security
- [ ] **Shell control-plane isolation:** bwrap arguments now mask `.harness`, and authorized read remains usable; Linux execution is unverified. Address possible external hardlink aliases and move pairing credentials outside the workspace before closing.
- [ ] **Nested Git isolation:** deep and formerly skipped directories are scanned, failures and limits fail closed, and generated masks pass focused tests. Verify actual bwrap masking on Linux.
- [ ] **Pairing-file safety:** credentials now use a private out-of-workspace agent directory and descriptor-relative atomic replacement; a real-server leaf-symlink canary passes. Linux verification and adversarial replacement-race testing remain open. Legacy workspace pairing files are not removed automatically.
- [x] **Malformed raw WAL:** preserve corruption evidence and classify it as corrupt on later startups without re-executing effects. Batch 7 and A test malformed, missing and valid receipts.
- [x] **HTTPS cookies:** every issuance route and logout use `Secure` when any trusted HTTPS origin is configured; spoofed forwarding headers cannot downgrade it. This conservative policy also affects local HTTP sessions while an HTTPS origin is configured.
- [ ] **Process ownership:** userspace cleanup now reports unverified even when its observed snapshot clears. Detached processes may still survive; kernel-backed ownership and atomic PID identity remain unverified.

## Quality and verification
- [x] **Read-tool spill wiring:** current session is passed and sessionless/foreign reads denied; existing live-tool canary covers this. Shell isolation remains open above.
- [ ] **Exact schema token invariant:** measure current runtime, choose and enforce one documented contract without weakening budget or drift checks.
- [x] **JavaScript inventory gate:** missing or unclassified files fail; both cases are tested and the gate runs in Linux CI. Dependency and generated directories are explicitly excluded.
- [x] **Linux CI exists:** two Ubuntu lanes include security, confinement, Tier B, and document gates; this does not establish complete qualification.
- [ ] **Linux and browser qualification:** run gates on final changes; resolve intermittent 12-second Chromium startup failure causally. Historical macOS `Page.navigate` timeout is separate.
- [ ] **Remaining release evidence:** qualify applicable Redis/chaos, macOS, live-provider and release-artifact paths; distinguish restart testing from physical power-loss evidence.

## Current local evidence
- Isolated macOS scratch copy: `npm run test:canaries` and `npm run typecheck` passed with the current remediation changes.
- `test:control-plane` proved the old mask/discovery checks red and the new argument checks green; it does not execute Linux bwrap.
- Tier B now includes actual bwrap tests for pairing, foreign spills, and a depth-eight Git blob. Those tests have not run on Linux with these changes.
- Browser observer edits predate this remediation and remain separate, unfinished working-tree changes.
