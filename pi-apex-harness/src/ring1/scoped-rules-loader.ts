import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { GuardDeniedError, resolveAndValidateWorkspacePath } from "../core/monotonic-guard.ts";
import {
  isSecretBasename,
  readWorkspaceFileSafe,
  scanWorkspaceSecretsAndHardlinks
} from "../core/safe-path.ts";
import type { GuardrailsConfig } from "../types.ts";

/** Codex v0.162.0 & Pi-Apex maximum bytes for dynamically injected scoped rule bundles per turn (`32 KiB`). */
export const MAX_SCOPED_RULES_BYTES_PER_TURN = 32 * 1024;

export interface ParsedMdcRule {
  ruleId: string;
  relPath: string;
  description: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
  contentSha256: string;
}

export interface ScopedRuleInjection {
  ruleId: string;
  sourceRelPath: string;
  contentSha256: string;
  body: string;
}

function sha256Utf8(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Converts a POSIX glob pattern (`**/*.ts`, `src/api/*.ts`, `*.{ts,tsx}`) into an anchored RegExp.
export function globToRegExp(globPattern: string): RegExp {
  const normalized = globPattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let regexStr = "^";
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const closeIdx = normalized.indexOf("}", i);
      if (closeIdx !== -1) {
        const alts = normalized
          .slice(i + 1, closeIdx)
          .split(",")
          .map((s) => s.trim().replace(/[.+^$|()[\]\\]/g, "\\$&"));
        regexStr += `(?:${alts.join("|")})`;
        i = closeIdx + 1;
        continue;
      }
    }
    if (/[.+^$|()[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i += 1;
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

export function matchesAnyGlob(relPath: string, globs: readonly string[]): boolean {
  const normPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const g of globs) {
    if (!g.trim()) continue;
    if (globToRegExp(g).test(normPath)) return true;
    // Also match basename-only globs (e.g. `*.ts`) against nested paths (`src/foo.ts`)
    if (!g.includes("/") && globToRegExp(g).test(path.posix.basename(normPath))) {
      return true;
    }
  }
  return false;
}

// Parses Cursor 3.5-compatible `.mdc` rule files with optional YAML frontmatter (`description`, `globs`, `alwaysApply`).
export function parseMdcContent(relPath: string, rawContent: string): ParsedMdcRule {
  const trimmed = rawContent.replace(/\r\n/g, "\n");
  let description = "";
  let globs: string[] = [];
  let alwaysApply = false;
  let body = trimmed.trim();

  if (trimmed.startsWith("---\n")) {
    const endIdx = trimmed.indexOf("\n---\n", 4);
    if (endIdx !== -1) {
      const frontmatter = trimmed.slice(4, endIdx);
      body = trimmed.slice(endIdx + 5).trim();

      const lines = frontmatter.split("\n");
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx].trim();
        if (!line || line.startsWith("#")) continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const rawVal = line.slice(colonIdx + 1).trim();

        if (key === "description") {
          description = rawVal.replace(/^['"]|['"]$/g, "");
        } else if (key === "alwaysApply") {
          alwaysApply = rawVal === "true";
        } else if (key === "globs") {
          if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
            globs = rawVal
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
              .filter(Boolean);
          } else if (rawVal.length > 0) {
            globs = rawVal
              .split(",")
              .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
              .filter(Boolean);
          } else {
            // Multi-line YAML list (`- pattern`)
            const listItems: string[] = [];
            while (idx + 1 < lines.length && lines[idx + 1].trim().startsWith("- ")) {
              idx += 1;
              listItems.push(
                lines[idx]
                  .trim()
                  .slice(2)
                  .trim()
                  .replace(/^['"]|['"]$/g, "")
              );
            }
            globs = listItems.filter(Boolean);
          }
        }
      }
    }
  }

  return {
    ruleId: `mdc:${relPath}`,
    relPath,
    description,
    globs,
    alwaysApply,
    body,
    contentSha256: sha256Utf8(trimmed)
  };
}

/**
 * Extracts `<scoped-context rule="..." sha256="...">` hashes already present on the active session branch
 * so rules inject at most once per active branch, yet cleanly re-inject if the user `/tree` rewinds
 * to an earlier checkpoint prior to the injection!
 */
export function collectAlreadyInjectedRuleKeys(sessionManager: SessionManager): Set<string> {
  const seen = new Set<string>();
  const ctx = sessionManager.buildSessionContext();
  const tagRegex = /<scoped-context\s+rule="([^"]+)"\s+sha256="([0-9a-f]{64})">/g;

  const scanText = (txt: string) => {
    tagRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(txt)) !== null) {
      seen.add(`${m[1]}@${m[2]}`);
    }
  };

  for (const msg of ctx.messages) {
    const rec = msg as { content?: unknown; summary?: unknown };
    if (typeof rec.content === "string") {
      scanText(rec.content);
    } else if (Array.isArray(rec.content)) {
      for (const part of rec.content) {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          scanText(part.text);
        }
      }
    }
    if (typeof rec.summary === "string") {
      scanText(rec.summary);
    }
  }
  return seen;
}

