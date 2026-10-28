import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DurabilityMode } from "../types.ts";
import { extractNativeErrnoCode, getLinuxFsBridge } from "./linux-fs-bridge.ts";
import { GuardDeniedError } from "./monotonic-guard.ts";
import {
  isSecretBasename,
  mkdirSingleBeneathWorkspace,
  openWorkspaceRootFd,
  PathContainmentError,
  rmdirEmptyBeneathWorkspace,
  scanWorkspaceSecretsAndHardlinks,
  type SecretScanResult,
  unlinkSafeBeneathWorkspace
} from "./safe-path.ts";
import type { StateDb } from "./state-db.ts";
import {
  computeBytesSha256,
  computeFileContentSha256,
  syncSessionTranscriptDurable,
  writeFileDurable
} from "./wal-recovery.ts";
import {
  acquireWorkspaceLock,
  withWorkspaceLock,
  WorkspaceLockError,
  type WorkspaceLockHandle
} from "./workspace-lock.ts";

export { acquireWorkspaceLock, withWorkspaceLock, WorkspaceLockError, type WorkspaceLockHandle };

export interface WorkspaceEntryState {
  kind: "missing" | "file" | "dir" | "symlink" | "submodule" | "other";
  hash: string | null;
  /** Exact 9-bit POSIX mode (`st.mode & 0o777`) when `kind === 'file'` (`0o000`..`0o777`). */
  mode: number | null;
}

export type RewindOpKind =
  | "UNLINK_FILE"
  | "RMDIR_EMPTY"
  | "ENSURE_DIR"
  | "WRITE_BLOB"
  | "HALT_UNSUPPORTED";

export interface RewindOpRow {
  tx_id: string;
  op_seq: number;
  op_kind: RewindOpKind;
  rel_path: string;
  expected_before_json: string;
  expected_after_json: string;
  git_blob_oid: string | null;
  halt_reason: string | null;
  status: "PENDING" | "COMPLETED";
  completed_at_ms: number | null;
}

export interface RewindConflictItem {
  relPath: string;
  reason: string;
  liveState: WorkspaceEntryState;
  expectedPre: WorkspaceEntryState;
  expectedTarget: WorkspaceEntryState;
}

export class RewindConflictError extends Error {
  readonly conflicts: RewindConflictItem[];
  constructor(txId: string, conflicts: RewindConflictItem[]) {
    super(
      `REWIND_CONFLICT_DETECTED [${txId}]: unsafe or externally modified path(s) [${conflicts.map((c) => `${c.relPath}(${c.reason})`).join(", ")}]`
    );
    this.name = "RewindConflictError";
    this.conflicts = conflicts;
  }
}

export const MISSING_ENTRY_STATE: WorkspaceEntryState = Object.freeze({
  kind: "missing",
  hash: null,
  mode: null
});

export const DIR_ENTRY_STATE: WorkspaceEntryState = Object.freeze({
  kind: "dir",
  hash: null,
  mode: null
});

export function entryStatesEqual(a: WorkspaceEntryState, b: WorkspaceEntryState): boolean {
  return a.kind === b.kind && a.hash === b.hash && a.mode === b.mode;
}

const EXCLUDED_TOP_NAMES = new Set([".git", ".harness", "node_modules", ".venv"]);

function isExcludedRelPath(relPath: string): boolean {
  const first = relPath.split("/")[0];
  if (EXCLUDED_TOP_NAMES.has(first)) return true;
  const base = path.posix.basename(relPath);
  if (isSecretBasename(base)) return true;
  return false;
}

function readSubmoduleHeadCommitOid(submoduleDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: submoduleDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "UNBORN_SUBMODULE_HEAD";
  }
}

export class CheckpointSecurityError extends GuardDeniedError {
  readonly code: string;
  readonly incompleteReasons: readonly string[];
  constructor(code = "CHECKPOINT_SECRET_SCAN_INCOMPLETE", incompleteReasons: readonly string[] = []) {
    super(`[checkpoint security refused: ${code} - ${incompleteReasons.join("; ") || "secret inventory incomplete"}]`);
    this.name = "CheckpointSecurityError";
    this.code = code;
    this.incompleteReasons = incompleteReasons;
  }
}

export interface WorkspaceSnapshotScan {
  entryStates: Record<string, WorkspaceEntryState>;
  fileHashes: Record<string, string>;
  directories: Set<string>;
}

/**
 * Scans workspace entries capturing exact `{ kind, hash, mode }` (including 9-bit POSIX modes `0000`..`0777`,
 * existing directories, non-traversed symlinks, and Git submodules) while excluding secrets and hardlink aliases.
 * Fails closed with `CheckpointSecurityError` if secret scanning was incomplete.
 */
