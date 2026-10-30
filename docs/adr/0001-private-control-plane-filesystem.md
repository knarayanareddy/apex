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
mounting over an existing directory hides its old contents. No live mount or
migration has been authorized yet.
Revisit after a verified alternative supplies equivalent kernel isolation and
durable recovery.
