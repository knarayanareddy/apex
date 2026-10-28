import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxMode } from "../types.ts";
import {
  auditGitHistoryForSecretPaths,
  DEFAULT_UNMASKED_SECRET_EXCEPTIONS,
  findWorkspaceGitRoots,
  scanWorkspaceSecretsAndHardlinks
} from "./safe-path.ts";
import { recordProcessIdentity, terminateProcessTree } from "./process-tree.ts";

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export interface BwrapSandboxConfig {
  workspaceRoot: string;
  mode?: SandboxMode;
  unshareNet?: boolean;
  allowUnsandboxedDev?: boolean;
  unmaskedSecretExceptions?: readonly string[];
  /**
   * Controls Git object/reflog isolation inside `bwrap` (Reviewer #5 Issue #3 Fix):
   * - `"always"` (SAFE DEFAULT): unconditionally resolves the actual `gitDir`, `commonDir` (including
   *   linked `git worktree` pointers), `objects` dirs (including `objects/info/alternates`), and `logs`
   *   dirs, and overlays `--tmpfs` over all object/log directories inside `bwrap`. Protects reachable,
   *   reflog-only, AND unreachable/dangling secret blobs.
   * - `"on-historical-secret"`: opt-in weaker mode scanning only reachable `git log --all` + `git ls-files`
   *   (does NOT detect unreachable/dangling blobs prior to `git gc --prune=now`).
   * - `"expose-unsafe"`: explicit operator opt-in when full inside-sandbox `git` history access is required.
   */
  isolateGitObjectsMode?: "always" | "on-historical-secret" | "expose-unsafe";
  extraWritablePaths?: string[];
  extraReadOnlyPaths?: string[];
  beforeAction?: (tool: string, summary: string) => Promise<void>;
}

let cachedBwrapProbe: { ok: boolean; reason?: string } | null = null;

export function resetBwrapProbeCacheForTesting(): void {
  cachedBwrapProbe = null;
}