export function scanWorkspaceEntryStates(
  workspaceRoot: string,
  validatedScan?: SecretScanResult
): WorkspaceSnapshotScan {
  const realWs = fs.realpathSync(workspaceRoot);
  const secretScan = validatedScan ?? scanWorkspaceSecretsAndHardlinks(realWs);
  if (!secretScan.complete) {
    throw new CheckpointSecurityError(
      "CHECKPOINT_SECRET_SCAN_INCOMPLETE",
      secretScan.incompleteReasons
    );
  }
  const entryStates: Record<string, WorkspaceEntryState> = {};
  const fileHashes: Record<string, string> = {};
  const directories = new Set<string>();

  const walk = (absDir: string, relDir: string) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExcludedRelPath(relPath)) continue;
      const absPath = path.join(absDir, entry.name);

      if (entry.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(absPath, "utf8");
        entryStates[relPath] = {
          kind: "symlink",
          hash: computeBytesSha256(linkTarget),
          mode: null
        };
        continue;
      }

      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(absPath, ".git"))) {
          entryStates[relPath] = {
            kind: "submodule",
            hash: readSubmoduleHeadCommitOid(absPath),
            mode: null
          };
          continue;
        }
        directories.add(relPath);
        walk(absPath, relPath);
        continue;
      }

      if (entry.isFile()) {
        const st = fs.lstatSync(absPath);
        if (secretScan.secretInodeKeys.has(`${st.dev}:${st.ino}`)) continue;
        const sha = computeFileContentSha256(absPath);
        const exactMode = st.mode & 0o777;
        entryStates[relPath] = {
          kind: "file",
          hash: sha,
          mode: exactMode
        };
        fileHashes[relPath] = sha;
      }
    }
  };

  walk(realWs, "");
  return { entryStates, fileHashes, directories };
}

export function scanWorkspaceFileHashes(
  workspaceRoot: string,
  validatedScan?: SecretScanResult
): Record<string, string> {
  return scanWorkspaceEntryStates(workspaceRoot, validatedScan).fileHashes;
}

interface GitTreeEntry {
  gitMode: string;
  objType: string;
  oid: string;
}

function readGitTreeManifest(workspaceRoot: string, gitTreeOid: string): Record<string, GitTreeEntry> {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", gitTreeOid], {
    cwd: workspaceRoot,
    maxBuffer: 64 * 1024 * 1024
  });
  const manifest: Record<string, GitTreeEntry> = {};
  if (out.length === 0) return manifest;

  let start = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== 0) continue;
    const record = out.subarray(start, i).toString("utf8");
    start = i + 1;
    if (!record) continue;

    const tabIdx = record.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = record.slice(0, tabIdx).trim().split(/\s+/);
    const relPath = record.slice(tabIdx + 1);
    manifest[relPath] = {
      gitMode: meta[0],
      objType: meta[1],
      oid: meta[2]
    };
  }
  return manifest;
}

export function snapshotWorkingTreeToGit(
  workspaceRoot: string,
  validatedScan?: SecretScanResult
): {
  gitTreeOid: string;
  fileHashes: Record<string, string>;
  entryStates: Record<string, WorkspaceEntryState>;
  directories: Set<string>;
} {
  const realWs = fs.realpathSync(workspaceRoot);
  const secretScan = validatedScan ?? scanWorkspaceSecretsAndHardlinks(realWs);
  if (!secretScan.complete) {
    throw new CheckpointSecurityError(
      "CHECKPOINT_SECRET_SCAN_INCOMPLETE",
      secretScan.incompleteReasons
    );
  }

  const harnessDir = path.join(realWs, ".harness");
  fs.mkdirSync(harnessDir, { recursive: true, mode: 0o700 });
  const shadowIdx = path.join(harnessDir, `shadow.${process.pid}.${crypto.randomBytes(4).toString("hex")}.idx`);
  const env = { ...process.env, GIT_INDEX_FILE: shadowIdx };
  const { entryStates, fileHashes, directories } = scanWorkspaceEntryStates(realWs, secretScan);

  const dynamicExcludes = secretScan.allMaskedPaths
    .map((abs) => path.relative(realWs, abs).replace(/\\/g, "/"))
    .filter((rel) => rel.length > 0 && !rel.startsWith(".."))
    .map((rel) => `:(exclude)${rel}`);

  const specialExcludes = Object.entries(entryStates)
    .filter(([, s]) => s.kind === "submodule" || s.kind === "symlink")
    .map(([rel]) => `:(exclude)${rel}`);

  try {
    execFileSync("git", ["read-tree", "--empty"], { cwd: realWs, env, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "add",
        "-A",
        "--",
        ".",
        ":(exclude).harness",
        ":(exclude)node_modules",
        ":(exclude).venv",
        ...dynamicExcludes,
        ...specialExcludes
      ],
      { cwd: realWs, env, stdio: "ignore" }
    );
    const gitTreeOid = execFileSync("git", ["write-tree"], {
      cwd: realWs,
      env,
      encoding: "utf8"
    }).trim();
    return { gitTreeOid, fileHashes, entryStates, directories };
  } finally {
    try {
      fs.unlinkSync(shadowIdx);
    } catch {
      // ignore
    }
  }
}

