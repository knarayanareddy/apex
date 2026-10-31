# 0001. Separate the private control plane from workspace files

- **Status:** proposed
- **Date:** 2026-10-30

## Context and decision

The workspace and `.harness` currently share a filesystem. A post-scan hardlink
can expose private data through another workspace name. The operator chose a
dedicated persistent filesystem; actual volume and migration details require
verification before deployment.

## Alternatives

| Option | Reason not selected |
| --- | --- |
| Repeated inode scans | Scan-to-use races remain. |
| Read-only bind mount | It does not create a private filesystem or hide aliases. |
| Volatile-only spills | Recovery references can outlive their data. |

## Consequences

Startup must verify the actual workspace/mount topology and fail closed if the
boundary is missing or exposed. Existing SQLite/WAL, sessions and spills need
an offline, non-destructive migration and restart verification. `st_dev` checks
at two directory roots alone do not exclude nested mounts of the private device.
Mounting the dedicated filesystem at the existing `.harness` pathname may retain
current session and spill references, but must be verified on both platforms;
mounting over an existing directory hides its old contents. Only an isolated
test-image mount was authorized; no production mount or migration is authorized.
Do not assume the sandbox mount topology is a frozen snapshot: upstream
Bubblewrap 0.9 [marks `/` recursively slave during setup](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L3077-L3081),
so host-to-sandbox mount propagation needs an actual test for the installed
build and mount layout.
Filesystem separation blocks cross-device hardlinks, not reads or copies by an
arbitrary unsandboxed process running as the same UID. Linux enforcement also
needs a stable private mount view and descriptor-relative no-cross-mount I/O;
the current topology inspector is not such a boundary. A qualified Darwin
equivalent or a Linux VM is still needed before claiming the same guarantee.
Revisit after a verified alternative supplies equivalent kernel isolation and
durable recovery.
