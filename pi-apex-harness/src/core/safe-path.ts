import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractNativeErrnoCode, getLinuxFsBridge } from "./linux-fs-bridge.ts";

export const DEFAULT_UNMASKED_SECRET_EXCEPTIONS = [
  ".env.example",
  ".env.sample",
  ".env.template"
] as const;

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathContainmentError";
  }
}

export function isSecretBasename(
  basename: string,
  unmaskedExceptions: readonly string[] = DEFAULT_UNMASKED_SECRET_EXCEPTIONS
): boolean {
  if (unmaskedExceptions.includes(basename)) return false;
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  if (
    basename === ".npmrc" ||
    basename === ".netrc" ||
    basename === ".pypirc" ||
    basename === ".pgpass"
  ) {
    return true;
  }
  if (
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename === "id_ecdsa" ||
    basename === "id_dsa"
  ) {
    return true;
  }
  if (
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx")
  ) {
    return true;
  }
  return false;
}

export const MAX_SECRET_SCAN_DEPTH = 32;
export const MAX_SECRET_SCAN_DIRECTORIES = 25000;
export const MAX_CONTROL_PLANE_SCAN_ENTRIES = 100000;

export interface SecretScanResult {
  realWorkspaceRoot: string;
  allMaskedPaths: string[];
  hardlinkAliasPaths: string[];
  secretInodeKeys: Set<string>;
  controlPlaneHasHardlinks: boolean;
  complete: boolean;
  incompleteReasons: string[];
}

/**
 * Recursively discovers secret files at ANY depth inside `<workspaceRoot>` (including untracked
 * and `.gitignore`d directories like `service/.env`) AND resolves hardlink aliases (`st.nlink > 1`)
 * via `(dev, ino)` inode matching. Never traverses symlinks.
 */