export function captureTurnCheckpoint(params: {
  stateDb: StateDb;
  workspaceRoot: string;
  sessionId: string;
  leafId: string;
  turnIndex: number;
}): {
  gitTreeOid: string;
  fileHashes: Record<string, string>;
  entryStates: Record<string, WorkspaceEntryState>;
} {
  const snap = snapshotWorkingTreeToGit(params.workspaceRoot);
  params.stateDb.db
    .prepare(
      `INSERT INTO git_checkpoints (
        session_id, leaf_id, turn_index, git_tree_oid, file_hashes_json, entry_states_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, leaf_id) DO UPDATE SET
        git_tree_oid = excluded.git_tree_oid,
        file_hashes_json = excluded.file_hashes_json,
        entry_states_json = excluded.entry_states_json`
    )
    .run(
      params.sessionId,
      params.leafId,
      params.turnIndex,
      snap.gitTreeOid,
      JSON.stringify(snap.fileHashes),
      JSON.stringify(snap.entryStates),
      Date.now()
    );
  return { gitTreeOid: snap.gitTreeOid, fileHashes: snap.fileHashes, entryStates: snap.entryStates };
}

function inspectLivePathStateBeneath(
  realWs: string,
  wsFd: number,
  relPath: string
): {
  state: WorkspaceEntryState;
  ancestorSymlink: boolean;
  blockedByFileAncestor: boolean;
} {
  const bridge = getLinuxFsBridge();
  const parts = relPath.split("/").filter(Boolean);
  const dirFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);

  let curFd = wsFd;
  let curOwns = false;

  try {
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const st = bridge.fstatatNoFollow(curFd, seg);
      if (!st) {
        return { state: MISSING_ENTRY_STATE, ancestorSymlink: false, blockedByFileAncestor: false };
      }
      if (st.kind === "symlink") {
        return {
          state: { kind: "other", hash: "ANCESTOR_SYMLINK", mode: null },
          ancestorSymlink: true,
          blockedByFileAncestor: false
        };
      }
      if (st.kind === "file") {
        return { state: MISSING_ENTRY_STATE, ancestorSymlink: false, blockedByFileAncestor: true };
      }
      if (st.kind !== "dir") {
        return {
          state: { kind: "other", hash: `ANCESTOR_${st.kind}`, mode: null },
          ancestorSymlink: false,
          blockedByFileAncestor: false
        };
      }

      const nextFd = bridge.openBeneath(curFd, seg, dirFlags, 0);
      if (curOwns) fs.closeSync(curFd);
      curFd = nextFd;
      curOwns = true;
    }

    const leafName = parts[parts.length - 1];
    const leafMeta = bridge.fstatatNoFollow(curFd, leafName);
    if (!leafMeta) {
      return { state: MISSING_ENTRY_STATE, ancestorSymlink: false, blockedByFileAncestor: false };
    }

    if (leafMeta.kind === "file") {
      const fileFd = bridge.openBeneath(curFd, leafName, fs.constants.O_RDONLY, 0);
      try {
        const sha = computeBytesSha256(fs.readFileSync(fileFd));
        return {
          state: { kind: "file", hash: sha, mode: leafMeta.mode & 0o777 },
          ancestorSymlink: false,
          blockedByFileAncestor: false
        };
      } finally {
        fs.closeSync(fileFd);
      }
    }

    if (leafMeta.kind === "symlink") {
      const linkTarget = bridge.readlinkatSingle(curFd, leafName);
      return {
        state: { kind: "symlink", hash: computeBytesSha256(linkTarget), mode: null },
        ancestorSymlink: false,
        blockedByFileAncestor: false
      };
    }

    if (leafMeta.kind === "dir") {
      const dirFd = bridge.openBeneath(curFd, leafName, dirFlags, 0);
      try {
        const dotGitMeta = bridge.fstatatNoFollow(dirFd, ".git");
        if (dotGitMeta) {
          return {
            state: {
              kind: "submodule",
              hash: readSubmoduleHeadCommitOid(path.join(realWs, relPath)),
              mode: null
            },
            ancestorSymlink: false,
            blockedByFileAncestor: false
          };
        }
        return {
          state: DIR_ENTRY_STATE,
          ancestorSymlink: false,
          blockedByFileAncestor: false
        };
      } finally {
        fs.closeSync(dirFd);
      }
    }

    return {
      state: { kind: "other", hash: null, mode: leafMeta.mode },
      ancestorSymlink: false,
      blockedByFileAncestor: false
    };
  } catch (err) {
    const code = extractNativeErrnoCode(err);
    if (code === "ELOOP" || code === "EXDEV") {
      return {
        state: { kind: "other", hash: code, mode: null },
        ancestorSymlink: true,
        blockedByFileAncestor: false
      };
    }
    throw err;
  } finally {
    if (curOwns) {
      try {
        fs.closeSync(curFd);
      } catch {
        // ignore
      }
    }
  }
}

interface CompiledRewindOp {
  opKind: RewindOpKind;
  relPath: string;
  expectedBefore: WorkspaceEntryState;
  expectedAfter: WorkspaceEntryState;
  gitBlobOid: string | null;
  haltReason: string | null;
}

