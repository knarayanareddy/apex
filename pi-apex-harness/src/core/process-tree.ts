import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { readProcStartTimeTicks, readSystemBootId } from "./workspace-lock.ts";

export interface ProcessIdentity {
  pid: number;
  startTime: string | null;
  bootId: string;
}

export function getProcessStartTime(pid: number): string | null {
  if (pid <= 0) return null;
  // 1. Linux fast path: /proc/<pid>/stat
  const linuxTicks = readProcStartTimeTicks(pid);
  if (linuxTicks) return linuxTicks;

  // 2. macOS / POSIX fallback via ps
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function recordProcessIdentity(pid: number): ProcessIdentity {
  return {
    pid,
    startTime: getProcessStartTime(pid),
    bootId: readSystemBootId()
  };
}

export function isProcessAliveWithIdentity(identity: ProcessIdentity): boolean {
  if (identity.pid <= 0 || !identity.startTime) return false;
  try {
    process.kill(identity.pid, 0); // test signal
  } catch {
    return false; // process does not exist
  }
  // Process exists. Check boot ID and start time to guard against PID recycling.
  if (identity.bootId && identity.bootId !== readSystemBootId()) {
    return false; // system rebooted
  }
  if (identity.startTime !== null) {
    const currentStart = getProcessStartTime(identity.pid);
    if (!currentStart || currentStart !== identity.startTime) {
      return false; // PID recycled by another process!
    }
  }
  return true;
}

/**
 * Discovers all active descendant PIDs beneath `rootPid`.
 * On Linux, parses /proc. On macOS/POSIX, parses `ps -eo pid,ppid`.
 */
export function findDescendantPids(rootPid: number): number[] {
  if (rootPid <= 0) return [];
  const parentMap = new Map<number, number[]>();

  if (process.platform === "linux" && fs.existsSync("/proc")) {
    try {
      const entries = fs.readdirSync("/proc");
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = parseInt(entry, 10);
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          const closeParen = stat.lastIndexOf(")");
          if (closeParen === -1) continue;
          const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
          const ppid = parseInt(fields[1], 10); // 4th field in stat is ppid (0-indexed field 1 after paren)
          if (!isNaN(ppid)) {
            const list = parentMap.get(ppid) ?? [];
            list.push(pid);
            parentMap.set(ppid, list);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        }
      }
    } catch {
      // A partial /proc snapshot must not be mistaken for a complete tree.
      parentMap.clear();
    }
  }

  if (parentMap.size === 0) {
    try {
      const out = execFileSync("ps", ["-eo", "pid,ppid"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000
      });
      const lines = out.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0], 10);
          const ppid = parseInt(parts[1], 10);
          if (!isNaN(pid) && !isNaN(ppid)) {
            const list = parentMap.get(ppid) ?? [];
            list.push(pid);
            parentMap.set(ppid, list);
          }
        }
      }
    } catch (err) {
      throw new Error(`PROCESS_DISCOVERY_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Traverse tree rooted at rootPid
  const results: number[] = [];
  const queue = [rootPid];
  const visited = new Set<number>([rootPid]);

  while (queue.length > 0) {
    const parent = queue.shift()!;
    const children = parentMap.get(parent) ?? [];
    for (const child of children) {
      if (!visited.has(child)) {
        visited.add(child);
        results.push(child);
        queue.push(child);
      }
    }
  }

  return results;
}

export interface TerminationResult {
  success: boolean;
  killedPids: number[];
  survivingPids: number[];
  recycledDetected: boolean;
  diagnostic: string;
}

/**
 * Best-effort termination of a discovered process tree. Identity is checked
 * before each signal, but a userspace PID check and signal are not atomic;
 * descendants may also reparent or spawn after discovery.
 */
export async function terminateProcessTree(
  rootPid: number,
  rootIdentity?: ProcessIdentity,
  options?: { gracePeriodMs?: number }
): Promise<TerminationResult> {
  const killedPids: number[] = [];
  const survivingPids: number[] = [];
  let recycledDetected = false;

  if (rootPid <= 0) {
    return {
      success: false,
      killedPids: [],
      survivingPids: [],
      recycledDetected: false,
      diagnostic: "Invalid root PID"
    };
  }

  if (!rootIdentity || rootIdentity.pid !== rootPid || !rootIdentity.startTime) {
    return { success: false, killedPids: [], survivingPids: [rootPid], recycledDetected: false, diagnostic: `REFUSING_SIGNAL: PID ${rootPid} has unknown or mismatched identity` };
  }

  // 1. Verify root identity before discovering its descendants.
  {
    const alive = isProcessAliveWithIdentity(rootIdentity);
    if (!alive) {
      // Check if process exists under different start time (recycled!)
      try {
        process.kill(rootPid, 0);
        // Exists but failed identity check -> Recycled!
        recycledDetected = true;
        return {
          success: false,
          killedPids: [],
          survivingPids: [rootPid],
          recycledDetected: true,
          diagnostic: `REFUSING_SIGNAL: PID ${rootPid} was recycled by an unrelated process`
        };
      } catch {
        // A dead root does not establish whether descendants were reparented.
        return {
          success: false,
          killedPids: [],
          survivingPids: [],
          recycledDetected: false,
          diagnostic: `Root PID ${rootPid} is gone; descendant ownership is unverified`
        };
      }
    }
  }

  // 2. Discover all descendants before killing root
  let descendants: number[];
  try {
    descendants = findDescendantPids(rootPid);
  } catch {
    return { success: false, killedPids: [], survivingPids: [rootPid], recycledDetected: false, diagnostic: "REFUSING_SIGNAL: descendant discovery unavailable" };
  }
  const allPidsToKill = [...descendants.reverse(), rootPid]; // leaves first
  const identities = new Map<number, ProcessIdentity>([[rootPid, rootIdentity]]);
  for (const pid of descendants) identities.set(pid, recordProcessIdentity(pid));
  let unverified = false;

  // 3. Send SIGTERM
  for (const pid of allPidsToKill) {
    const identity = identities.get(pid)!;
    if (!identity.startTime || !isProcessAliveWithIdentity(identity)) {
      try {
        process.kill(pid, 0);
        unverified = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") unverified = true;
      }
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      killedPids.push(pid);
    } catch {
      // already gone
    }
  }

  // 4. Brief grace wait allowing event loop to process SIGCHLD
  const graceMs = options?.gracePeriodMs ?? 80;
  await new Promise((r) => setTimeout(r, graceMs));

  // 5. Send SIGKILL to remaining alive targets
  for (const pid of allPidsToKill) {
    try {
      process.kill(pid, 0); // still alive?
      if (!isProcessAliveWithIdentity(identities.get(pid)!)) {
        unverified = true;
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") unverified = true;
    }
  }

  // 6. Verify which survived with a brief poll for OS process table reap
  const waitDeadline = Date.now() + 250;
  while (Date.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 20));
    let anyAlive = false;
    for (const pid of allPidsToKill) {
      try {
        process.kill(pid, 0);
        anyAlive = true;
      } catch {
        // exited
      }
    }
    if (!anyAlive) break;
  }

  for (const pid of allPidsToKill) {
    try {
      process.kill(pid, 0);
      survivingPids.push(pid);
    } catch {
      // successfully exited
    }
  }

  const snapshotCleared = survivingPids.length === 0 && !unverified;
  return {
    // Parent/child enumeration cannot account for already-reparented processes.
    // Never turn a cleared snapshot into a claim of complete ownership cleanup.
    success: false,
    killedPids,
    survivingPids,
    recycledDetected,
    diagnostic: snapshotCleared
      ? `No survivors observed in the discovered process snapshot (${killedPids.length} signalled); reparented or newly spawned descendants are unverified`
      : `Cleanup unverified or incomplete; ${survivingPids.length} process(es) remain: [${survivingPids.join(", ")}]`
  };
}
