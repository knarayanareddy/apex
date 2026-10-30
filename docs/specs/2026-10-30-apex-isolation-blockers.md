# Apex isolation blockers

**Status:** in progress
**Date:** 2026-10-30

## Problem

An injected post-scan hardlink lets the confined reader access a synthetic
foreign spill. The current process-tree cleanup cannot prove detached
descendants terminated. Chromium sometimes fails to publish its DevTools port
within the unchanged 12-second deadline; a single successful CI run does not
establish a fix.

## Decisions

- The operator chose a persistent filesystem separate from the workspace for
  private control-plane data. Its actual path and provisioning are not yet
  confirmed; do not mount, overwrite, or migrate a user's data automatically.
- Refuse execution when guaranteed process containment is unavailable. A
  qualified Linux VM or supervisor is required for that guarantee on macOS.
- Preserve the existing 12-second browser deadline and browser assertions.

## Acceptance criteria

- [ ] An actual concurrent hardlink attempt cannot expose private state through
  either the read tool or a running shell; the test exercises the kernel
  boundary, not only a mocked scan.
- [ ] All private state, including SQLite/WAL, sessions and spill files, uses the
  verified separate filesystem. Reject missing, same-device, exposed nested-mount,
  symlinked or unverified storage before creating or opening state.
- [ ] Migration is explicit, offline and non-destructive: preserve legacy files;
  verify SQLite/WAL, session and spill data and references after restart before
  switching. A failed migration must leave the original usable.
- [ ] Real execution is refused before dispatch whenever the required kernel
  ownership boundary is absent. `setsid`/reparent fixtures under a disposable
  Linux owner must be gone after cancellation and parent death; a PID snapshot
  or process group is not proof.
- [ ] The real browser qualification passes on both Linux lanes under the same
  12-second deadline, backed by a causal regression for any startup change.
- [ ] Existing relevant assertions remain covered; macOS denial, Linux behavior,
  restart recovery and physical power-loss evidence are reported separately.

## Non-goals and rollback

No host security-policy changes, user data deletion, blind browser retries or
claim of physical power-loss certification. Roll back code separately from state:
never discard either legacy or migrated data as part of rollback. Exact volume
location, durable provisioning, mount topology and migration handoff remain open.