/**
 * Reviewer #5 Issue #1 Fix:
 * Compiles a checkpoint delta into an explicit, ordered sequence of typed atomic operations:
 *   Phase 1: `UNLINK_FILE`  (deepest-first)
 *   Phase 2: `RMDIR_EMPTY`  (deepest-first, distinct `unlinkat(AT_REMOVEDIR)`)
 *   Phase 3: `ENSURE_DIR`   (shallowest-first, distinct `mkdirat`)
 *   Phase 4: `WRITE_BLOB`   (shallowest-first, `writeFileDurable` preserving exact 9-bit `mode`)
 * Each operation carries its own `(expectedBefore, expectedAfter)` transition and `PENDING`/`COMPLETED`
 * persistence row in `rewind_ops`, making interrupted `file <-> dir` rewinds 100% crash-idempotent.
 */
function compileRewindOperations(params: {
  currentEntries: Record<string, WorkspaceEntryState>;
  currentDiskDirs: Set<string>;
  targetEntries: Record<string, WorkspaceEntryState>;
  targetTreeManifest: Record<string, GitTreeEntry>;
}): {
  ops: CompiledRewindOp[];
  restorePaths: string[];
  deletePaths: string[];
} {
  const { currentEntries, currentDiskDirs, targetEntries, targetTreeManifest } = params;
  const ops: CompiledRewindOp[] = [];

  const targetDirs = new Set<string>();
  for (const rel of Object.keys(targetEntries)) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      targetDirs.add(parts.slice(0, i).join("/"));
    }
  }

  const allLeafKeys = Array.from(
    new Set([...Object.keys(currentEntries), ...Object.keys(targetEntries)])
  ).sort();

  // 0. Detect diverged submodules or diverged symlinks -> explicit HALT_UNSUPPORTED ops
  for (const p of allLeafKeys) {
    const cur = currentEntries[p] ?? MISSING_ENTRY_STATE;
    const tgt = targetEntries[p] ?? MISSING_ENTRY_STATE;
    if (entryStatesEqual(cur, tgt)) continue;

    if (cur.kind === "submodule" || tgt.kind === "submodule") {
      ops.push({
        opKind: "HALT_UNSUPPORTED",
        relPath: p,
        expectedBefore: cur,
        expectedAfter: tgt,
        gitBlobOid: null,
        haltReason: "SUBMODULE_STATE_DIVERGENCE"
      });
    } else if (cur.kind === "symlink" || tgt.kind === "symlink") {
      ops.push({
        opKind: "HALT_UNSUPPORTED",
        relPath: p,
        expectedBefore: cur,
        expectedAfter: tgt,
        gitBlobOid: null,
        haltReason: "SYMLINK_TRANSITION_REQUIRES_OPERATOR"
      });
    }
  }

  // 1. Phase 1 — `UNLINK_FILE` (deepest-first): files absent from targetEntries (including `file -> dir`!)
  const unlinkCandidates = Object.keys(currentEntries)
    .filter((p) => currentEntries[p].kind === "file" && targetEntries[p]?.kind !== "file")
    .sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));

  const scheduledUnlinkSet = new Set<string>(unlinkCandidates);
  for (const p of unlinkCandidates) {
    ops.push({
      opKind: "UNLINK_FILE",
      relPath: p,
      expectedBefore: currentEntries[p],
      expectedAfter: MISSING_ENTRY_STATE,
      gitBlobOid: null,
      haltReason: null
    });
  }

  // Surviving entries after Phase 1 unlinks
  const remainingCurrentEntries = Object.keys(currentEntries).filter((p) => !scheduledUnlinkSet.has(p));

  // 2. Phase 2 — `RMDIR_EMPTY` (deepest-first):
  //    (a) Any existing directory `d` that collides with a target regular file (`dir -> file`, or nested under it)
  //    (b) Any existing directory `d` not in `targetDirs` that had tracked children unlinked and has 0 remaining entries
  const targetFilePaths = Object.keys(targetEntries).filter((p) => targetEntries[p].kind === "file");
  const rmdirCandidates = Array.from(currentDiskDirs)
    .filter((d) => {
      const collidesWithTargetFile = targetFilePaths.some((tf) => d === tf || d.startsWith(`${tf}/`));
      if (collidesWithTargetFile) return true;
      if (targetDirs.has(d)) return false;
      const hadUnlinkedChild = unlinkCandidates.some((u) => u.startsWith(`${d}/`));
      if (!hadUnlinkedChild) return false;
      const hasRemainingEntry = remainingCurrentEntries.some((r) => r.startsWith(`${d}/`));
      return !hasRemainingEntry;
    })
    .sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));

  const scheduledRmdirSet = new Set<string>(rmdirCandidates);
  for (const d of rmdirCandidates) {
    ops.push({
      opKind: "RMDIR_EMPTY",
      relPath: d,
      expectedBefore: DIR_ENTRY_STATE,
      expectedAfter: MISSING_ENTRY_STATE,
      gitBlobOid: null,
      haltReason: null
    });
  }

  // 3. Phase 3 — `ENSURE_DIR` (shallowest-first): directories needed by targetEntries not already surviving
  const survivingDirs = new Set(
    Array.from(currentDiskDirs).filter((d) => !scheduledRmdirSet.has(d))
  );
  const ensureDirCandidates = Array.from(targetDirs)
    .filter((d) => !survivingDirs.has(d))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  for (const d of ensureDirCandidates) {
    ops.push({
      opKind: "ENSURE_DIR",
      relPath: d,
      expectedBefore: MISSING_ENTRY_STATE,
      expectedAfter: DIR_ENTRY_STATE,
      gitBlobOid: null,
      haltReason: null
    });
  }

  // 4. Phase 4 — `WRITE_BLOB` (shallowest-first): changed or newly restored regular files
  const writeCandidates = targetFilePaths
    .filter((p) => {
      const cur =
        currentEntries[p] ?? (currentDiskDirs.has(p) ? DIR_ENTRY_STATE : MISSING_ENTRY_STATE);
      return !entryStatesEqual(cur, targetEntries[p]);
    })
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  for (const p of writeCandidates) {
    const treeEntry = targetTreeManifest[p];
    if (!treeEntry || treeEntry.objType !== "blob") {
      throw new Error(`Target Git tree missing expected blob '${p}'`);
    }
    const priorBeforePhase4 =
      scheduledRmdirSet.has(p) || scheduledUnlinkSet.has(p)
        ? MISSING_ENTRY_STATE
        : (currentEntries[p] ?? MISSING_ENTRY_STATE);

    ops.push({
      opKind: "WRITE_BLOB",
      relPath: p,
      expectedBefore: priorBeforePhase4,
      expectedAfter: targetEntries[p],
      gitBlobOid: treeEntry.oid,
      haltReason: null
    });
  }

  return {
    ops,
    restorePaths: writeCandidates,
    deletePaths: [...unlinkCandidates, ...rmdirCandidates]
  };
}

