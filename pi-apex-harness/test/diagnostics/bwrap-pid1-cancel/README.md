# Throwaway bwrap PID-1 cancellation proof

This directory is an isolated proof harness, not production code. It does not
modify bwrap-sandbox, assertions, host security settings, or repository data.

## Linux run (not run on this macOS host)

On a disposable Linux test host with `bwrap`, `cc`, Python 3, procfs, and
unprivileged user namespaces available, from this checkout root run:

```sh
python3 test/diagnostics/bwrap-pid1-cancel/run.py
```

The program compiles the local `pid1_supervisor.c` into a temporary directory,
then runs bwrap with a fresh user/PID namespace. It read-only binds only the
test-owned supervisor, the temporary identity-socket directory, and host
`/usr`, `/bin`, `/lib` (plus optional `/lib64`) at explicit paths. All binds
exist only in bwrap's new mount namespace; the runner does not alter host
mounts, security settings, or network. The bwrap child receives the read end of
the test-owned pipe as descriptor 3; its parent retains the sole writer.
`--sync-fd 3` carries the descriptor to the
test supervisor, which runs as namespace PID 1.

The supervisor forks a marked `/bin/sh` child, closes fd 3 before `setsid()`
and `exec`, and emits output larger than ordinary pipe capacities to both
stdout and stderr. The parent drains both streams concurrently. The child
connects to a private test-owned Unix socket before exec; the host listener
captures its PID via Linux `SO_PEERCRED`, checks the peer UID, and records only
that PID's start time, boot ID, PID-namespace identity, session ID, and `NSpid`
chain. The parent then observes only that captured `/proc/<pid>` identity—no
host-wide process or command-line enumeration. It checks that identity's open
descriptors against the control pipe inode, closes only its own writer, and
verifies the same identity is gone or a zombie within four seconds, before the
shell's 20-second finite fallback. The monotonic clock starts immediately
before `posix_spawn`; all success evidence must be observed strictly before
`spawn_start + 15s`, preserving a five-second margin before the earliest
possible natural completion (`spawn_start + 20s`). No PID or process group is
ever signalled. Cleanup on assertion failure closes the control writer, joins
the socket thread for at most four seconds, then waits for bwrap for at most 26
seconds (`20s` finite child lifetime plus `6s` allowance): a programmed total
cleanup bound of 30 seconds, excluding OS scheduling delays. The supervisor's
`waitpid` loop provides a non-signal cleanup path. The temporary fixture is
removed only after proof success, bwrap reaping, and server-thread shutdown.
On failure it is retained and its path is printed; primary and cleanup errors
are reported separately so cleanup cannot replace the original assertion.

The parent rechecks that the captured child identity is alive immediately
before closing the writer. PID 1 reports control EOF with `CONTROL_FD_EOF` and
exit status 0; if its child exits first (including the finite fallback), it
reports `NATURAL_CHILD_EXIT` and returns status 42. Parent success requires the
EOF marker, status 0, no natural-exit or child-natural-completion marker, the
captured child gone, and a final observation before the `spawn_start + 15s`
cutoff.

The first draft's failures are retained as review evidence in this note: it omitted
the rootfs binds needed to execute the supervisor and shell, and used a
host-wide `/proc/*/cmdline` scan. Both were blockers, not passing evidence; the
runner now supplies explicit read-only mounts and uses `SO_PEERCRED` instead.
No Linux run was made before or after those corrections.

A later review found another false-pass path: the original supervisor used the
same zero exit for natural child exit and control EOF, with no last-moment
liveness check. The current code distinguishes them with status 42 plus
`NATURAL_CHILD_EXIT`, checks liveness immediately before close, and requires
the EOF-specific marker in the parent. The synthetic control exercises the
parent predicate only; it does not prove the Linux scheduling/kernel path.

Natural supervisor/leader exit and parent-death are intentionally not separate
test cases. The former would need additional reaper/descendant cases to avoid
mistaking ordinary exit for kernel cancellation; the latter adds a parent-death
race and does not strengthen the control-EOF claim.

## macOS-safe checks

Only the pipe EOF semantics are platform-independent. Run that control without
invoking bwrap:

```sh
python3 test/diagnostics/bwrap-pid1-cancel/run.py --pipe-control-only
```

This forks a test-owned child holding a pipe writer, closes the parent's
writer, verifies EOF is withheld until the child closes its copy, and reaps the
child without signals. It does not test descriptor passing through bwrap,
PID-namespace behavior, or Linux kernel cancellation.

The synthetic negative classifier control also runs without bwrap:

```sh
python3 test/diagnostics/bwrap-pid1-cancel/run.py --classifier-control-only
```

It exercises the same success predicate used by the Linux runner and verifies
that a natural-exit status/marker, a missing EOF marker, a still-live captured
identity, or an observation at/after the cutoff cannot count as cancellation
success. This is a logic control, not evidence of kernel behavior.

The portable evidence-lifecycle control verifies that a synthetic primary
assertion remains available alongside cleanup errors, failed fixtures remain
present, and fixture removal is refused until owned shutdown is confirmed:

```sh
python3 test/diagnostics/bwrap-pid1-cancel/run.py --evidence-control-only
```

Current status for this host: **green** Python AST and C syntax/warning checks;
**green** inherited-writer, natural-exit, and evidence-lifecycle portable
controls; **not run / no Linux result** for the bwrap/PID-namespace integration.
Do not interpret the local green checks as a green kernel-cancellation result.

## Source basis and limits

The descriptor claim is tied to bubblewrap v0.9.0 `bubblewrap.c`, the
`--sync-fd` and `--as-pid-1` option documentation / handling (including the
source range cited in the task):
<https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c>

The expected kernel consequence is documented by Linux `pid_namespaces(7)`:
termination of the PID namespace init causes the kernel to send SIGKILL to all
processes in that namespace:
<https://man7.org/linux/man-pages/man7/pid_namespaces.7.html>

Static source review and the portable pipe control do not establish that a
particular bwrap build passes fd 3 as expected, that PID 1 exits on EOF in the
integrated setup, or that the running kernel enforces namespace teardown. Those
claims remain **unverified until the exact Linux command above passes**. This
proof is intentionally not a substitute for a production cancellation design.