export class ScopedRulesLoader {
  readonly workspaceRoot: string;
  private readonly guardrails: GuardrailsConfig;
  private readonly inFlightTurnKeys = new Set<string>();

  constructor(workspaceRoot: string, guardrails: GuardrailsConfig) {
    this.workspaceRoot = fs.realpathSync(workspaceRoot);
    this.guardrails = guardrails;
  }

  resetTurnState(): void {
    this.inFlightTurnKeys.clear();
  }

  private safeReadWorkspaceText(relPath: string): string | null {
    try {
      const buf = readWorkspaceFileSafe({
        workspaceRoot: this.workspaceRoot,
        candidatePath: relPath,
        unmaskedExceptions: this.guardrails.sandbox.unmasked_exceptions
      });
      if (buf.length > MAX_SCOPED_RULES_BYTES_PER_TURN) return null;
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  private discoverMdcRules(): ParsedMdcRule[] {
    const rules: ParsedMdcRule[] = [];
    const candidateDirs = [".cursor/rules", ".agents/rules"];

    for (const relDir of candidateDirs) {
      const absDir = path.join(this.workspaceRoot, relDir);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(absDir);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".mdc")) continue;
        const relFile = `${relDir}/${entry.name}`;
        const raw = this.safeReadWorkspaceText(relFile);
        if (raw !== null) {
          rules.push(parseMdcContent(relFile, raw));
        }
      }
    }
    return rules;
  }

  /**
   * Resolves newly applicable subdirectory `AGENTS.md` files and `.mdc` glob rules for `targetPath`,
   * strictly enforcing `MAX_SCOPED_RULES_BYTES_PER_TURN` (32 KiB) and branch-local deduplication (`Invariant I-02`).
   */
  collectTailInjectionsForPath(
    targetPath: string,
    sessionManager: SessionManager
  ): { injections: ScopedRuleInjection[]; formattedTailBlock: string } {
    let relTarget: string;
    try {
      const norm = path.isAbsolute(targetPath)
        ? path.relative(this.workspaceRoot, targetPath)
        : targetPath;
      relTarget = norm.replace(/\\/g, "/").replace(/^\.\//, "");
      if (!relTarget || relTarget.startsWith("..")) {
        return { injections: [], formattedTailBlock: "" };
      }
    } catch {
      return { injections: [], formattedTailBlock: "" };
    }

    const alreadySeen = collectAlreadyInjectedRuleKeys(sessionManager);
    const injections: ScopedRuleInjection[] = [];
    let totalBytes = 0;

    const tryAdd = (inj: ScopedRuleInjection) => {
      const dedupKey = `${inj.ruleId}@${inj.contentSha256}`;
      if (alreadySeen.has(dedupKey) || this.inFlightTurnKeys.has(dedupKey)) return;
      const byteLen = Buffer.byteLength(inj.body, "utf8");
      if (byteLen === 0 || totalBytes + byteLen > MAX_SCOPED_RULES_BYTES_PER_TURN) return;
      this.inFlightTurnKeys.add(dedupKey);
      totalBytes += byteLen;
      injections.push(inj);
    };

    // 1. Subdirectory `AGENTS.md` hierarchy (from shallowest subdirectory to parent of `relTarget`;
    //    root `AGENTS.md` is also loaded lazily at tail if present and not yet injected!)
    const parts = relTarget.split("/").filter(Boolean);
    const candidateDirs: string[] = [""];
    for (let i = 0; i < parts.length - 1; i++) {
      candidateDirs.push(parts.slice(0, i + 1).join("/"));
    }

    for (const dirRel of candidateDirs) {
      const agentsRel = dirRel ? `${dirRel}/AGENTS.md` : "AGENTS.md";
      const content = this.safeReadWorkspaceText(agentsRel);
      if (content !== null && content.trim().length > 0) {
        tryAdd({
          ruleId: `agents:${agentsRel}`,
          sourceRelPath: agentsRel,
          contentSha256: sha256Utf8(content),
          body: content.trim()
        });
      }
    }

    // 2. `.mdc` glob rules matching `relTarget` (or `alwaysApply: true`)
    for (const mdc of this.discoverMdcRules()) {
      if (mdc.alwaysApply || matchesAnyGlob(relTarget, mdc.globs)) {
        tryAdd({
          ruleId: mdc.ruleId,
          sourceRelPath: mdc.relPath,
          contentSha256: mdc.contentSha256,
          body: mdc.description ? `[${mdc.description}]\n${mdc.body}` : mdc.body
        });
      }
    }

    if (injections.length === 0) {
      return { injections: [], formattedTailBlock: "" };
    }

    const formattedTailBlock =
      "\n\n" +
      injections
        .map(
          (inj) =>
            `<scoped-context rule="${inj.ruleId}" sha256="${inj.contentSha256}">\n${inj.body}\n</scoped-context>`
        )
        .join("\n");

    return { injections, formattedTailBlock };
  }
}