function findUnscheduledChildrenForPendingRmdir(
  realWs: string,
  dirRelPath: string,
  pendingRemovalSet: Set<string>
): string[] {
  const unscheduled: string[] = [];
  const absStart = path.join(realWs, dirRelPath);

  const walk = (absDir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${relDir}/${e.name}`;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        if (!pendingRemovalSet.has(rel)) {
          unscheduled.push(rel);
        }
        walk(abs, rel);
      } else if (!pendingRemovalSet.has(rel)) {
        unscheduled.push(rel);
      }
    }
  };

  walk(absStart, dirRelPath);
  return unscheduled;
}

/**
 * Executes ONLY `PENDING` operations from `rewind_ops` in `op_seq` order:
 * - Pre-flight checks the FIRST `PENDING` operation on each path: live state must match either
 *   `op.expected_before` OR `op.expected_after` (handling crashes between kernel syscall and SQLite commit!).
 * - Already-`COMPLETED` operations are never re-evaluated or re-executed!
 */
function executePendingRewindOps(params: {
  lock: WorkspaceLockHandle;
  stateDb: StateDb;
  txId: string;
  workspaceRoot: string;
  durabilityMode: DurabilityMode;
  faultInjectStopAfterOpSeq?: number;
}): void {
  const { lock, stateDb, txId, workspaceRoot, durabilityMode, faultInjectStopAfterOpSeq } = params;
  lock.assertHeld();

  const pendingOps = stateDb.db
    .prepare(
      `SELECT * FROM rewind_ops WHERE tx_id = ? AND status = 'PENDING' ORDER BY op_seq ASC`
    )
    .all(txId) as unknown as RewindOpRow[];

  if (pendingOps.length === 0) return;

  const { realWs, wsFd } = openWorkspaceRootFd(workspaceRoot);
  const conflicts: RewindConflictItem[] = [];

  // Map first PENDING operation per `rel_path` (subsequent ops on the same path depend on the first op completing!)
  const firstPendingByPath = new Map<string, RewindOpRow>();
  const pendingRemovalSet = new Set<string>();
  for (const op of pendingOps) {
    if (!firstPendingByPath.has(op.rel_path)) {
      firstPendingByPath.set(op.rel_path, op);
    }
    if (op.op_kind === "UNLINK_FILE" || op.op_kind === "RMDIR_EMPTY") {
      pendingRemovalSet.add(op.rel_path);
    }
  }

  try {
    for (const [relPath, firstOp] of firstPendingByPath.entries()) {
      const expBefore = JSON.parse(firstOp.expected_before_json) as WorkspaceEntryState;
      const expAfter = JSON.parse(firstOp.expected_after_json) as WorkspaceEntryState;

      if (firstOp.op_kind === "HALT_UNSUPPORTED") {
        conflicts.push({
          relPath,
          reason: firstOp.halt_reason ?? "UNSUPPORTED_ENTRY_TRANSITION",
          liveState: expBefore,
          expectedPre: expBefore,
          expectedTarget: expAfter
        });
        continue;
      }

      const inspected = inspectLivePathStateBeneath(realWs, wsFd, relPath);
      if (inspected.ancestorSymlink) {
        conflicts.push({
          relPath,
          reason: "ANCESTOR_SYMLINK_CONTAMINATION",
          liveState: inspected.state,
          expectedPre: expBefore,
          expectedTarget: expAfter
        });
        continue;
      }

      if (!entryStatesEqual(inspected.state, expBefore) && !entryStatesEqual(inspected.state, expAfter)) {
        conflicts.push({
          relPath,
          reason: "EXTERNAL_CONTENT_OR_MODE_EDIT",
          liveState: inspected.state,
          expectedPre: expBefore,
          expectedTarget: expAfter
        });
        continue;
      }

      if (firstOp.op_kind === "RMDIR_EMPTY" && inspected.state.kind === "dir") {
        const unscheduled = findUnscheduledChildrenForPendingRmdir(realWs, relPath, pendingRemovalSet);
        if (unscheduled.length > 0) {
          conflicts.push({
            relPath,
            reason: `UNSCHEDULED_CHILDREN_IN_RMDIR:${unscheduled.join(",")}`,
            liveState: inspected.state,
            expectedPre: expBefore,
            expectedTarget: expAfter
          });
        }
      }
    }
  } finally {
    fs.closeSync(wsFd);
  }

  if (conflicts.length > 0) {
    stateDb.db
      .prepare(
        `UPDATE rewind_journal
         SET phase = 'CONFLICT_HALTED', conflict_detail_json = ?, updated_at_ms = ?
         WHERE tx_id = ?`
      )
      .run(JSON.stringify(conflicts), Date.now(), txId);
    throw new RewindConflictError(txId, conflicts);
  }

  const markCompletedStmt = stateDb.db.prepare(
    `UPDATE rewind_ops SET status = 'COMPLETED', completed_at_ms = ? WHERE tx_id = ? AND op_seq = ?`
  );

  // Execute each PENDING operation sequentially, recording per-op completion immediately
  for (const op of pendingOps) {
    lock.assertHeld();
    const expBefore = JSON.parse(op.expected_before_json) as WorkspaceEntryState;
    const expAfter = JSON.parse(op.expected_after_json) as WorkspaceEntryState;

    const { wsFd: checkFd } = openWorkspaceRootFd(realWs);
    let liveNow: WorkspaceEntryState;
    try {
      const insp = inspectLivePathStateBeneath(realWs, checkFd, op.rel_path);
      if (insp.ancestorSymlink) {
        throw new RewindConflictError(txId, [
          {
            relPath: op.rel_path,
            reason: "ANCESTOR_SYMLINK_DURING_OP",
            liveState: insp.state,
            expectedPre: expBefore,
            expectedTarget: expAfter
          }
        ]);
      }
      liveNow = insp.state;
    } finally {
      fs.closeSync(checkFd);
    }

    // If syscall already took effect right before a previous crash (before SQLite UPDATE committed), promote cleanly!
    if (entryStatesEqual(liveNow, expAfter)) {
      markCompletedStmt.run(Date.now(), txId, op.op_seq);
      if (faultInjectStopAfterOpSeq !== undefined && op.op_seq >= faultInjectStopAfterOpSeq) {
        throw new Error(`FAULT_INJECT_CRASH_AFTER_OP_SEQ_${op.op_seq}`);
      }
      continue;
    }

    if (!entryStatesEqual(liveNow, expBefore)) {
      throw new RewindConflictError(txId, [
        {
          relPath: op.rel_path,
          reason: `CONCURRENT_MUTATION_AT_OP_${op.op_seq}`,
          liveState: liveNow,
          expectedPre: expBefore,
          expectedTarget: expAfter
        }
      ]);
    }

    try {
      switch (op.op_kind) {
        case "UNLINK_FILE": {
          unlinkSafeBeneathWorkspace({ workspaceRoot: realWs, relPath: op.rel_path });
          break;
        }
        case "RMDIR_EMPTY": {
          rmdirEmptyBeneathWorkspace(realWs, op.rel_path);
          break;
        }
        case "ENSURE_DIR": {
          mkdirSingleBeneathWorkspace(realWs, op.rel_path);
          break;
        }
        case "WRITE_BLOB": {
          if (!op.git_blob_oid) {
            throw new Error(`WRITE_BLOB op missing git_blob_oid for '${op.rel_path}'`);
          }
          const blobBytes = execFileSync("git", ["cat-file", "blob", op.git_blob_oid], {
            cwd: realWs,
            maxBuffer: 128 * 1024 * 1024
          });
          const exactMode = expAfter.mode !== null ? expAfter.mode : 0o644;
          writeFileDurable(path.join(realWs, op.rel_path), blobBytes, durabilityMode, {
            mode: exactMode,
            workspaceRoot: realWs
          });
          break;
        }
        default:
          throw new Error(`Unexpected op_kind '${op.op_kind}'`);
      }
    } catch (err) {
      if (err instanceof PathContainmentError) {
        throw new RewindConflictError(txId, [
          {
            relPath: op.rel_path,
            reason: err.message,
            liveState: liveNow,
            expectedPre: expBefore,
            expectedTarget: expAfter
          }
        ]);
      }
      throw err;
    }

    markCompletedStmt.run(Date.now(), txId, op.op_seq);

    if (faultInjectStopAfterOpSeq !== undefined && op.op_seq >= faultInjectStopAfterOpSeq) {
      throw new Error(`FAULT_INJECT_CRASH_AFTER_OP_SEQ_${op.op_seq}`);
    }
  }

  if (durabilityMode === "power-loss-safe") {
    const { wsFd: syncWsFd } = openWorkspaceRootFd(realWs);
    try {
      fs.fsyncSync(syncWsFd);
    } finally {
      fs.closeSync(syncWsFd);
    }
  }
}

function anchorPiSessionLeafDurable(
  sessionManager: SessionManager,
  txId: string,
  toLeafId: string,
  durabilityMode: DurabilityMode
): string {
  const currentLeafEntry = sessionManager.getLeafEntry() as
    | { id: string; type: string; customType?: string; data?: { txId?: string; toLeafId?: string } }
    | undefined;

  if (
    currentLeafEntry?.type === "custom" &&
    currentLeafEntry.customType === "pi_apex_rewind_anchor" &&
    currentLeafEntry.data?.txId === txId
  ) {
    return currentLeafEntry.id;
  }

  sessionManager.branch(toLeafId);
  const anchorId = sessionManager.appendCustomEntry("pi_apex_rewind_anchor", { txId, toLeafId });
  syncSessionTranscriptDurable(sessionManager.getSessionFile(), durabilityMode, false);
  return anchorId;
}

export interface RewindExecutionOptions {
  stateDb: StateDb;
  workspaceRoot: string;
  sessionManager: SessionManager;
  sessionId: string;
  fromLeafId: string;
  toLeafId: string;
  durabilityMode?: DurabilityMode;
  faultInjectStopAfterPhase?: "PREPARING" | "DISK_APPLIED";
  /** Fault-injection hook crashing right after `op_seq` completes inside `APPLYING_DISK`! */
  faultInjectStopAfterOpSeq?: number;
}

export function rewindChatAndDiskToLeaf(opts: RewindExecutionOptions): {
  txId: string;
  safetyGitRef: string | null;
  anchorLeafId: string;
  restoredPaths: string[];
  deletedPaths: string[];
} {
  const durabilityMode = opts.durabilityMode ?? opts.stateDb.durabilityMode;

  return withWorkspaceLock(opts.workspaceRoot, (lock) => {
    const targetCp = opts.stateDb.db
      .prepare(
        `SELECT git_tree_oid, file_hashes_json, entry_states_json
         FROM git_checkpoints WHERE session_id = ? AND leaf_id = ?`
      )
      .get(opts.sessionId, opts.toLeafId) as
      | { git_tree_oid: string; file_hashes_json: string; entry_states_json: string }
      | undefined;

    if (!targetCp) {
      throw new Error(`Target checkpoint not found for leaf ${opts.toLeafId}`);
    }

    const fromCp = opts.stateDb.db
      .prepare(
        `SELECT git_tree_oid, entry_states_json
         FROM git_checkpoints WHERE session_id = ? AND leaf_id = ?`
      )
      .get(opts.sessionId, opts.fromLeafId) as
      | { git_tree_oid: string; entry_states_json: string }
      | undefined;

    const currentSnap = snapshotWorkingTreeToGit(opts.workspaceRoot);
    const txId = `rw_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const fromStatesRaw = fromCp?.entry_states_json ?? "";
    const curStatesRaw = JSON.stringify(currentSnap.entryStates);
    let safetyGitRef: string | null = null;
    if (!fromCp || currentSnap.gitTreeOid !== fromCp.git_tree_oid || curStatesRaw !== fromStatesRaw) {
      const commitOid = execFileSync(
        "git",
        ["commit-tree", currentSnap.gitTreeOid, "-m", `pi-apex pre-rewind safety (${txId})`],
        { cwd: opts.workspaceRoot, encoding: "utf8" }
      ).trim();
      safetyGitRef = `refs/pi-apex/safety/${txId}`;
      execFileSync("git", ["update-ref", safetyGitRef, commitOid], { cwd: opts.workspaceRoot });
    }

    const targetEntryStates = JSON.parse(targetCp.entry_states_json || "{}") as Record<
      string,
      WorkspaceEntryState
    >;
    const targetTreeManifest = readGitTreeManifest(opts.workspaceRoot, targetCp.git_tree_oid);

    const compiled = compileRewindOperations({
      currentEntries: currentSnap.entryStates,
      currentDiskDirs: currentSnap.directories,
      targetEntries: targetEntryStates,
      targetTreeManifest
    });

    const preStatesSummary: Record<string, WorkspaceEntryState> = {};
    const targetStatesSummary: Record<string, WorkspaceEntryState> = {};
    const preHashesSummary: Record<string, string> = {};
    const targetHashesSummary: Record<string, string> = {};

    for (const op of compiled.ops) {
      if (!(op.relPath in preStatesSummary)) {
        preStatesSummary[op.relPath] = op.expectedBefore;
        preHashesSummary[op.relPath] = op.expectedBefore.hash ?? op.expectedBefore.kind.toUpperCase();
      }
      targetStatesSummary[op.relPath] = op.expectedAfter;
      targetHashesSummary[op.relPath] = op.expectedAfter.hash ?? op.expectedAfter.kind.toUpperCase();
    }

    lock.assertHeld();
    const now = Date.now();
    opts.stateDb.db.exec("BEGIN IMMEDIATE");
    try {
      opts.stateDb.db
        .prepare(
          `INSERT INTO rewind_journal (
            tx_id, session_id, from_leaf_id, to_leaf_id,
            source_git_tree_oid, target_git_tree_oid, safety_git_ref,
            pre_hashes_json, target_hashes_json,
            pre_states_json, target_states_json,
            restore_paths_json, delete_paths_json,
            phase, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?)`
        )
        .run(
          txId,
          opts.sessionId,
          opts.fromLeafId,
          opts.toLeafId,
          currentSnap.gitTreeOid,
          targetCp.git_tree_oid,
          safetyGitRef,
          JSON.stringify(preHashesSummary),
          JSON.stringify(targetHashesSummary),
          JSON.stringify(preStatesSummary),
          JSON.stringify(targetStatesSummary),
          JSON.stringify(compiled.restorePaths),
          JSON.stringify(compiled.deletePaths),
          now,
          now
        );

      const insertOpStmt = opts.stateDb.db.prepare(
        `INSERT INTO rewind_ops (
          tx_id, op_seq, op_kind, rel_path,
          expected_before_json, expected_after_json,
          git_blob_oid, halt_reason, status, completed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL)`
      );
      compiled.ops.forEach((op, idx) => {
        insertOpStmt.run(
          txId,
          idx,
          op.opKind,
          op.relPath,
          JSON.stringify(op.expectedBefore),
          JSON.stringify(op.expectedAfter),
          op.gitBlobOid,
          op.haltReason
        );
      });

      opts.stateDb.db.exec("COMMIT");
    } catch (err) {
      opts.stateDb.db.exec("ROLLBACK");
      throw err;
    }

    if (opts.faultInjectStopAfterPhase === "PREPARING") {
      throw new Error("FAULT_INJECT_CRASH_AFTER_PREPARING");
    }

    lock.assertHeld();
    opts.stateDb.db
      .prepare(`UPDATE rewind_journal SET phase = 'APPLYING_DISK', updated_at_ms = ? WHERE tx_id = ?`)
      .run(Date.now(), txId);

    executePendingRewindOps({
      lock,
      stateDb: opts.stateDb,
      txId,
      workspaceRoot: opts.workspaceRoot,
      durabilityMode,
      faultInjectStopAfterOpSeq: opts.faultInjectStopAfterOpSeq
    });

    lock.assertHeld();
    opts.stateDb.db
      .prepare(`UPDATE rewind_journal SET phase = 'DISK_APPLIED', updated_at_ms = ? WHERE tx_id = ?`)
      .run(Date.now(), txId);

    if (opts.faultInjectStopAfterPhase === "DISK_APPLIED") {
      throw new Error("FAULT_INJECT_CRASH_AFTER_DISK_APPLIED");
    }

    lock.assertHeld();
    const anchorLeafId = anchorPiSessionLeafDurable(opts.sessionManager, txId, opts.toLeafId, durabilityMode);

    opts.stateDb.db
      .prepare(`UPDATE rewind_journal SET phase = 'COMPLETED', updated_at_ms = ? WHERE tx_id = ?`)
      .run(Date.now(), txId);

    return {
      txId,
      safetyGitRef,
      anchorLeafId,
      restoredPaths: compiled.restorePaths,
      deletedPaths: compiled.deletePaths
    };
  });
}

