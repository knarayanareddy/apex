import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractNativeErrnoCode, getLinuxFsBridge } from "./linux-fs-bridge.ts";
import { openParentDirFdBeneath, openWorkspaceRootFd } from "./safe-path.ts";

export class WorkspaceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLockError";
  }
}

export interface WorkspaceLockPayload {
  lockToken: string;
  pid: number;
  procStartTimeTicks: string | null;
  bootId: string;
  acquiredAtMs: number;
}

export interface WorkspaceLockHandle {
  readonly lockPath: string;
  readonly lockToken: string;
  readonly ownedDev: number;
  readonly ownedIno: number;
  readonly cloexecVerified: boolean;
  /** Re-verifies that our open kernel `flock` descriptor still owns `.harness/workspace.lock`. */
  assertHeld(): void;
  /** Releases the kernel `flock` and closes the descriptor (never unlinking the permanent lock inode). */
  release(): void;
}

export function readSystemBootId(): string {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "non-linux-boot-id";
  }
}

export function readProcStartTimeTicks(pid: number): string | null {
  if (!fs.existsSync("/proc")) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = raw.lastIndexOf(")");
    if (closeParen === -1) return null;
    const rest = raw.slice(closeParen + 2).trim().split(/\s+/);
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reviewer #4 Issue #4 Fix & Programme D4 Concurrency Contract:
 *
 * SUPPORTED CONCURRENCY MODEL: Quiescent Workspace Precondition backed by Cooperative Locking.
 *
 * 1. Cooperative Serialization:
 *    Cooperative harness processes and tools synchronize via kernel-owned exclusive lock
 *    `flock(lockFd, LOCK_EX | LOCK_NB)` on the permanent `.harness/workspace.lock` inode.
 *    Instantaneous 0ms recovery on SIGKILL; zero stale secondary mutex files; prevents concurrent
 *    runs between cooperating harness workers.
 *
 * 2. Quiescent Workspace Precondition & Non-Cooperative Limitations:
 *    Advisory kernel `flock` DOES NOT and CANNOT intercept arbitrary uncooperative external editors
 *    (e.g. Vim, VS Code, or host background scripts mutating files directly) on POSIX filesystems.
 *    POSIX filesystems do not support atomic multi-file tree compare-and-swap without kernel snapshotting.
 *
 * 3. Pre-Mutation Conflict Detection:
 *    Before executing any descriptor-pinned mutation (`unlinkat`, `mkdirat`, `renameat`), the rewind
 *    spine inspects the live path state (`liveNow === expBefore`). If a concurrent external modification
 *    diverged the disk state from the expected baseline, rewind strictly rejects the operation with
 *    `RewindConflictError` to preserve modified data rather than blindly clobbering it.
 *    Concurrent non-cooperative mutations occurring between inspection and syscall execution violate
 *    the quiescent workspace requirement and cannot be atomically resolved by userland POSIX primitives.
 */
export function acquireWorkspaceLock(workspaceRoot: string): WorkspaceLockHandle {
  const bridge = getLinuxFsBridge();
  const { realWs, wsFd } = openWorkspaceRootFd(workspaceRoot);
  const lockRel = ".harness/workspace.lock";
  const lockPath = path.join(realWs, ".harness", "workspace.lock");

  let lockFd = -1;
  try {
    const parentInfo = openParentDirFdBeneath({
      wsFd,
      realWs,
      relPath: lockRel,
      createMissingDirs: true
    });
    try {
      lockFd = bridge.openBeneath(
        parentInfo.parentDirFd,
        parentInfo.leafName,
        fs.constants.O_CREAT | fs.constants.O_RDWR,
        0o600
      );
    } finally {
      if (parentInfo.ownsFd) fs.closeSync(parentInfo.parentDirFd);
    }
  } finally {
    fs.closeSync(wsFd);
  }

  try {
    bridge.flockExNb(lockFd);
  } catch (err) {
    let holderInfo = "";
    try {
      holderInfo = fs.readFileSync(lockFd, "utf8").trim();
    } catch {
      // ignore
    }
    fs.closeSync(lockFd);
    const code = extractNativeErrnoCode(err);
    throw new WorkspaceLockError(
      `Workspace lock busy (${code ?? String(err)}): ${holderInfo || lockPath}`
    );
  }

  const payload: WorkspaceLockPayload = {
    lockToken: crypto.randomUUID(),
    pid: process.pid,
    procStartTimeTicks: readProcStartTimeTicks(process.pid),
    bootId: readSystemBootId(),
    acquiredAtMs: Date.now()
  };

  let ownedStat: fs.Stats;
  try {
    fs.ftruncateSync(lockFd, 0);
    const jsonBuf = Buffer.from(JSON.stringify(payload), "utf8");
    fs.writeSync(lockFd, jsonBuf, 0, jsonBuf.length, 0);
    ownedStat = fs.fstatSync(lockFd);
  } catch (err) {
    try {
      bridge.flockUn(lockFd);
    } catch {
      // ignore
    }
    fs.closeSync(lockFd);
    throw err;
  }

  const cloexecVerified = bridge.hasCloexec(lockFd);
  if (!cloexecVerified) {
    try {
      bridge.flockUn(lockFd);
    } catch {
      // ignore
    }
    fs.closeSync(lockFd);
    throw new WorkspaceLockError(`FD_CLOEXEC missing on lockFd; refusing unsafe flock ownership`);
  }

  const ownedDev = ownedStat.dev;
  const ownedIno = ownedStat.ino;
  let released = false;

  const assertHeld = () => {
    if (released) {
      throw new WorkspaceLockError(`Lock fence violation: lock handle already released (${payload.lockToken})`);
    }
    const st = fs.fstatSync(lockFd);
    if (st.nlink < 1 || st.dev !== ownedDev || st.ino !== ownedIno) {
      throw new WorkspaceLockError(`Lock fence lost: underlying lock inode unlinked or replaced`);
    }
    const buf = Buffer.alloc(Math.max(st.size, 1));
    const n = fs.readSync(lockFd, buf, 0, buf.length, 0);
    try {
      const current = JSON.parse(buf.subarray(0, n).toString("utf8")) as WorkspaceLockPayload;
      if (current.lockToken !== payload.lockToken) {
        throw new WorkspaceLockError(`Lock token overwritten (${current.lockToken} !== ${payload.lockToken})`);
      }
    } catch (err) {
      if (err instanceof WorkspaceLockError) throw err;
      throw new WorkspaceLockError(`Corrupted lock metadata on fd`);
    }
  };

  const release = () => {
    if (released) return;
    released = true;
    try {
      bridge.flockUn(lockFd);
    } catch {
      // ignore
    }
    try {
      fs.closeSync(lockFd);
    } catch {
      // ignore
    }
  };

  return {
    lockPath,
    lockToken: payload.lockToken,
    ownedDev,
    ownedIno,
    cloexecVerified,
    assertHeld,
    release
  };
}

export function withWorkspaceLock<T>(workspaceRoot: string, fn: (lock: WorkspaceLockHandle) => T): T {
  const lock = acquireWorkspaceLock(workspaceRoot);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}