export function probeBwrapFunctional(): { ok: boolean; reason?: string } {
  if (cachedBwrapProbe) return cachedBwrapProbe;
  if (process.platform === "darwin") {
    cachedBwrapProbe = { ok: false, reason: "bubblewrap is not supported on macOS darwin" };
    return cachedBwrapProbe;
  }
  try {
    const out = execFileSync(
      "bwrap",
      [
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--clearenv",
        "--setenv", "PATH", "/usr/bin:/bin",
        "--", "/bin/echo", "BWRAP_PROBE_OK"
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }
    ).trim();
    cachedBwrapProbe = out === "BWRAP_PROBE_OK" ? { ok: true } : { ok: false, reason: `Unexpected probe: ${out}` };
  } catch (err) {
    cachedBwrapProbe = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return cachedBwrapProbe;
}

export interface ResolvedGitLayout {
  isGitRepo: boolean;
  isLinkedWorktree: boolean;
  gitDir: string | null;
  commonDir: string | null;
  objectsDirs: string[];
  logsDirs: string[];
  indexFiles: string[];
  readOnlyControlPaths: string[];
}

/**
 * Resolves actual `gitDir`, `commonDir` (`commondir` in linked worktrees), `objects` directories
 * (including `objects/info/alternates`), `logs`, `hooks`, and `config` paths across both standard
 * repositories and linked `git worktree` checkouts.
 */
export function resolveGitRepositoryLayout(workspaceRoot: string): ResolvedGitLayout {
  const dotGit = path.join(workspaceRoot, ".git");
  if (!fs.existsSync(dotGit)) {
    return {
      isGitRepo: false,
      isLinkedWorktree: false,
      gitDir: null,
      commonDir: null,
      objectsDirs: [],
      logsDirs: [],
      indexFiles: [],
      readOnlyControlPaths: []
    };
  }

  const st = fs.lstatSync(dotGit);
  let gitDir: string | null = null;
  let commonDir: string | null = null;
  let isLinkedWorktree = false;

  if (st.isDirectory()) {
    gitDir = fs.realpathSync(dotGit);
    commonDir = gitDir;
  } else if (st.isFile()) {
    const content = fs.readFileSync(dotGit, "utf8").trim();
    const m = content.match(/^gitdir:\s*(.+)$/);
    if (m) {
      const resolvedGitDir = path.resolve(workspaceRoot, m[1].trim());
      if (fs.existsSync(resolvedGitDir)) {
        gitDir = fs.realpathSync(resolvedGitDir);
        isLinkedWorktree = true;
        const commonDirFile = path.join(gitDir, "commondir");
        if (fs.existsSync(commonDirFile)) {
          const relCommon = fs.readFileSync(commonDirFile, "utf8").trim();
          const candCommon = path.resolve(gitDir, relCommon);
          commonDir = fs.existsSync(candCommon) ? fs.realpathSync(candCommon) : gitDir;
        } else {
          commonDir = path.resolve(gitDir, "../..");
        }
      }
    }
  }

  if (!gitDir || !commonDir) {
    return {
      isGitRepo: false,
      isLinkedWorktree: false,
      gitDir: null,
      commonDir: null,
      objectsDirs: [],
      logsDirs: [],
      indexFiles: [],
      readOnlyControlPaths: []
    };
  }

  const objectsSet = new Set<string>();
  const primaryObjects = path.join(commonDir, "objects");
  if (fs.existsSync(primaryObjects)) {
    objectsSet.add(fs.realpathSync(primaryObjects));
    const altFile = path.join(primaryObjects, "info", "alternates");
    if (fs.existsSync(altFile)) {
      const lines = fs.readFileSync(altFile, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const resolvedAlt = path.resolve(primaryObjects, trimmed);
        if (fs.existsSync(resolvedAlt)) {
          objectsSet.add(fs.realpathSync(resolvedAlt));
        } else {
          throw new SandboxUnavailableError(
            `Cannot isolate unresolvable Git alternate object store '${trimmed}' referenced in '${altFile}'`
          );
        }
      }
    }
  }

  const logsSet = new Set<string>();
  for (const d of [path.join(gitDir, "logs"), path.join(commonDir, "logs")]) {
    if (fs.existsSync(d)) logsSet.add(fs.realpathSync(d));
  }

  const indexFiles: string[] = [];
  const idxPath = path.join(gitDir, "index");
  if (fs.existsSync(idxPath) && fs.lstatSync(idxPath).isFile()) {
    indexFiles.push(idxPath);
  }

  const roSet = new Set<string>();
  for (const p of [
    path.join(commonDir, "hooks"),
    path.join(commonDir, "config"),
    path.join(gitDir, "hooks"),
    path.join(gitDir, "config"),
    path.join(gitDir, "config.worktree")
  ]) {
    if (fs.existsSync(p)) roSet.add(p);
  }

  return {
    isGitRepo: true,
    isLinkedWorktree,
    gitDir,
    commonDir,
    objectsDirs: Array.from(objectsSet),
    logsDirs: Array.from(logsSet),
    indexFiles,
    readOnlyControlPaths: Array.from(roSet)
  };
}

/**
 * Resolves Git repository layouts across ALL discovered Git repositories (root, submodules,
 * nested repositories, linked worktrees) beneath `workspaceRoot`.
 */
export function resolveAllWorkspaceGitLayouts(workspaceRoot: string): ResolvedGitLayout[] {
  const roots = findWorkspaceGitRoots(workspaceRoot);
  const layouts: ResolvedGitLayout[] = [];
  for (const root of roots) {
    const layout = resolveGitRepositoryLayout(root);
    if (layout.isGitRepo) {
      layouts.push(layout);
    }
  }
  return layouts;
}

export function collectMaskedSecretFiles(
  workspaceRoot: string,
  unmaskedExceptions: readonly string[] = DEFAULT_UNMASKED_SECRET_EXCEPTIONS
): string[] {
  const scan = scanWorkspaceSecretsAndHardlinks(workspaceRoot, unmaskedExceptions);
  if (!scan.complete) {
    throw new SandboxUnavailableError(
      `Cannot collect masked secret files with incomplete secret scan coverage: ${scan.incompleteReasons.join("; ")}`
    );
  }
  return scan.allMaskedPaths;
}

export function buildMinimalBwrapArgv(
  command: string,
  cwd: string,
  cfg: BwrapSandboxConfig
): string[] {
  const ws = fs.realpathSync(cfg.workspaceRoot);
  const effectiveCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : ws;
  const mode = cfg.mode ?? "workspace-write";

  if (mode === "danger-full-access") {
    return ["/bin/bash", "-c", command];
  }

  const args: string[] = [
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/etc/alternatives", "/etc/alternatives",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/ssl/certs", "/etc/ssl/certs",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--tmpfs", "/home",
    "--dir", "/home/sandbox"
  ];

  if (mode === "read-only") {
    args.push("--ro-bind", ws, ws);
  } else {
    args.push("--bind", ws, ws);
  }

  for (const extraRo of cfg.extraReadOnlyPaths ?? []) {
    if (fs.existsSync(extraRo)) args.push("--ro-bind", extraRo, extraRo);
  }
  if (mode === "workspace-write") {
    for (const extraRw of cfg.extraWritablePaths ?? []) {
      if (fs.existsSync(extraRw)) args.push("--bind", extraRw, extraRw);
    }
  }

  const allGitLayouts = resolveAllWorkspaceGitLayouts(ws);
  const gitIsoMode = cfg.isolateGitObjectsMode ?? "always";

  for (const gitLayout of allGitLayouts) {
    // Linked worktree external metadata mounts (commonDir & gitDir live outside `<ws>`)
    if (gitLayout.isLinkedWorktree && gitLayout.commonDir && gitLayout.gitDir) {
      args.push("--ro-bind", gitLayout.commonDir, gitLayout.commonDir);
      if (mode === "workspace-write") {
        args.push("--bind", gitLayout.gitDir, gitLayout.gitDir);
        if (gitIsoMode === "expose-unsafe") {
          for (const objDir of gitLayout.objectsDirs) {
            args.push("--bind", objDir, objDir);
          }
        }
      }
    }

    for (const roControl of gitLayout.readOnlyControlPaths) {
      args.push("--ro-bind", roControl, roControl);
    }

    // Isolate Git object & reflog directories (`--tmpfs`) — safe default `"always"` covers reachable,
    // reflog-only, AND unreachable/dangling secret blobs across standard repos, nested repos, and linked worktrees!
    if (gitLayout.isGitRepo && gitIsoMode !== "expose-unsafe") {
      const shouldIsolate =
        gitIsoMode === "always"
          ? { isolateObjects: true, maskIndex: false }
          : (() => {
              const audit = auditGitHistoryForSecretPaths(ws, cfg.unmaskedSecretExceptions);
              return { isolateObjects: audit.hasHistoricalSecrets, maskIndex: audit.hasStagedSecrets };
            })();

      if (shouldIsolate.isolateObjects) {
        for (const objDir of gitLayout.objectsDirs) {
          args.push("--tmpfs", objDir);
        }
        for (const logDir of gitLayout.logsDirs) {
          args.push("--tmpfs", logDir);
        }
      }
      if (shouldIsolate.maskIndex) {
        for (const idxFile of gitLayout.indexFiles) {
          args.push("--ro-bind", "/dev/null", idxFile);
        }
      }
    }
  }

  // Protect control-plane subpaths (`.harness`) strictly Read-Only
  const absHarness = path.join(ws, ".harness");
  if (fs.existsSync(absHarness)) {
    args.push("--ro-bind", absHarness, absHarness);
  }

  // Mask workspace secret files & hardlink aliases recursively
  const secretScan = scanWorkspaceSecretsAndHardlinks(ws, cfg.unmaskedSecretExceptions);
  if (!secretScan.complete) {
    throw new SandboxUnavailableError(
      `Cannot execute bubblewrap sandbox with incomplete secret mask coverage: ${secretScan.incompleteReasons.join("; ")}`
    );
  }
  for (const secretPath of secretScan.allMaskedPaths) {
    args.push("--ro-bind", "/dev/null", secretPath);
  }

  if (cfg.unshareNet !== false) {
    args.push("--unshare-net");
  }

  args.push(
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "HOME", "/home/sandbox",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TERM", "dumb",
    "--chdir", effectiveCwd,
    "--",
    "/bin/bash",
    "-c",
    command
  );

  return args;
}

export function createBwrapBashOperations(cfg: BwrapSandboxConfig): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      await cfg.beforeAction?.("bash", command);
      const mode = cfg.mode ?? "workspace-write";
      let bin = "bwrap";
      let argv: string[];

      if (mode === "danger-full-access") {
        bin = "/bin/bash";
        argv = ["-c", command];
      } else {
        const probe = probeBwrapFunctional();
        if (!probe.ok) {
          if (!cfg.allowUnsandboxedDev) {
            throw new SandboxUnavailableError(
              `SANDBOX_UNAVAILABLE: bubblewrap confinement failed (${probe.reason ?? "unknown"}). Refusing unconfined execution without explicit allowUnsandboxedDev: true.`
            );
          }
          console.warn(`[APEX_CONFINEMENT_WARNING] Running unconfined development bash on ${process.platform}. Kernel namespaces disabled.`);
          bin = "/bin/bash";
          argv = ["-c", command];
        } else {
          argv = buildMinimalBwrapArgv(command, cwd, cfg);
        }
      }

      const childEnv: NodeJS.ProcessEnv =
        bin === "/bin/bash"
          ? {
              PATH:
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" +
                (process.env["PATH"] ?? ""),
              HOME: "/tmp",
              TMPDIR: "/tmp",
              LANG: "C.UTF-8",
              TERM: "dumb"
            }
          : {};

      return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
        const child = spawn(bin, argv, {
          cwd: fs.existsSync(cwd) ? cwd : cfg.workspaceRoot,
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"]
        });

        const procIdentity = recordProcessIdentity(child.pid ?? -1);
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        let settleTimeout: NodeJS.Timeout | undefined;
        let settled = false;

        const terminateDescendantsAndStreams = () => {
          if (child.pid) {
            terminateProcessTree(child.pid, procIdentity);
          }
          try {
            child.stdout.destroy();
          } catch {
            // ignore
          }
          try {
            child.stderr.destroy();
          } catch {
            // ignore
          }
        };

        const settleOnce = (result: { exitCode: number | null }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (settleTimeout) clearTimeout(settleTimeout);
          options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        if (options.timeout && options.timeout > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            terminateDescendantsAndStreams();
            settleTimeout = setTimeout(() => {
              options.onData(Buffer.from("\n[sandbox: command timed out]\n", "utf8"));
              settleOnce({ exitCode: 124 });
            }, 250);
            settleTimeout.unref();
          }, options.timeout * 1000);
        }

        const onAbort = () => {
          terminateDescendantsAndStreams();
          settleTimeout = setTimeout(() => {
            settleOnce({ exitCode: 137 });
          }, 250);
          settleTimeout.unref();
        };
        if (options.signal) {
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        const MAX_INLINE_BYTES = 32_768; // 32 KB threshold matching PrivateSpillStore
        const MAX_KILL_BYTES = 128 * 1024 * 1024; // 128 MB runaway flood ceiling
        const MAX_TAIL_PREVIEW_BYTES = 4096; // 4 KB circular ring buffer

        let totalBytesSeen = 0;
        let inlineCutoffReached = false;
        let killTriggered = false;
        const tailRing: Buffer[] = [];
        let tailRingBytes = 0;

        const handleChunk = (chunk: Buffer) => {
          if (killTriggered) return;
          totalBytesSeen += chunk.length;

          // Hard kill ceiling: if runaway command exceeds 128MB, kill process immediately
          if (totalBytesSeen > MAX_KILL_BYTES) {
            killTriggered = true;
            terminateDescendantsAndStreams();
            options.onData(
              Buffer.from(
                `\n[TRUNCATED: Process killed after exceeding ${Math.round(MAX_KILL_BYTES / (1024 * 1024))}MB output cap. totalBytes=${totalBytesSeen}]\n`,
                "utf8"
              )
            );
            settleTimeout = setTimeout(() => {
              settleOnce({ exitCode: 137 });
            }, 250);
            settleTimeout.unref();
            return;
          }

          // Fast path: under 32 KB, stream directly inline
          if (totalBytesSeen <= MAX_INLINE_BYTES) {
            options.onData(chunk);
            return;
          }

          // Crossing the 32 KB threshold: emit spill notice once
          if (!inlineCutoffReached) {
            inlineCutoffReached = true;
            options.onData(
              Buffer.from(
                `\n[OUTPUT_STREAM_OVERFLOW: Output exceeded ${MAX_INLINE_BYTES} bytes. Truncating inline stream to prevent V8 heap exhaustion...]\n`,
                "utf8"
              )
            );
          }

          // Maintain rolling circular ring buffer of the last 4 KB for the tail
          tailRing.push(chunk);
          tailRingBytes += chunk.length;
          while (tailRing.length > 0 && tailRingBytes - tailRing[0].length >= MAX_TAIL_PREVIEW_BYTES) {
            tailRingBytes -= tailRing[0].length;
            tailRing.shift();
          }
        };

        child.stdout.on("data", handleChunk);
        child.stderr.on("data", handleChunk);
        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          if (settleTimeout) clearTimeout(settleTimeout);
          options.signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          if (inlineCutoffReached && tailRing.length > 0) {
            const combinedTail = Buffer.concat(tailRing);
            const tailSlice = combinedTail.subarray(Math.max(0, combinedTail.length - MAX_TAIL_PREVIEW_BYTES));
            options.onData(
              Buffer.from(
                `\n--- TAIL (${totalBytesSeen} total bytes seen) ---\n${tailSlice.toString("utf8")}\n`,
                "utf8"
              )
            );
          }
          if (timedOut) {
            options.onData(Buffer.from("\n[sandbox: command timed out]\n", "utf8"));
            settleOnce({ exitCode: 124 });
            return;
          }
          if (signal) {
            settleOnce({ exitCode: 128 + 9 });
            return;
          }
          settleOnce({ exitCode: code });
        });
      });
    }
  };
}
