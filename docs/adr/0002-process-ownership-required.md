# 0002. Require a kernel-owned execution boundary

- **Status:** proposed
- **Date:** 2026-10-30

## Context and decision

Parent/child snapshots and process groups cannot contain reparented or `setsid`
descendants. The operator chose to refuse execution if a qualified ownership
boundary is unavailable, rather than retaining an unverified host fallback.

## Alternatives

| Option | Reason not selected |
| --- | --- |
| PID enumeration and process-group signaling | Descendants may escape; PID checks are not atomic. |
| Explicit uncontained host fallback | Cannot meet the requested guarantee. |

## Consequences

macOS host execution requires a separately qualified VM or supervisor. Linux
namespace or cgroup behavior must be tested through real execution, including
parent death and cancellation, before claiming ownership. Existing unsafe-mode
tests must not be silently dropped; replace any obsolete expectation with a
denial assertion and retain the corresponding positive behavior on a qualified
Linux boundary. Revisit if a verified portable ownership mechanism becomes
available.