export function recoverInterruptedRewinds(params: {
  stateDb: StateDb;
  workspaceRoot: string;
  sessionManager: SessionManager;
  sessionId: string;
  durabilityMode?: DurabilityMode;
}): Array<{ txId: string; recoveredAnchorLeafId: string }> {
  const durabilityMode = params.durabilityMode ?? params.stateDb.durabilityMode;

  return withWorkspaceLock(params.workspaceRoot, (lock) => {
    const incomplete = params.stateDb.db
      .prepare(
        `SELECT tx_id, to_leaf_id, phase FROM rewind_journal
         WHERE session_id = ? AND phase IN ('PREPARING', 'APPLYING_DISK', 'DISK_APPLIED')
         ORDER BY created_at_ms ASC`
      )
      .all(params.sessionId) as Array<{
      tx_id: string;
      to_leaf_id: string;
      phase: string;
    }>;

    const recovered: Array<{ txId: string; recoveredAnchorLeafId: string }> = [];

    for (const row of incomplete) {
      if (row.phase !== "DISK_APPLIED") {
        executePendingRewindOps({
          lock,
          stateDb: params.stateDb,
          txId: row.tx_id,
          workspaceRoot: params.workspaceRoot,
          durabilityMode
        });
        lock.assertHeld();
        params.stateDb.db
          .prepare(`UPDATE rewind_journal SET phase = 'DISK_APPLIED', updated_at_ms = ? WHERE tx_id = ?`)
          .run(Date.now(), row.tx_id);
      }

      lock.assertHeld();
      const anchorId = anchorPiSessionLeafDurable(params.sessionManager, row.tx_id, row.to_leaf_id, durabilityMode);
      params.stateDb.db
        .prepare(`UPDATE rewind_journal SET phase = 'COMPLETED', updated_at_ms = ? WHERE tx_id = ?`)
        .run(Date.now(), row.tx_id);
      recovered.push({ txId: row.tx_id, recoveredAnchorLeafId: anchorId });
    }

    return recovered;
  });
}
