import fs from "node:fs";
import path from "node:path";
import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import type { ApprovalPolicy, DurabilityMode, GuardrailsConfig } from "../types.ts";
import {
  assertNoSymlinkAncestorsAndContain,
  isSecretBasename,
  mkdirSafeWithinWorkspace,
  PathContainmentError,
  readWorkspaceFileSafe,
  scanWorkspaceSecretsAndHardlinks
} from "./safe-path.ts";
import { PreDispatchAbortedError, writeFileDurable } from "./wal-recovery.ts";

export class GuardDeniedError extends PreDispatchAbortedError {
  constructor(reason: string) {
    super(reason);
    this.name = "GuardDeniedError";
  }
}

/**
 * Validates path containment with stepwise `lstatSync` no-symlink checks, secret-basename block,
 * `(dev, ino)` hardlink-alias block, and control-plane read-only subpaths.
 */
export function resolveAndValidateWorkspacePath(
  candidatePath: string,
  workspaceRoot: string,
  mode: "read" | "write",
  cfg: GuardrailsConfig
): string {
  let info;
  try {
    info = assertNoSymlinkAncestorsAndContain(workspaceRoot, candidatePath);
  } catch (err) {
    if (err instanceof PathContainmentError) {
      throw new GuardDeniedError(err.message);
    }
    throw err;
  }

  if (info.leafStat?.isSymbolicLink()) {
    throw new GuardDeniedError(`[guard: symlink leaf denied (${mode}): ${info.relPath}]`);
  }

  const rel = info.relPath;
  const base = path.basename(info.lexicalTarget);

  if (rel === ".git" || rel.startsWith(".git/")) {
    throw new GuardDeniedError(
      `[guard: direct .git internal access denied (${mode}): ${rel}]`
    );
  }

  if (isSecretBasename(base, cfg.sandbox.unmasked_exceptions)) {
    throw new GuardDeniedError(`[guard: secret file access denied (${mode}): ${rel}]`);
  }

  // Block hardlink aliases to any secret file inode (`ln service/.env innocent.txt`) for BOTH read & write!
  if (info.leafStat?.isFile()) {
    const secretScan = scanWorkspaceSecretsAndHardlinks(info.realWs, cfg.sandbox.unmasked_exceptions);
    if (secretScan.secretInodeKeys.has(`${info.leafStat.dev}:${info.leafStat.ino}`)) {
      throw new GuardDeniedError(
        `[guard: hardlink alias to secret file inode denied (${mode}): ${rel}]`
      );
    }
  }

  if (mode === "write") {
    for (const roSub of cfg.sandbox.read_only_workspace_subpaths) {
      if (rel === roSub || rel.startsWith(`${roSub}/`)) {
        throw new GuardDeniedError(`[guard: control-plane path is read-only: ${rel}]`);
      }
    }
  } else if (rel === ".harness" || rel.startsWith(".harness/")) {
    if (!rel.startsWith(".harness/spill/")) {
      throw new GuardDeniedError(`[guard: internal .harness state read denied: ${rel}]`);
    }
  }

  return info.lexicalTarget;
}

/**
 * Evaluates compound shell pipelines, subshells, raw sockets, secret reads, and unattended routine rules.
 */
