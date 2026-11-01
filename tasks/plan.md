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