/**
 * Bounded Levenshtein edit distance for OpenCode-style `ENOENT` sibling filename suggestions.
 */
function levenshteinDistance(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const dp: number[] = Array.from({ length: lb.length + 1 }, (_, j) => j);

  for (let i = 1; i <= la.length; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= lb.length; j++) {
      const temp = dp[j];
      const cost = la[i - 1] === lb[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prevDiag + cost);
      prevDiag = temp;
    }
  }
  return dp[lb.length];
}

/**
 * OpenCode `read.ts` Pattern:
 * On `ENOENT` when reading a workspace path, inspects confined directory siblings (excluding secrets,
 * hardlink aliases, `.git`, and `.harness`) and returns top fuzzy filename matches (`<= 3`).
 */
export function suggestSiblingPathsOnEnoent(
  requestedPath: string,
  workspaceRoot: string,
  guardrails: GuardrailsConfig
): string[] {
  const realWs = fs.realpathSync(workspaceRoot);
  const absCandidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(realWs, requestedPath);

  const parentDir = path.dirname(absCandidate);
  const targetBase = path.basename(absCandidate);
  if (!targetBase) return [];

  let realParent: string;
  try {
    realParent = fs.realpathSync(parentDir);
  } catch {
    return [];
  }
  if (realParent !== realWs && !realParent.startsWith(`${realWs}${path.sep}`)) {
    return [];
  }
  const relParent = path.relative(realWs, realParent).replace(/\\/g, "/");
  if (relParent.startsWith(".git") || relParent.startsWith(".harness")) {
    return [];
  }

  const secretScan = scanWorkspaceSecretsAndHardlinks(realWs, guardrails.sandbox.unmasked_exceptions);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(realParent, { withFileTypes: true });
  } catch {
    return [];
  }

  const scored: Array<{ relCandidate: string; score: number }> = [];
  for (const e of entries) {
    if (e.name === ".git" || e.name === ".harness" || isSecretBasename(e.name)) continue;
    if (e.isSymbolicLink()) continue;

    const absChild = path.join(realParent, e.name);
    const relChild = relParent ? `${relParent}/${e.name}` : e.name;
    try {
      if (e.isFile()) {
        const st = fs.lstatSync(absChild);
        if (secretScan.secretInodeKeys.has(`${st.dev}:${st.ino}`)) continue;
        // Double-check against monotonic guard
        resolveAndValidateWorkspacePath(relChild, realWs, "read", guardrails);
      }
    } catch (err) {
      if (err instanceof GuardDeniedError) continue;
      continue;
    }

    const dist = levenshteinDistance(targetBase, e.name);
    const substrBonus =
      e.name.toLowerCase().includes(targetBase.toLowerCase()) ||
      targetBase.toLowerCase().includes(e.name.toLowerCase())
        ? -2
        : 0;
    const maxAllowedDist = Math.max(3, Math.ceil(Math.max(targetBase.length, e.name.length) * 0.5));
    if (dist <= maxAllowedDist || substrBonus < 0) {
      scored.push({ relCandidate: relChild, score: dist + substrBonus });
    }
  }

  scored.sort((a, b) => a.score - b.score || a.relCandidate.localeCompare(b.relCandidate));
  return scored.slice(0, 3).map((s) => s.relCandidate);
}