export function evaluateShellCommandGuard(params: {
  command: string;
  cfg: GuardrailsConfig;
  approvalPolicy?: ApprovalPolicy;
  unattendedRoutine?: boolean;
}): { allowed: true } | { allowed: false; reason: string; requiresUserApproval?: boolean } {
  const cmd = params.command.trim();
  if (!cmd) return { allowed: true };

  // 1. Proxy bypass flags
  for (const flag of params.cfg.shell_gate.block_proxy_bypass_flags) {
    if (cmd.includes(flag)) {
      return { allowed: false, reason: `[guard: proxy bypass flag '${flag}' denied]` };
    }
  }

  // 2. Pipe-to-interpreter checks across compound segments (including $(...) and <(...) subshells)
  const interpAlternation = params.cfg.shell_gate.block_pipe_to_interpreters
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pipeToInterpRe = new RegExp(
    `\\|\\s*(?:sudo\\s+|env\\s+)?(?:\\/\\S+\\/)?(?:${interpAlternation})(?:\\s|$|;|\\)|&)`
  );
  if (pipeToInterpRe.test(cmd)) {
    return { allowed: false, reason: `[guard: piping into interpreter (${interpAlternation}) denied]` };
  }

  // 3. Raw socket / exfiltration binaries anywhere at segment starts or after delimiters
  const rawToolsAlt = params.cfg.shell_gate.block_raw_network_tools
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const rawSocketRe = new RegExp(`(?:^|[|;&(\`]|\\$\\()\\s*(?:\\/\\S+\\/)?(?:${rawToolsAlt})(?:\\s|$)`);
  if (rawSocketRe.test(cmd) || /\/dev\/(?:tcp|udp)\//.test(cmd)) {
    return { allowed: false, reason: `[guard: raw network socket tool denied]` };
  }

  // 4. Direct shell targeting of .git/hooks or .harness state
  if (/\.git\/hooks\b/.test(cmd) || /\.harness\/state\.db\b/.test(cmd) || /GUARDRAILS\.yaml\b/.test(cmd)) {
    return { allowed: false, reason: `[guard: protected control-plane target denied in shell]` };
  }

  // 5. Unattended scheduled routine external mutation quarantine (Invariant I-10)
  const isExternalMutationCmd =
    /\b(?:git\s+push|gh\s+pr\s+(?:create|merge|comment)|npm\s+publish|curl\s+.*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s))\b/i.test(
      cmd
    );
  if (isExternalMutationCmd) {
    if (params.unattendedRoutine) {
      return {
        allowed: false,
        reason: `[guard: DENY_UNATTENDED — external mutation blocked during unattended scheduled routine]`
      };
    }
    if (params.approvalPolicy === "untrusted") {
      return { allowed: false, reason: `[guard: external mutation denied under untrusted policy]` };
    }
    if (params.approvalPolicy === "on-request") {
      return {
        allowed: false,
        requiresUserApproval: true,
        reason: `[guard: PAUSE_FOR_USER_APPROVAL — external mutation requires operator confirmation]`
      };
    }
  }

  return { allowed: true };
}

export function createConfinedFileOperations(params: {
  workspaceRoot: string;
  cfg: GuardrailsConfig;
  durabilityMode: DurabilityMode;
  beforeAction?: (tool: string, summary: string) => Promise<void>;
}): {
  readOps: ReadOperations;
  writeOps: WriteOperations;
  editOps: EditOperations;
} {
  const readOps: ReadOperations = {
    readFile: async (absPath) => {
      try {
        return readWorkspaceFileSafe({
          workspaceRoot: params.workspaceRoot,
          candidatePath: absPath,
          unmaskedExceptions: params.cfg.sandbox.unmasked_exceptions
        });
      } catch (err) {
        if (err instanceof PathContainmentError) {
          throw new GuardDeniedError(err.message);
        }
        throw err;
      }
    },
    access: async (absPath) => {
      const safe = resolveAndValidateWorkspacePath(absPath, params.workspaceRoot, "read", params.cfg);
      fs.accessSync(safe, fs.constants.R_OK);
    }
  };

  const writeOps: WriteOperations = {
    writeFile: async (absPath, content) => {
      const safe = resolveAndValidateWorkspacePath(absPath, params.workspaceRoot, "write", params.cfg);
      try {
        writeFileDurable(safe, content, params.durabilityMode, {
          workspaceRoot: params.workspaceRoot
        });
      } catch (err) {
        if (err instanceof PathContainmentError) {
          throw new GuardDeniedError(err.message);
        }
        throw err;
      }
    },
    mkdir: async (dir) => {
      await params.beforeAction?.("write", `mkdir ${path.relative(params.workspaceRoot, dir)}`);
      const safe = resolveAndValidateWorkspacePath(dir, params.workspaceRoot, "write", params.cfg);
      try {
        mkdirSafeWithinWorkspace(fs.realpathSync(params.workspaceRoot), safe);
      } catch (err) {
        if (err instanceof PathContainmentError) {
          throw new GuardDeniedError(err.message);
        }
        throw err;
      }
    }
  };

  const editOps: EditOperations = {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: async (absPath) => {
      const safe = resolveAndValidateWorkspacePath(absPath, params.workspaceRoot, "write", params.cfg);
      fs.accessSync(safe, fs.constants.R_OK | fs.constants.W_OK);
    }
  };

  return { readOps, writeOps, editOps };
}