export function scanWorkspaceSecretsAndHardlinks(
  workspaceRoot: string,
  unmaskedExceptions: readonly string[] = DEFAULT_UNMASKED_SECRET_EXCEPTIONS
): SecretScanResult {
  if (!fs.existsSync(workspaceRoot)) {
    return {
      realWorkspaceRoot: path.resolve(workspaceRoot),
      allMaskedPaths: [],
      hardlinkAliasPaths: [],
      secretInodeKeys: new Set(),
      controlPlaneHasHardlinks: false,
      complete: true,
      incompleteReasons: []
    };
  }

  const realWs = fs.realpathSync(workspaceRoot);
  const maskedSet = new Set<string>();
  const hardlinkAliases: string[] = [];
  const secretInodeKeys = new Set<string>();
  const multiLinkedInodeKeys = new Set<string>();
  let expectedExtraHardlinks = 0;
  let complete = true;
  const incompleteReasons: string[] = [];
  let totalDirectoriesVisited = 0;
  let controlPlaneHasHardlinks = false;
  let controlPlaneEntries = 0;

  const deferredHeavyDirs: string[] = [];

  const walkPass1 = (absDir: string, relDir: string, depth: number = 0) => {
    if (depth >= MAX_SECRET_SCAN_DEPTH) {
      complete = false;
      incompleteReasons.push(
        `Maximum scan depth (${MAX_SECRET_SCAN_DEPTH}) reached at '${absDir}'`
      );
      return;
    }
    if (++totalDirectoriesVisited > MAX_SECRET_SCAN_DIRECTORIES) {
      complete = false;
      incompleteReasons.push(
        `Maximum directory scan count (${MAX_SECRET_SCAN_DIRECTORIES}) exceeded at '${absDir}'`
      );
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      complete = false;
      incompleteReasons.push(
        `Directory read error at '${absDir}': ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (relPath === ".git" || relPath === ".harness") continue;
        if (entry.name === "node_modules" || entry.name === ".venv") {
          deferredHeavyDirs.push(absPath);
          continue;
        }
        walkPass1(absPath, relPath, depth + 1);
        continue;
      }

      if (entry.isFile() && isSecretBasename(entry.name, unmaskedExceptions)) {
        try {
          const st = fs.lstatSync(absPath);
          if (!st.isFile()) continue;
          const key = `${st.dev}:${st.ino}`;
          maskedSet.add(absPath);
          secretInodeKeys.add(key);
          if (st.nlink > 1) {
            multiLinkedInodeKeys.add(key);
            expectedExtraHardlinks += st.nlink - 1;
          }
        } catch (err) {
          complete = false;
          incompleteReasons.push(
            `lstat error on file '${absPath}': ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  };

  walkPass1(realWs, "", 0);

  // Private control-plane data is not named like a conventional secret. Track
  // linked inodes so workspace aliases cannot bypass session-aware reads.
  const harnessDir = path.join(realWs, ".harness");
  let controlPlaneScanStopped = false;
  const stopControlPlaneScan = (reason: string) => {
    complete = false;
    controlPlaneScanStopped = true;
    incompleteReasons.push(reason);
  };
  const scanControlPlane = (dir: string, depth: number) => {
    if (controlPlaneScanStopped) return;
    if (depth >= MAX_SECRET_SCAN_DEPTH || ++totalDirectoriesVisited > MAX_SECRET_SCAN_DIRECTORIES) {
      stopControlPlaneScan(`Control-plane scan limit reached at '${dir}'`);
      return;
    }
    let stream: fs.Dir | undefined;
    try {
      stream = fs.opendirSync(dir);
      while (!controlPlaneScanStopped) {
        const entry = stream.readSync();
        if (!entry) break;
        if (++controlPlaneEntries > MAX_CONTROL_PLANE_SCAN_ENTRIES) {
          stopControlPlaneScan(`Control-plane entry limit reached at '${dir}'`);
          break;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scanControlPlane(full, depth + 1);
        else if (entry.isFile()) {
          try {
            const st = fs.lstatSync(full);
            if (!st.isFile()) throw new Error("file changed during scan");
            if (st.nlink > 1) {
              controlPlaneHasHardlinks = true;
              secretInodeKeys.add(`${st.dev}:${st.ino}`);
            }
          } catch (err) {
            stopControlPlaneScan(`Control-plane file inspection error at '${full}': ${String(err)}`);
          }
        } else {
          stopControlPlaneScan(`Control-plane entry is a symlink or non-regular file: '${full}'`);
        }
      }
    } catch (err) {
      stopControlPlaneScan(`Control-plane directory read error at '${dir}': ${String(err)}`);
    } finally {
      if (stream) {
        try { stream.closeSync(); }
        catch (err) { stopControlPlaneScan(`Control-plane directory close error at '${dir}': ${String(err)}`); }
      }
    }
  };
  try {
    const st = fs.lstatSync(harnessDir);
    if (!st.isDirectory()) {
      complete = false;
      incompleteReasons.push("Control-plane path is not a directory");
    } else scanControlPlane(harnessDir, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      complete = false;
      incompleteReasons.push(`Control-plane inspection error: ${String(err)}`);
    }
  }

  const walkHeavyDir = (absDir: string, depth: number = 0) => {
    if (depth >= MAX_SECRET_SCAN_DEPTH) {
      complete = false;
      incompleteReasons.push(
        `Maximum heavy directory scan depth (${MAX_SECRET_SCAN_DEPTH}) reached at '${absDir}'`
      );
      return;
    }
    if (++totalDirectoriesVisited > MAX_SECRET_SCAN_DIRECTORIES) {
      complete = false;
      incompleteReasons.push(
        `Maximum heavy directory scan count (${MAX_SECRET_SCAN_DIRECTORIES}) exceeded at '${absDir}'`
      );
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      complete = false;
      incompleteReasons.push(
        `Heavy directory read error at '${absDir}': ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === ".harness") continue;
        walkHeavyDir(absPath, depth + 1);
        continue;
      }
      if (entry.isFile() && isSecretBasename(entry.name, unmaskedExceptions)) {
        try {
          const st = fs.lstatSync(absPath);
          if (st.isFile()) {
            const key = `${st.dev}:${st.ino}`;
            maskedSet.add(absPath);
            secretInodeKeys.add(key);
            if (st.nlink > 1) {
              multiLinkedInodeKeys.add(key);
              expectedExtraHardlinks += st.nlink - 1;
            }
          }
        } catch (err) {
          complete = false;
          incompleteReasons.push(
            `lstat error on heavy file '${absPath}': ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  };

  for (const heavyDir of deferredHeavyDirs) {
    walkHeavyDir(heavyDir, 0);
  }

  if (multiLinkedInodeKeys.size > 0) {
    let foundAliases = 0;
    const sweepInodes = (absDir: string, includeVendor: boolean, depth: number = 0) => {
      if (depth >= MAX_SECRET_SCAN_DEPTH) {
        complete = false;
        incompleteReasons.push(
          `Maximum inode sweep depth (${MAX_SECRET_SCAN_DEPTH}) reached at '${absDir}'`
        );
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        complete = false;
        incompleteReasons.push(
          `Inode sweep directory read error at '${absDir}': ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absPath = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git" || entry.name === ".harness") continue;
          if (!includeVendor && (entry.name === "node_modules" || entry.name === ".venv")) continue;
          sweepInodes(absPath, includeVendor, depth + 1);
          continue;
        }
        if (entry.isFile() && !maskedSet.has(absPath)) {
          try {
            const st = fs.lstatSync(absPath);
            if (st.isFile() && multiLinkedInodeKeys.has(`${st.dev}:${st.ino}`)) {
              maskedSet.add(absPath);
              hardlinkAliases.push(absPath);
              foundAliases += 1;
            }
          } catch {
            // ignore
          }
        }
      }
    };

    sweepInodes(realWs, false, 0);
    if (foundAliases < expectedExtraHardlinks) {
      for (const heavyDir of deferredHeavyDirs) {
        sweepInodes(heavyDir, true, 0);
      }
    }
  }

  return {
    realWorkspaceRoot: realWs,
    allMaskedPaths: Array.from(maskedSet).sort(),
    hardlinkAliasPaths: hardlinkAliases.sort(),
    secretInodeKeys,
    controlPlaneHasHardlinks,
    complete,
    incompleteReasons
  };
}

/**
 * Recursively locates all Git repositories (root, submodules, nested repositories, linked worktrees)
 * beneath `workspaceRoot`.
 */
export function findWorkspaceGitRoots(workspaceRoot: string): string[] {
  const realWs = fs.realpathSync(workspaceRoot);
  const gitRoots: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth >= MAX_SECRET_SCAN_DEPTH || ++visited > MAX_SECRET_SCAN_DIRECTORIES) {
      throw new PathContainmentError(`Incomplete Git repository discovery at '${dir}': scan limit reached`);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new PathContainmentError(`Incomplete Git repository discovery at '${dir}': ${String(err)}`);
    }
    for (const entry of entries) {
      if (entry.name === ".git") {
        if (!entry.isDirectory() && !entry.isFile()) {
          throw new PathContainmentError(`Unsafe .git metadata entry at '${dir}'`);
        }
        gitRoots.push(dir);
        continue;
      }
      // The root control plane is independently hidden by the bwrap mount.
      if (dir === realWs && entry.name === ".harness") continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(realWs, 0);
  return gitRoots;
}

/**
 * Reviewer #4 Issue #2 Fix & Programme D1:
 * Scans Git index and commit history (`git ls-files` + `git log --all --name-only`) across ALL
 * root and nested repositories/submodules/worktrees for any tracked or historical secret-named blob
 * (e.g. a `.env` or `service/.env` committed in the past whose plaintext remains inside `.git/objects`).
 */
export function auditGitHistoryForSecretPaths(
  workspaceRoot: string,
  unmaskedExceptions: readonly string[] = DEFAULT_UNMASKED_SECRET_EXCEPTIONS
): { hasHistoricalSecrets: boolean; hasStagedSecrets: boolean; matchedPaths: string[] } {
  const gitRoots = findWorkspaceGitRoots(workspaceRoot);
  if (gitRoots.length === 0) {
    return { hasHistoricalSecrets: false, hasStagedSecrets: false, matchedPaths: [] };
  }

  const matched = new Set<string>();
  let hasStaged = false;

  for (const root of gitRoots) {
    try {
      const cachedOut = execFileSync("git", ["ls-files", "-z"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 16 * 1024 * 1024
      });
      for (const p of cachedOut.split("\0")) {
        if (!p) continue;
        if (isSecretBasename(path.posix.basename(p), unmaskedExceptions)) {
          const relToWs = path.relative(workspaceRoot, path.resolve(root, p)).replace(/\\/g, "/");
          matched.add(relToWs);
          hasStaged = true;
        }
      }
    } catch {
      // non-fatal
    }

    try {
      const logOut = execFileSync("git", ["log", "--all", "--pretty=format:", "--name-only", "-z"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024
      });
      for (const p of logOut.split("\0")) {
        const clean = p.replace(/^\n+/, "");
        if (!clean) continue;
        if (isSecretBasename(path.posix.basename(clean), unmaskedExceptions)) {
          const relToWs = path.relative(workspaceRoot, path.resolve(root, clean)).replace(/\\/g, "/");
          matched.add(relToWs);
        }
      }
    } catch {
      // empty repo without commits yet
    }
  }

  return {
    hasHistoricalSecrets: matched.size > 0,
    hasStagedSecrets: hasStaged,
    matchedPaths: Array.from(matched).sort()
  };
}

export function normalizeLexicalWorkspaceRelPath(
  workspaceRoot: string,
  candidatePath: string
): { realWs: string; lexicalTarget: string; relPath: string } {
  const realWs = fs.realpathSync(workspaceRoot);
  const absWsInput = path.resolve(workspaceRoot);

  let normalizedCandidate: string;
  if (path.isAbsolute(candidatePath)) {
    const resolvedCand = path.resolve(candidatePath);
    if (resolvedCand === absWsInput) {
      normalizedCandidate = realWs;
    } else if (resolvedCand.startsWith(absWsInput + path.sep)) {
      normalizedCandidate = path.join(realWs, resolvedCand.slice(absWsInput.length + 1));
    } else {
      normalizedCandidate = resolvedCand;
    }
  } else {
    normalizedCandidate = path.resolve(realWs, candidatePath);
  }

  const lexicalTarget = path.resolve(normalizedCandidate);
  if (lexicalTarget !== realWs && !lexicalTarget.startsWith(realWs + path.sep)) {
    throw new PathContainmentError(`[guard: path outside workspace denied: ${candidatePath}]`);
  }

  const relPath = path.relative(realWs, lexicalTarget).replace(/\\/g, "/");
  return { realWs, lexicalTarget, relPath };
}

export function openWorkspaceRootFd(workspaceRoot: string): { realWs: string; wsFd: number } {
  const bridge = getLinuxFsBridge();
  const realWs = fs.realpathSync(workspaceRoot);
  const wsFd = bridge.openRootDir(realWs);
  return { realWs, wsFd };
}

export function verifyOpenFdContainedInWorkspace(fd: number, realWs: string): void {
  const bridge = getLinuxFsBridge();
  let resolvedKernelPath: string | null = null;
  if (bridge.getFdPath) {
    try {
      resolvedKernelPath = bridge.getFdPath(fd);
    } catch {
      // ignore
    }
  }
  if (!resolvedKernelPath && fs.existsSync("/proc/self/fd")) {
    resolvedKernelPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
  }
  if (!resolvedKernelPath) return;
  if (resolvedKernelPath !== realWs && !resolvedKernelPath.startsWith(realWs + path.sep)) {
    throw new PathContainmentError(
      `[guard: open-FD kernel path escaped workspace (${resolvedKernelPath})]`
    );
  }
}

/**
 * Opens the parent directory of `relPath` strictly beneath `wsFd` via Linux `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`.
 * When `createMissingDirs` is true, creates missing directories step-by-step via `mkdiratSingle`.
 * Caller MUST `fs.closeSync(parentDirFd)` when `ownsFd === true`.
 */
export function openParentDirFdBeneath(params: {
  wsFd: number;
  realWs: string;
  relPath: string;
  createMissingDirs: boolean;
}): { parentDirFd: number; ownsFd: boolean; leafName: string } {
  const bridge = getLinuxFsBridge();
  const { wsFd, realWs, relPath, createMissingDirs } = params;
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new PathContainmentError(`[guard: empty relative path has no parent/leaf]`);
  }

  const leafName = parts[parts.length - 1];
  const dirParts = parts.slice(0, -1);
  if (dirParts.length === 0) {
    verifyOpenFdContainedInWorkspace(wsFd, realWs);
    return { parentDirFd: wsFd, ownsFd: false, leafName };
  }

  const dirFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);

  if (!createMissingDirs) {
    try {
      const parentFd = bridge.openBeneath(wsFd, dirParts.join("/"), dirFlags, 0);
      verifyOpenFdContainedInWorkspace(parentFd, realWs);
      return { parentDirFd: parentFd, ownsFd: true, leafName };
    } catch (err) {
      const code = extractNativeErrnoCode(err);
      if (code === "ELOOP" || code === "EXDEV" || code === "ENOTDIR") {
        throw new PathContainmentError(
          `[guard: symlink or non-directory ancestor rejected by openat2 (${code}): ${dirParts.join("/")}]`
        );
      }
      if (code === "ENOENT") {
        const enoent = new Error(`ENOENT: no such directory '${dirParts.join("/")}'`) as NodeJS.ErrnoException;
        enoent.code = "ENOENT";
        throw enoent;
      }
      throw err;
    }
  }

  // Stepwise descriptor-relative mkdirat + openBeneath
  let curFd = wsFd;
  let curOwns = false;

  try {
    for (let i = 0; i < dirParts.length; i++) {
      const seg = dirParts[i];
      let nextFd: number;
      try {
        nextFd = bridge.openBeneath(curFd, seg, dirFlags, 0);
      } catch (err) {
        const code = extractNativeErrnoCode(err);
        if (code === "ENOENT") {
          try {
            bridge.mkdiratSingle(curFd, seg, 0o755);
          } catch (mkErr) {
            const mkCode = extractNativeErrnoCode(mkErr);
            if (mkCode !== "EEXIST") {
              throw new PathContainmentError(
                `[guard: mkdirat failed on '${seg}' (${mkCode ?? String(mkErr)})]`
              );
            }
          }
          try {
            nextFd = bridge.openBeneath(curFd, seg, dirFlags, 0);
          } catch (reErr) {
            const reCode = extractNativeErrnoCode(reErr);
            throw new PathContainmentError(
              `[guard: post-mkdirat openat2 rejected '${seg}' (${reCode ?? String(reErr)})]`
            );
          }
        } else {
          throw new PathContainmentError(
            `[guard: unsafe ancestor component '${seg}' rejected by openat2 (${code ?? String(err)})]`
          );
        }
      }

      if (curOwns) fs.closeSync(curFd);
      curFd = nextFd;
      curOwns = true;
    }

    verifyOpenFdContainedInWorkspace(curFd, realWs);
    return { parentDirFd: curFd, ownsFd: curOwns, leafName };
  } catch (err) {
    if (curOwns) {
      try {
        fs.closeSync(curFd);
      } catch {
        // ignore
      }
    }
    throw err;
  }
}

export interface ContainedPathInfo {
  realWs: string;
  lexicalTarget: string;
  relPath: string;
  leafStat: fs.Stats | null;
}

/**
 * Validates workspace containment via `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` + `fstatatNoFollow`.
 */
export function assertNoSymlinkAncestorsAndContain(
  workspaceRoot: string,
  candidatePath: string
): ContainedPathInfo {
  const { realWs, lexicalTarget, relPath } = normalizeLexicalWorkspaceRelPath(workspaceRoot, candidatePath);
  if (!relPath) {
    return { realWs, lexicalTarget, relPath: "", leafStat: fs.lstatSync(realWs) };
  }

  const { wsFd } = openWorkspaceRootFd(realWs);
  try {
    let parentInfo: { parentDirFd: number; ownsFd: boolean; leafName: string };
    try {
      parentInfo = openParentDirFdBeneath({
        wsFd,
        realWs,
        relPath,
        createMissingDirs: false
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Check existing prefix components for symlinks before returning ENOENT leaf
        const parts = relPath.split("/");
        let curFd = wsFd;
        let curOwns = false;
        const bridge = getLinuxFsBridge();
        const dirFlags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0);
        try {
          for (let i = 0; i < parts.length - 1; i++) {
            const entry = bridge.fstatatNoFollow(curFd, parts[i]);
            if (!entry) break;
            if (entry.kind !== "dir") {
              throw new PathContainmentError(
                `[guard: symlink or non-directory ancestor denied: ${parts.slice(0, i + 1).join("/")}]`
              );
            }
            const nextFd = bridge.openBeneath(curFd, parts[i], dirFlags, 0);
            if (curOwns) fs.closeSync(curFd);
            curFd = nextFd;
            curOwns = true;
          }
        } finally {
          if (curOwns) fs.closeSync(curFd);
        }
        return { realWs, lexicalTarget, relPath, leafStat: null };
      }
      throw err;
    }

    try {
      const bridge = getLinuxFsBridge();
      const entry = bridge.fstatatNoFollow(parentInfo.parentDirFd, parentInfo.leafName);
      if (!entry) {
        return { realWs, lexicalTarget, relPath, leafStat: null };
      }
      // Return lstat on `/proc/self/fd/<parentDirFd>/<leafName>` on Linux so stat never re-walks pathname,
      // or lexicalTarget on Darwin/BSD where /proc/self/fd magic symlinks are unavailable.
      const leafStat = fs.existsSync("/proc/self/fd")
        ? fs.lstatSync(`/proc/self/fd/${parentInfo.parentDirFd}/${parentInfo.leafName}`)
        : fs.lstatSync(lexicalTarget);
      return { realWs, lexicalTarget, relPath, leafStat };
    } finally {
      if (parentInfo.ownsFd) fs.closeSync(parentInfo.parentDirFd);
    }
  } finally {
    fs.closeSync(wsFd);
  }
}

export function mkdirSafeWithinWorkspace(realWs: string, targetDir: string): void {
  const { relPath } = normalizeLexicalWorkspaceRelPath(realWs, targetDir);
  if (!relPath) return;

  const { wsFd } = openWorkspaceRootFd(realWs);
  try {
    // Create targetDir + ancestors via descriptor-relative mkdiratSingle + openBeneath
    const sentinelRel = `${relPath}/.mkdir_probe`;
    const p = openParentDirFdBeneath({
      wsFd,
      realWs,
      relPath: sentinelRel,
      createMissingDirs: true
    });
    if (p.ownsFd) fs.closeSync(p.parentDirFd);
  } finally {
    fs.closeSync(wsFd);
  }
}

/**
 * Reviewer #4 Issue #1 Fix:
 * Descriptor-relative file/symlink deletion via `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` + `unlinkat(parentDirFd, leafName, 0)`.
 * Even if an ancestor directory is replaced by a symlink AFTER validation and BEFORE `unlinkat`,
 * `unlinkat` operates on the pinned `parentDirFd` inode and NEVER touches files outside `<workspaceRoot>`!
 */
export function unlinkSafeBeneathWorkspace(params: {
  workspaceRoot: string;
  relPath: string;
  allowSymlinkLeaf?: boolean;
  syncParentDir?: boolean;
  /** Test-only race-injection hook executed AFTER opening `parentDirFd` and BEFORE `unlinkatSingle`! */
  testRaceHookBeforeUnlink?: () => void;
}): boolean {
  const bridge = getLinuxFsBridge();
  const { realWs, relPath } = normalizeLexicalWorkspaceRelPath(params.workspaceRoot, params.relPath);
  if (!relPath) throw new PathContainmentError(`[guard: cannot unlink workspace root]`);

  const { wsFd } = openWorkspaceRootFd(realWs);
  try {
    let parentInfo: { parentDirFd: number; ownsFd: boolean; leafName: string };
    try {
      parentInfo = openParentDirFdBeneath({
        wsFd,
        realWs,
        relPath,
        createMissingDirs: false
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }

    try {
      const entry = bridge.fstatatNoFollow(parentInfo.parentDirFd, parentInfo.leafName);
      if (!entry) return false;
      if (entry.kind === "dir" || (entry.kind === "symlink" && !params.allowSymlinkLeaf)) {
        throw new PathContainmentError(
          `[guard: refusing to unlink unexpected ${entry.kind} at '${relPath}']`
        );
      }

      if (params.testRaceHookBeforeUnlink) {
        params.testRaceHookBeforeUnlink();
      }

      // Confirm open `parentDirFd` itself was not moved outside `realWs` before executing `unlinkat`
      verifyOpenFdContainedInWorkspace(parentInfo.parentDirFd, realWs);
      bridge.unlinkatSingle(parentInfo.parentDirFd, parentInfo.leafName, false);
      if (params.syncParentDir) {
        fs.fsyncSync(parentInfo.parentDirFd);
      }
      return true;
    } finally {
      if (parentInfo.ownsFd) fs.closeSync(parentInfo.parentDirFd);
    }
  } finally {
    fs.closeSync(wsFd);
  }
}

/**
 * Distinct descriptor-relative single-directory creation (`mkdirat(parentDirFd, leafName, 0755)`).
 * Used by `rewind_ops` (`ENSURE_DIR`).
 */
export function mkdirSingleBeneathWorkspace(workspaceRoot: string, relDirPath: string, syncParentDir = false): void {
  const bridge = getLinuxFsBridge();
  const { realWs, relPath } = normalizeLexicalWorkspaceRelPath(workspaceRoot, relDirPath);
  if (!relPath) return;

  const { wsFd } = openWorkspaceRootFd(realWs);
  try {
    const pInfo = openParentDirFdBeneath({
      wsFd,
      realWs,
      relPath,
      createMissingDirs: false
    });
    try {
      verifyOpenFdContainedInWorkspace(pInfo.parentDirFd, realWs);
      try {
        bridge.mkdiratSingle(pInfo.parentDirFd, pInfo.leafName, 0o755);
        if (syncParentDir) {
          fs.fsyncSync(pInfo.parentDirFd);
        }
      } catch (err) {
        const code = extractNativeErrnoCode(err);
        if (code === "EEXIST") {
          const st = bridge.fstatatNoFollow(pInfo.parentDirFd, pInfo.leafName);
          if (st?.kind === "dir") return;
        }
        throw new PathContainmentError(
          `[guard: mkdiratSingle failed for '${relPath}' (${code ?? String(err)})]`
        );
      }
    } finally {
      if (pInfo.ownsFd) fs.closeSync(pInfo.parentDirFd);
    }
  } finally {
    fs.closeSync(wsFd);
  }
}

/**
 * Distinct descriptor-relative empty-directory removal (`unlinkat(parentDirFd, leafName, AT_REMOVEDIR)`).
 * Fails if directory is non-empty (`ENOTEMPTY`); never recursive. Used by `rewind_ops` (`RMDIR_EMPTY`).
 */
export function rmdirEmptyBeneathWorkspace(workspaceRoot: string, relDirPath: string, syncParentDir = false): boolean {
  const bridge = getLinuxFsBridge();
  const { realWs, relPath } = normalizeLexicalWorkspaceRelPath(workspaceRoot, relDirPath);
  if (!relPath) throw new PathContainmentError(`[guard: cannot rmdir workspace root]`);

  const { wsFd } = openWorkspaceRootFd(realWs);
  try {
    let pInfo: { parentDirFd: number; ownsFd: boolean; leafName: string };
    try {
      pInfo = openParentDirFdBeneath({
        wsFd,
        realWs,
        relPath,
        createMissingDirs: false
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }

    try {
      const entry = bridge.fstatatNoFollow(pInfo.parentDirFd, pInfo.leafName);
      if (!entry) return false;
      if (entry.kind !== "dir") {
        throw new PathContainmentError(
          `[guard: expected directory at '${relPath}' for RMDIR_EMPTY, found ${entry.kind}]`
        );
      }
      verifyOpenFdContainedInWorkspace(pInfo.parentDirFd, realWs);
      try {
        bridge.unlinkatSingle(pInfo.parentDirFd, pInfo.leafName, true);
        if (syncParentDir) {
          fs.fsyncSync(pInfo.parentDirFd);
        }
        return true;
      } catch (err) {
        const code = extractNativeErrnoCode(err);
        throw new PathContainmentError(
          `[guard: unlinkat(AT_REMOVEDIR) failed for '${relPath}' (${code ?? String(err)})]`
        );
      }
    } finally {
      if (pInfo.ownsFd) fs.closeSync(pInfo.parentDirFd);
    }
  } finally {
    fs.closeSync(wsFd);
  }
}
export function pruneEmptyDirsBeneathWorkspace(workspaceRoot: string, relDirPath: string): void {
  const bridge = getLinuxFsBridge();
  const { realWs, relPath } = normalizeLexicalWorkspaceRelPath(workspaceRoot, relDirPath);
  if (!relPath) return;

  const { wsFd } = openWorkspaceRootFd(realWs);
  try {
    const parts = relPath.split("/").filter(Boolean);
    for (let depth = parts.length; depth >= 1; depth--) {
      const targetRel = parts.slice(0, depth).join("/");
      let pInfo: { parentDirFd: number; ownsFd: boolean; leafName: string };
      try {
        pInfo = openParentDirFdBeneath({
          wsFd,
          realWs,
          relPath: targetRel,
          createMissingDirs: false
        });
      } catch {
        break;
      }

      try {
        verifyOpenFdContainedInWorkspace(pInfo.parentDirFd, realWs);
        bridge.unlinkatSingle(pInfo.parentDirFd, pInfo.leafName, true);
      } catch {
        // ENOTEMPTY or EEXIST — stop pruning upwards
        break;
      } finally {
        if (pInfo.ownsFd) fs.closeSync(pInfo.parentDirFd);
      }
    }
  } finally {
    fs.closeSync(wsFd);
  }
}

export function countInodeDentriesInWorkspace(
  realWs: string,
  targetDev: number,
  targetIno: number
): number {
  let count = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const st = fs.lstatSync(full);
          if (st.dev === targetDev && st.ino === targetIno) {
            count += 1;
          }
        } catch {
          // ignore race
        }
      }
    }
  };
  walk(realWs);
  return count;
}

/**
 * Opens a workspace file atomically via Linux `openat2(wsFd, relPath, O_RDONLY, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`,
 * blocks `.git/**` (preventing direct `.git/objects` historical secret reads), blocks `.harness` state,
 * blocks secret basenames and hardlink aliases (both internal and external), and reads directly from `fd`.
 */
export function readWorkspaceFileSafe(params: {
  workspaceRoot: string;
  candidatePath: string;
  unmaskedExceptions?: readonly string[];
  maxBytes?: number;
  /** Read at most this prefix length without requiring the whole file to fit. */
  maxPrefixBytes?: number;
  sessionId?: string;
}): Buffer {
  const bridge = getLinuxFsBridge();
  const exceptions = params.unmaskedExceptions ?? DEFAULT_UNMASKED_SECRET_EXCEPTIONS;
  const { realWs, relPath } = normalizeLexicalWorkspaceRelPath(
    params.workspaceRoot,
    params.candidatePath
  );

  if (!relPath) {
    throw new PathContainmentError(`[guard: cannot read workspace root directory as file]`);
  }
  const relSegments = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (relSegments.includes(".git")) {
    throw new PathContainmentError(
      `[guard: direct .git metadata/object read denied (prevents historical secret blob extraction): ${relPath}]`
    );
  }
  if (relPath === ".harness" || relPath.startsWith(".harness/")) {
    if (!relPath.startsWith(".harness/spill/")) {
      throw new PathContainmentError(`[guard: internal .harness state read denied: ${relPath}]`);
    }
    if (!params.sessionId) {
      throw new PathContainmentError(`[guard: spill read requires a session identity: ${relPath}]`);
    }
    const sessionHash = crypto.createHash("sha256").update(params.sessionId).digest("hex").slice(0, 12);
    const expectedSessionPrefix = `.harness/spill/session-${sessionHash}/`;
    if (!relPath.startsWith(expectedSessionPrefix)) {
      throw new PathContainmentError(`[guard: unauthorized cross-session spill read denied: ${relPath}]`);
    }
  }

  const base = path.posix.basename(relPath);
  if (isSecretBasename(base, exceptions)) {
    throw new PathContainmentError(`[guard: secret file access denied (read): ${relPath}]`);
  }

  const secretScan = scanWorkspaceSecretsAndHardlinks(realWs, exceptions);
  const { wsFd } = openWorkspaceRootFd(realWs);

  let fd: number;
  try {
    fd = bridge.openBeneath(wsFd, relPath, fs.constants.O_RDONLY, 0);
  } catch (err) {
    const code = extractNativeErrnoCode(err);
    if (code === "ELOOP" || code === "EXDEV") {
      throw new PathContainmentError(
        `[guard: symlink or boundary escape rejected by openat2 (${code}): ${relPath}]`
      );
    }
    if (code === "ENOENT") {
      const enoent = new Error(`ENOENT: no such file '${relPath}'`) as NodeJS.ErrnoException;
      enoent.code = "ENOENT";
      throw enoent;
    }
    throw err;
  } finally {
    fs.closeSync(wsFd);
  }

  try {
    verifyOpenFdContainedInWorkspace(fd, realWs);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new PathContainmentError(`[guard: non-regular file read denied: ${relPath}]`);
    }
    if (secretScan.secretInodeKeys.has(`${st.dev}:${st.ino}`)) {
      throw new PathContainmentError(
        `[guard: hardlink alias to secret file inode denied (read): ${relPath}]`
      );
    }
    if (st.nlink > 1) {
      if (!secretScan.complete) {
        throw new PathContainmentError(
          `[guard: incomplete secret inventory prevents verifying multi-link file alias safety (read): ${relPath} (${secretScan.incompleteReasons.join("; ")})]`
        );
      }
      if (
        !relPath.startsWith("node_modules/") &&
        !relPath.startsWith(".venv/")
      ) {
        const inWsCount = countInodeDentriesInWorkspace(realWs, st.dev, st.ino);
        if (inWsCount < st.nlink) {
          throw new PathContainmentError(
            `[guard: external hardlink escaping workspace boundary denied (nlink=${st.nlink}, inWorkspace=${inWsCount}): ${relPath}]`
          );
        }
      }
    }
    if (params.maxPrefixBytes !== undefined) {
      if (params.maxBytes !== undefined || !Number.isInteger(params.maxPrefixBytes) || params.maxPrefixBytes < 1 || params.maxPrefixBytes > 1024 * 1024) {
        throw new RangeError("maxPrefixBytes must be 1–1 MiB and cannot be combined with maxBytes.");
      }
      const prefix = Buffer.allocUnsafe(params.maxPrefixBytes);
      const count = fs.readSync(fd, prefix, 0, prefix.length, 0);
      return prefix.subarray(0, count);
    }
    if (params.maxBytes !== undefined) {
      if (!Number.isInteger(params.maxBytes) || params.maxBytes < 1 || params.maxBytes > 100 * 1024 * 1024) {
        throw new RangeError("maxBytes must be an integer from 1 through 100 MiB.");
      }
      if (st.size > params.maxBytes) throw new PathContainmentError(`[guard: workspace file exceeds bounded read size (${params.maxBytes} bytes): ${relPath}]`);
      const bounded = Buffer.allocUnsafe(params.maxBytes + 1);
      let total = 0;
      while (total < bounded.length) {
        const count = fs.readSync(fd, bounded, total, bounded.length - total, null);
        if (count === 0) break;
        total += count;
      }
      if (total > params.maxBytes) throw new PathContainmentError(`[guard: workspace file grew beyond bounded read size (${params.maxBytes} bytes): ${relPath}]`);
      return bounded.subarray(0, total);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
