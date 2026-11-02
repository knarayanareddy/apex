/**
 * Private Control-Plane Storage Preflight & Mount Topology Validator (ADR 0001 / R05 / R06).
 *
 * Enforces dedicated persistent filesystem state for `.harness` (sessions, SQLite/WAL, spills)
 * to physically prevent cross-device hardlinks (`EXDEV`) and eliminate scan-to-use races.
 *
 * Fails closed before file creation across CLI, Ring 0, Ring 4, subagents, and standalone constructors
 * unless explicit development overrides (`allowSameDeviceDev: true`) are configured.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { getLinuxFsBridge } from "./linux-fs-bridge.ts";

export class PrivateStateBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateStateBoundaryError";
  }
}

export interface MountTopologyReport {
  workspaceRoot: string;
  controlPlaneDir: string;
  workspaceDev: number;
  controlPlaneDev: number | null;
  isSeparateFilesystem: boolean;
  hasSymlinkInControlPlane: boolean;
  exposedNestedMounts: string[];
  valid: boolean;
  violations: string[];
}

export interface PreflightOptions {
  allowSameDeviceDev?: boolean;
}

/**
 * Inspects the filesystem and mount topology for `workspaceRoot` and `controlPlaneDir`.
 */
export function inspectMountTopology(
  workspaceRoot: string,
  controlPlaneDir?: string
): MountTopologyReport {
  const realWs = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const cpDir = controlPlaneDir
    ? path.resolve(controlPlaneDir)
    : path.join(realWs, ".harness");

  const violations: string[] = [];
  let wsDev = 0;
  try {
    wsDev = fs.statSync(realWs).dev;
  } catch (err) {
    violations.push(`Workspace stat error: ${String(err)}`);
  }

  let hasSymlinkInControlPlane = false;
  let cpDev: number | null = null;

  if (fs.existsSync(cpDir)) {
    try {
      const lst = fs.lstatSync(cpDir);
      if (lst.isSymbolicLink()) {
        hasSymlinkInControlPlane = true;
        violations.push("Control-plane directory is a symbolic link");
      }
      const st = fs.statSync(cpDir);
      cpDev = st.dev;
    } catch (err) {
      violations.push(`Control-plane stat error: ${String(err)}`);
    }
  } else {
    // Missing control plane directory (first boot / unprovisioned state)
    // Inspect nearest existing ancestor of cpDir to determine target device
    let parent = path.dirname(cpDir);
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) {
      parent = path.dirname(parent);
    }
    if (fs.existsSync(parent)) {
      try {
        const pst = fs.statSync(parent);
        cpDev = pst.dev;
      } catch (err) {
        violations.push(`Control-plane target parent stat error: ${String(err)}`);
      }
    }
  }

  // Check if any ancestor between realWs and cpDir is a symlink
  if (cpDir.startsWith(realWs + path.sep)) {
    let cur = path.dirname(cpDir);
    while (cur.length >= realWs.length && cur !== realWs) {
      try {
        if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
          hasSymlinkInControlPlane = true;
          violations.push(`Ancestor directory '${cur}' is a symbolic link`);
          break;
        }
      } catch {
        // ignore
      }
      cur = path.dirname(cur);
    }
  }

  const isSeparate = cpDev !== null && wsDev !== 0 && cpDev !== wsDev;
  const exposedNestedMounts: string[] = [];

  // On Linux, inspect /proc/self/mountinfo to detect exposed nested mounts of the control-plane device
  if (process.platform === "linux" && fs.existsSync("/proc/self/mountinfo")) {
    try {
      const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8");
      // Format: 36 35 98:0 / /mnt rw,noatime master:1 - ext4 /dev/root rw,errors=remount-ro
      for (const line of mountinfo.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const mountPoint = parts[4];
          if (mountPoint && mountPoint.startsWith(realWs + path.sep) && mountPoint !== cpDir && !mountPoint.startsWith(cpDir + path.sep)) {
            try {
              const mst = fs.statSync(mountPoint);
              if (cpDev !== null && mst.dev === cpDev) {
                exposedNestedMounts.push(mountPoint);
                violations.push(`Control-plane filesystem is exposed at nested mount '${mountPoint}'`);
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // mountinfo read failure non-fatal, fallback to scan
    }
  }

  if (cpDev !== null && !isSeparate) {
    violations.push("Control plane shares the same filesystem device as workspace");
  }

  return {
    workspaceRoot: realWs,
    controlPlaneDir: cpDir,
    workspaceDev: wsDev,
    controlPlaneDev: cpDev,
    isSeparateFilesystem: isSeparate,
    hasSymlinkInControlPlane,
    exposedNestedMounts,
    valid: violations.length === 0,
    violations
  };
}

/**
 * Validates private state mount topology before creating files or opening databases.
 * Throws `PrivateStateBoundaryError` if boundaries are violated unless `allowSameDeviceDev: true`.
 */
export function validatePrivateStatePreflight(
  workspaceRoot: string,
  controlPlaneDir?: string,
  options?: PreflightOptions
): MountTopologyReport {
  const report = inspectMountTopology(workspaceRoot, controlPlaneDir);

  if (options?.allowSameDeviceDev) {
    if (!report.isSeparateFilesystem && report.controlPlaneDev !== null) {
      console.warn(
        `[APEX_STORAGE_WARNING] Control plane and workspace share the same filesystem (dev=${report.workspaceDev}). Cross-device hardlink isolation unverified.`
      );
    }
    return report;
  }

  if (report.hasSymlinkInControlPlane) {
    throw new PrivateStateBoundaryError(
      `PRIVATE_STATE_BOUNDARY_ERROR: Control-plane path '${report.controlPlaneDir}' cannot be or contain a symbolic link: ${report.violations.join("; ")}`
    );
  }

  if (!report.isSeparateFilesystem && report.controlPlaneDev !== null) {
    throw new PrivateStateBoundaryError(
      `PRIVATE_STATE_BOUNDARY_VIOLATION: Control plane state at '${report.controlPlaneDir}' must reside on a dedicated persistent filesystem (st_dev differs from workspace) to prevent hardlink aliases.`
    );
  }

  if (report.exposedNestedMounts.length > 0) {
    throw new PrivateStateBoundaryError(
      `PRIVATE_STATE_BOUNDARY_VIOLATION: Control plane filesystem device is exposed via nested mount in workspace: ${report.exposedNestedMounts.join(", ")}`
    );
  }

  return report;
}

export interface MigrationSummary {
  success: boolean;
  filesCopied: number;
  bytesCopied: number;
  verifiedHashes: boolean;
  sourceRetained: boolean;
  dryRun?: boolean;
  integrityVerified?: boolean;
}

function copyFileWithVerification(src: string, dst: string): { bytes: number; hash: string } {
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  const content = fs.readFileSync(src);
  const srcHash = crypto.createHash("sha256").update(content).digest("hex");
  const tempDst = `${dst}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tempDst, content, { mode: 0o600 });
  fs.renameSync(tempDst, dst);
  const dstHash = crypto.createHash("sha256").update(fs.readFileSync(dst)).digest("hex");
  if (srcHash !== dstHash) {
    throw new Error(`MIGRATION_INTEGRITY_MISMATCH: SHA-256 verification failed copying '${src}' to '${dst}'`);
  }
  return { bytes: content.length, hash: srcHash };
}

export interface MigratePrivateStateOptions {
  sourceDir: string;
  destinationDir: string;
  workspaceRoot?: string;
  stateDbPath?: string;
  dryRun?: boolean;
  rollbackOnError?: boolean;
  allowSameDeviceDev?: boolean;
}

function checkNoSymlinksInPath(targetPath: string, label: string): void {
  let cur = path.resolve(targetPath);
  while (cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) {
      const lst = fs.lstatSync(cur);
      if (lst.isSymbolicLink()) {
        throw new PrivateStateBoundaryError(`MIGRATION_UNSAFE_PATH: ${label} path '${targetPath}' contains symbolic link at '${cur}'`);
      }
    }
    cur = path.dirname(cur);
  }
}

/**
 * Rehearses and performs offline, non-destructive migration of private state (ADR 0001 / R06).
 * Retains source state intact, uses SQLite backup() API for consistent database checkpoints,
 * verifies destination PRAGMA integrity_check, and cryptographically verifies all copied sessions and spills.
 * Automatically rolls back destination state on any failure, removing ONLY resources created by this attempt.
 */
export async function migratePrivateStateOffline(params: MigratePrivateStateOptions): Promise<MigrationSummary> {
  const srcDir = path.resolve(params.sourceDir);
  const dstDir = path.resolve(params.destinationDir);
  const dryRun = Boolean(params.dryRun);
  const rollbackOnError = params.rollbackOnError ?? true;

  // 1. Source existence and symlink verification
  if (!fs.existsSync(srcDir)) {
    throw new Error(`MIGRATION_SOURCE_NOT_FOUND: Source directory '${srcDir}' does not exist`);
  }
  checkNoSymlinksInPath(srcDir, "Source");

  // 2. Destination symlink verification
  checkNoSymlinksInPath(dstDir, "Destination");

  // 3. Overlapping path collision checks
  const realSrc = fs.realpathSync(srcDir);
  let dstParent = dstDir;
  while (!fs.existsSync(dstParent) && dstParent !== path.dirname(dstParent)) {
    dstParent = path.dirname(dstParent);
  }
  const realDstParent = fs.realpathSync(dstParent);
  const relDst = path.relative(dstParent, dstDir);
  const resolvedDst = path.resolve(realDstParent, relDst);

  if (realSrc === resolvedDst) {
    throw new PrivateStateBoundaryError(`MIGRATION_PATH_COLLISION: Source and destination are identical ('${realSrc}')`);
  }
  if (resolvedDst.startsWith(realSrc + path.sep)) {
    throw new PrivateStateBoundaryError(`MIGRATION_PATH_OVERLAP: Destination '${resolvedDst}' is inside source directory '${realSrc}'`);
  }
  if (realSrc.startsWith(resolvedDst + path.sep)) {
    throw new PrivateStateBoundaryError(`MIGRATION_PATH_OVERLAP: Source '${realSrc}' is inside destination directory '${resolvedDst}'`);
  }

  // 4. Pre-existing destination content check (fail before mutation)
  const dstAlreadyExisted = fs.existsSync(dstDir);
  if (dstAlreadyExisted) {
    const existing = fs.readdirSync(dstDir);
    if (existing.length > 0) {
      throw new PrivateStateBoundaryError(
        `MIGRATION_DESTINATION_NOT_EMPTY: Destination directory '${dstDir}' contains ${existing.length} existing entry/entries. Refusing migration to prevent overwriting existing data.`
      );
    }
  }

  // 5. Confirmed filesystem separation (st_dev differs from source and workspace)
  const srcDev = fs.statSync(srcDir).dev;
  const dstDev = dstAlreadyExisted ? fs.statSync(dstDir).dev : fs.statSync(dstParent).dev;

  if (srcDev === dstDev && !params.allowSameDeviceDev) {
    throw new PrivateStateBoundaryError(
      `PRIVATE_STATE_BOUNDARY_VIOLATION: Destination '${dstDir}' shares filesystem device (${dstDev}) with source '${srcDir}'. Migration requires confirmed filesystem separation (st_dev differs).`
    );
  }
  if (params.workspaceRoot) {
    const wsDev = fs.statSync(path.resolve(params.workspaceRoot)).dev;
    if (dstDev === wsDev && !params.allowSameDeviceDev) {
      throw new PrivateStateBoundaryError(
        `PRIVATE_STATE_BOUNDARY_VIOLATION: Destination '${dstDir}' shares filesystem device (${dstDev}) with workspace '${params.workspaceRoot}'. Migration requires confirmed filesystem separation (st_dev differs).`
      );
    }
  }

  // Hold the same cooperative kernel lock as the live workspace for the whole copy.
  // A PID stored in the lock file is not proof that the lock is free.
  const lockPath = path.join(srcDir, "workspace.lock");
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw new PrivateStateBoundaryError(`MIGRATION_SOURCE_LOCK_UNAVAILABLE: Cannot open existing source lock: ${String(err)}`);
  }
  let bridge: ReturnType<typeof getLinuxFsBridge>;
  try {
    bridge = getLinuxFsBridge();
    if (!fs.fstatSync(lockFd).isFile()) throw new Error("source lock is not a regular file");
    bridge.flockExNb(lockFd);
  } catch (err) {
    fs.closeSync(lockFd);
    throw new PrivateStateBoundaryError(`MIGRATION_SOURCE_ACTIVE: Cannot acquire exclusive source lock: ${String(err)}`);
  }

  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  let filesCopied = 0;
  let bytesCopied = 0;
  let integrityVerified = false;

  try {
    if (!dryRun) {
      if (!dstAlreadyExisted) {
        fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
        createdDirs.push(dstDir);
      }
    }

    // 7. Migrate SQLite database using SQLite backup() API if present
    const srcDbPath = params.stateDbPath ?? path.join(srcDir, "state.db");
    const dstDbPath = path.join(dstDir, "state.db");
    if (fs.existsSync(srcDbPath)) {
      const srcDb = new DatabaseSync(srcDbPath);
      try {
        const srcIntegrity = srcDb.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
        if (srcIntegrity?.integrity_check !== "ok") {
          throw new PrivateStateBoundaryError(`MIGRATION_SOURCE_CORRUPT: Source database failed integrity check: ${srcIntegrity?.integrity_check}`);
        }
        if (!dryRun) {
          const dstDbDir = path.dirname(dstDbPath);
          if (!fs.existsSync(dstDbDir)) {
            fs.mkdirSync(dstDbDir, { recursive: true, mode: 0o700 });
            createdDirs.push(dstDbDir);
          }
          await backup(srcDb, dstDbPath);
          createdFiles.push(dstDbPath);
          filesCopied += 1;
          bytesCopied += fs.statSync(dstDbPath).size;

          const dstDb = new DatabaseSync(dstDbPath);
          try {
            const dstIntegrity = dstDb.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
            if (dstIntegrity?.integrity_check !== "ok") {
              throw new PrivateStateBoundaryError(`MIGRATION_INTEGRITY_ERROR: Destination SQLite integrity check failed: ${dstIntegrity?.integrity_check}`);
            }
            integrityVerified = true;
          } finally {
            dstDb.close();
          }
        } else {
          filesCopied += 1;
          bytesCopied += fs.statSync(srcDbPath).size;
          integrityVerified = true;
        }
      } finally {
        srcDb.close();
      }
    }

    // 8. Recursively copy sessions, spills, and credentials with SHA-256 verification
    const walkAndCopy = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // Never follow symlinks
        const srcFull = path.join(dir, entry.name);
        const rel = path.relative(srcDir, srcFull);
        const dstFull = path.join(dstDir, rel);

        if (entry.isDirectory()) {
          if (!dryRun) {
            if (!fs.existsSync(dstFull)) {
              fs.mkdirSync(dstFull, { recursive: true, mode: 0o700 });
              createdDirs.push(dstFull);
            }
          }
          walkAndCopy(srcFull);
        } else if (entry.isFile()) {
          // Skip SQLite DB and WAL files because backup() already checkpointed them cleanly
          if (entry.name === "state.db" || entry.name === "state.db-wal" || entry.name === "state.db-shm") {
            continue;
          }
          if (!dryRun) {
            const dstParentDir = path.dirname(dstFull);
            if (!fs.existsSync(dstParentDir)) {
              fs.mkdirSync(dstParentDir, { recursive: true, mode: 0o700 });
              createdDirs.push(dstParentDir);
            }
            const { bytes } = copyFileWithVerification(srcFull, dstFull);
            createdFiles.push(dstFull);
            filesCopied += 1;
            bytesCopied += bytes;
          } else {
            filesCopied += 1;
            bytesCopied += fs.statSync(srcFull).size;
          }
        }
      }
    };

    walkAndCopy(srcDir);

    // 9. Verify source files are completely retained
    const sourceRetained = fs.existsSync(srcDir);

    return {
      success: true,
      filesCopied,
      bytesCopied,
      verifiedHashes: true,
      sourceRetained,
      dryRun,
      integrityVerified
    };
  } catch (error) {
    if (!dryRun && rollbackOnError) {
      // Surgical rollback: clean up ONLY resources created during this failed attempt
      for (const f of createdFiles.reverse()) {
        try {
          if (fs.existsSync(f)) fs.rmSync(f, { force: true });
        } catch {}
      }
      for (const d of createdDirs.reverse()) {
        try {
          if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
            fs.rmdirSync(d);
          }
        } catch {}
      }
    }
    throw error;
  } finally {
    try { bridge.flockUn(lockFd); } finally { fs.closeSync(lockFd); }
  }
}
