/**
 * Ring 3 — Quarantined Autonomous Skill Distiller, `skills-guard-v10` Static Security Scanner,
 * & Background Lifecycle Curator (`skill_curator`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - `NousResearch/hermes-agent` @ `765c6463009f` (MIT License):
 *      - `tools/skills_guard.py` (`SCANNER_VERSION = "skills-guard-v10"`): `INSTALL_POLICY`,
 *        `VERDICT_INDEX`, `Finding`, `ScanResult`, `THREAT_PATTERNS`, `should_allow_install`,
 *        agent-config persistence shell/prose detectors, and Unicode tag/bidi steganography scan.
 *      - `tools/skill_manager_tool.py` & `tools/skill_manager_guards.py`: `VALID_NAME_RE`,
 *        `ALLOWED_SUBDIRS`, `_validate_frontmatter`, `_validate_delete_target` (symlink/root
 *        deletion refusal — Kilo Code #11227 class defense), `_pinned_guard`,
 *        `_background_review_read_before_write_guard`, and `_curator_consolidation_delete_guard`
 *        (fixing Hermes #29912 premature consolidation deletion without `absorbed_into` umbrella).
 *      - `agent/curator.py`: `DEFAULT_STALE_AFTER_DAYS = 14`, `DEFAULT_ARCHIVE_AFTER_DAYS = 30`,
 *        `use_count === 0` grace window, cron-referenced & pinned protection, and recoverable
 *        `.archive/` lifecycle transitions (`active -> stale -> archived`).
 *
 * APEX RING 3 INVARIANTS ENFORCED:
 *  1. Agent-distilled skills NEVER enter `.agents/skills/` directly — they ALWAYS land in
 *     `.skills-quarantine/<name>/SKILL.md` first (`status = "quarantined"`).
 *  2. Promotion from `.skills-quarantine/` -> `.agents/skills/` requires BOTH a clean/non-dangerous
 *     `skills-guard-v10` static scan AND explicit `operatorApproved: true`.
 *  3. All filesystem mutations use Ring 0 `writeFileDurable()` + `lstatSync` symlink refusal.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import type { DurabilityMode } from "../types.ts";

export const SCANNER_VERSION = "skills-guard-v10-apex";

export type SkillTrustLevel = "builtin" | "trusted" | "community" | "agent-created";
export type SkillVerdict = "safe" | "caution" | "dangerous";
export type SkillFindingSeverity = "critical" | "high" | "medium" | "low";
export type SkillLifecycleStatus = "quarantined" | "active" | "stale" | "archived";

/**
 * Ported directly from `NousResearch/hermes-agent` `tools/skills_guard.py`:
 *                  safe      caution    dangerous
 *  builtin:       ("allow",  "allow",   "allow")
 *  trusted:       ("allow",  "allow",   "block")
 *  community:     ("allow",  "block",   "block")
 *  agent-created: ("allow",  "block",   "block")  [tightened in Ring 3: caution/dangerous block until operator review]
 */
export const INSTALL_POLICY: Record<
  SkillTrustLevel,
  readonly ["allow" | "block" | "ask", "allow" | "block" | "ask", "allow" | "block" | "ask"]
> = {
  builtin: ["allow", "allow", "allow"],
  trusted: ["allow", "allow", "block"],
  community: ["allow", "block", "block"],
  "agent-created": ["allow", "ask", "block"]
};

const VERDICT_INDEX: Record<SkillVerdict, 0 | 1 | 2> = {
  safe: 0,
  caution: 1,
  dangerous: 2
};

export interface SkillScanFinding {
  patternId: string;
  severity: SkillFindingSeverity;
  category:
    | "exfiltration"
    | "injection"
    | "destructive"
    | "persistence"
    | "network"
    | "obfuscation"
    | "execution"
    | "traversal"
    | "supply_chain"
    | "privilege_escalation"
    | "steganography";
  file: string;
  line: number;
  match: string;
  description: string;
}

export interface SkillScanResult {
  skillName: string;
  source: string;
  trustLevel: SkillTrustLevel;
  verdict: SkillVerdict;
  findings: SkillScanFinding[];
  scannedAt: string;
  summary: string;
  scannerVersion: string;
  contentSha256: string;
}

interface CompiledThreatPattern {
  regex: RegExp;
  patternId: string;
  severity: SkillFindingSeverity;
  category: SkillScanFinding["category"];
  description: string;
}

// Ported directly from `NousResearch/hermes-agent` `tools/skills_guard.py` helpers
const MODIFY_VERB_RE =
  "(?:\\bwrit(?:e|es|ing)\\b|\\bwritten\\b|\\bedit(?:s|ed|ing)?\\b" +
  "|\\bmodif(?:y|ies|ied|ying|ication)s?\\b|\\bupdat(?:e|es|ed|ing)\\b" +
  "|\\bappend(?:s|ed|ing)?\\b|\\bprepend(?:s|ed|ing)?\\b" +
  "|\\binject(?:s|ed|ing)?\\b|\\boverwrit(?:e|es|ing)\\b|\\boverwritten\\b" +
  "|\\breplac(?:e|es|ed|ing)\\b|\\balter(?:s|ed|ing)?\\b|\\badd(?:s|ed|ing)\\b)";

const AGENT_CONFIG_FILES =
  "(?:AGENTS\\.md|CLAUDE\\.md|\\.cursorrules|\\.clinerules|GUARDRAILS\\.yaml|SYSTEM\\.md|TOOL_GUIDANCE\\.md|\\.hermes/(?:config\\.yaml|SOUL\\.md))";

const SHELL_NAMES_RE = "(?:bash|sh|zsh|ksh|dash)\\b";
const SUDO_PREFIX = "(?:sudo\\s+(?:-\\S+\\s+)*)?";
const CRED_FILE =
  "(?:\\.ssh[/\\\\]id_(?:rsa|ed25519|ecdsa|dsa)(?!\\.pub)|\\.env\\b|credentials\\b|\\.netrc\\b|\\.pgpass\\b|\\.npmrc\\b|\\.pypirc\\b)";
const CRED_FILE_LITERAL = `["'][^"'\\n]*${CRED_FILE}[^"'\\n]*["']`;

function buildShellWriteRegex(fileAlt: string): RegExp {
  return new RegExp(
    `(?:>>|[\\w"'\`)\\]]\\s*>)\\s*[~\\w./-]*${fileAlt}(?!\\.?\\w)` +
      `|\\bsed\\b[^\\n]*\\s(?:-[A-Za-z]*i[A-Za-z]*|--in-place)\\b[^\\n]*${fileAlt}(?!\\.?\\w)` +
      `|\\btee\\s+(?:-a\\s+)?[~\\w./"'-]*${fileAlt}(?!\\.?\\w)` +
      `|\\b(?:cp|mv)\\s+[^\\s|;&]+\\s+[^\\n|;&]{0,40}?${fileAlt}(?!\\.?\\w)`,
    "i"
  );
}

function buildProseModifyRegex(fileAlt: string): RegExp {
  return new RegExp(
    `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?${MODIFY_VERB_RE}[^\\n,]{0,80}?${fileAlt}\\b` +
      `|(?:\byou\\s+(?:must|should|need\\s+to)\\s+|\\bplease\\s+|\\bmake\\s+sure\\s+(?:to\\s+|you\\s+)|\\bbe\\s+sure\\s+to\\s+)${MODIFY_VERB_RE}[^\\n,]{0,80}?${fileAlt}\\b`,
    "i"
  );
}

/**
 * Upstream `THREAT_PATTERNS` adapted from `NousResearch/hermes-agent` `tools/skills_guard.py`
 * (`SCANNER_VERSION = "skills-guard-v10"`), compiled cleanly for Node V8 `RegExp`.
 */
const THREAT_PATTERNS: readonly CompiledThreatPattern[] = [
  // ── Exfiltration: shell/HTTP commands leaking secrets (with loopback exemption) ──
  {
    regex:
      /curl\s+(?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b/i,
    patternId: "env_exfil_curl",
    severity: "critical",
    category: "exfiltration",
    description: "curl command interpolating secret environment variable"
  },
  {
    regex:
      /wget\s+(?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b/i,
    patternId: "env_exfil_wget",
    severity: "critical",
    category: "exfiltration",
    description: "wget command interpolating secret environment variable"
  },
  {
    regex:
      /fetch\s*\((?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)S?\b/i,
    patternId: "env_exfil_fetch",
    severity: "critical",
    category: "exfiltration",
    description: "fetch() call interpolating secret environment variable"
  },
  {
    regex:
      /httpx?\.(?:get|post|put|patch)\s*\((?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*(?:KEY|TOKEN|SECRET|PASSWORD)/i,
    patternId: "env_exfil_httpx",
    severity: "critical",
    category: "exfiltration",
    description: "HTTP library call with secret variable"
  },
  {
    regex:
      /requests\.(?:get|post|put|patch)\s*\((?![^\n]*https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))[^\n]*(?:KEY|TOKEN|SECRET|PASSWORD)/i,
    patternId: "env_exfil_requests",
    severity: "critical",
    category: "exfiltration",
    description: "requests library call with secret variable"
  },
  // ── Exfiltration: reading credential stores ──
  {
    regex: /base64[^\n]*env/i,
    patternId: "encoded_exfil",
    severity: "high",
    category: "exfiltration",
    description: "base64 encoding combined with environment access"
  },
  {
    regex: /\$HOME\/\.ssh|~\/\.ssh/i,
    patternId: "ssh_dir_access",
    severity: "high",
    category: "exfiltration",
    description: "references user SSH directory"
  },
  {
    regex: /\$HOME\/\.aws|~\/\.aws/i,
    patternId: "aws_dir_access",
    severity: "high",
    category: "exfiltration",
    description: "references user AWS credentials directory"
  },
  {
    regex: /\$HOME\/\.gnupg|~\/\.gnupg/i,
    patternId: "gpg_dir_access",
    severity: "high",
    category: "exfiltration",
    description: "references user GPG keyring"
  },
  {
    regex: /\$HOME\/\.kube|~\/\.kube/i,
    patternId: "kube_dir_access",
    severity: "high",
    category: "exfiltration",
    description: "references Kubernetes config directory"
  },
  {
    regex: /cat\s+(?!>)[^\n]*(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    patternId: "read_secrets_file",
    severity: "critical",
    category: "exfiltration",
    description: "reads known secrets file"
  },
  {
    regex: new RegExp(`\\b(?:readFile(?:Sync)?|readTextFile)\\s*\\(\\s*${CRED_FILE_LITERAL}`, "i"),
    patternId: "js_read_secrets_file",
    severity: "critical",
    category: "exfiltration",
    description: "JavaScript reads a known credential file"
  },
  {
    regex: /printenv|(?<![A-Za-z0-9_])env\s*\|(?!\|)(?!\s*[{(])/i,
    patternId: "dump_all_env",
    severity: "high",
    category: "exfiltration",
    description: "dumps all environment variables"
  },
  {
    regex: /process\.env\[/i,
    patternId: "node_process_env",
    severity: "high",
    category: "exfiltration",
    description: "accesses process.env bracket indexing"
  },
  {
    regex: />\s*\/tmp\/[^\s]*\s*&&\s*(?:curl|wget|nc|python)/i,
    patternId: "tmp_staging",
    severity: "critical",
    category: "exfiltration",
    description: "writes to /tmp then exfiltrates"
  },
  {
    regex: /!\[.*\]\(https?:\/\/[^\)]*\$\{?/i,
    patternId: "md_image_exfil",
    severity: "high",
    category: "exfiltration",
    description: "markdown image URL with variable interpolation (image-based exfil)"
  },
  {
    regex: /\[.*\]\(https?:\/\/[^\)]*\$\{?/i,
    patternId: "md_link_exfil",
    severity: "high",
    category: "exfiltration",
    description: "markdown link URL with variable interpolation"
  },
  // ── Prompt injection ──
  {
    regex: /ignore\s+(?:\w+\s+)*(?:previous|all|above|prior)\s+instructions/i,
    patternId: "prompt_injection_ignore",
    severity: "critical",
    category: "injection",
    description: "prompt injection: ignore previous instructions"
  },
  {
    regex: /you\s+are\s+(?:\w+\s+)*now\s+/i,
    patternId: "role_hijack",
    severity: "high",
    category: "injection",
    description: "attempts to override the agent's role"
  },
  {
    regex:
      /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user(?!\s+to\s+["'\u201c\u2018])(?!.*\b(?:unless|except|until|confirm|diagnos\w*|verify|check)\b)/i,
    patternId: "deception_hide",
    severity: "high",
    category: "injection",
    description: "instructs agent to hide information from user"
  },
  {
    regex: /system\s+(?:\w+\s+)*prompt\s+(?:\w+\s+)*override/i,
    patternId: "sys_prompt_override",
    severity: "critical",
    category: "injection",
    description: "attempts to override the system prompt"
  },
  {
    regex: /disregard\s+(?:\w+\s+)*(?:your|all|any)\s+(?:\w+\s+)*(?:instructions|rules|guidelines|guardrails)/i,
    patternId: "disregard_rules",
    severity: "critical",
    category: "injection",
    description: "instructs agent to disregard its rules or guardrails"
  },
  {
    regex: /output\s+(?:\w+\s+)*(?:system|initial)\s+prompt/i,
    patternId: "leak_system_prompt",
    severity: "high",
    category: "injection",
    description: "attempts to extract the system prompt"
  },
  {
    regex: /(?:when|if)\s+no\s*one\s+is\s+(?:watching|looking)/i,
    patternId: "conditional_deception",
    severity: "high",
    category: "injection",
    description: "conditional instruction to behave differently when unobserved"
  },
  {
    regex:
      /act\s+as\s+(?:if|though)\s+(?:\w+\s+)*you\s+(?:\w+\s+)*(?:have\s+no|don't\s+have)\s+(?:\w+\s+)*(?:restrictions|limits|rules)/i,
    patternId: "bypass_restrictions",
    severity: "critical",
    category: "injection",
    description: "instructs agent to act without restrictions"
  },
  {
    regex:
      /<!--[^>]*(?:\b(?:ignore|forget|disregard|override)\s+(?:\w+\s+)*?(?:previous|prior|above|earlier|all|any|your|the)\s+(?:\w+\s+)*?(?:instructions?|rules|prompts?|guidelines|directions|restrictions)|\bsystem\s*(?:prompt|message|instructions?|override)|\b(?:override|secret|hidden|system)\s*:|\b(?:ignore|override|bypass|disable)\s+(?:\w+\s+)*?(?:safety|security|guardrails|filters)\b|\b(?:secret|hidden|new)\s+(?:instructions?|commands?|directives?|tasks?)\b|\byou\s+are\s+now\b|\bdo\s+not\s+(?:tell|reveal|show|mention|inform)\b)[^>]*-->/i,
    patternId: "html_comment_injection",
    severity: "high",
    category: "injection",
    description: "hidden prompt injection instructions in HTML comments"
  },
  {
    regex: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i,
    patternId: "hidden_div",
    severity: "high",
    category: "injection",
    description: "hidden HTML div containing invisible instructions"
  },
  // ── Destructive operations & Agent-Config Persistence ──
  {
    regex: /(?<![A-Za-z0-9])rm\s+-rf\s+\/(?!(?:tmp|var\/tmp|dev\/shm|run)(?:\b|\/))|(?<![A-Za-z0-9])rm\s+(?:-[^\s]*)?r.*(?:\$HOME|~[/\s*]|~$)/i,
    patternId: "destructive_rm",
    severity: "critical",
    category: "destructive",
    description: "recursive delete targeting root or home directory"
  },
  {
    regex: />\s*\/etc\/|\bmkfs\b|\bdd\s+.*if=.*of=\/dev\//i,
    patternId: "system_overwrite",
    severity: "critical",
    category: "destructive",
    description: "overwrites system configuration or raw block device"
  },
  {
    regex: /authorized_keys|\/etc\/sudoers|\bvisudo\b/i,
    patternId: "ssh_or_sudoers_backdoor",
    severity: "critical",
    category: "persistence",
    description: "modifies SSH authorized_keys or sudoers"
  },
  {
    regex: buildShellWriteRegex(AGENT_CONFIG_FILES),
    patternId: "agent_config_mod_shell",
    severity: "critical",
    category: "persistence",
    description: "shell command mechanically modifying agent/harness guardrail or config surface"
  },
  {
    regex: buildProseModifyRegex(AGENT_CONFIG_FILES),
    patternId: "agent_config_mod_prose",
    severity: "high",
    category: "persistence",
    description: "directive instructing modification of agent/harness guardrail or config surface"
  },
  // ── Network: reverse shells, tunnels, webhook exfil ──
  {
    regex: /\bnc\s+-[lp]|ncat\s+-[lp]|\bsocat\b[^\n]*\b(?:tcp|udp|openssl|ssl|exec|system|pty|unix)[\w-]*:/i,
    patternId: "reverse_shell",
    severity: "critical",
    category: "network",
    description: "potential reverse shell listener"
  },
  {
    regex: new RegExp(`/bin/${SHELL_NAMES_RE}\\s+-i\\s+.*>/dev/tcp/`, "i"),
    patternId: "bash_reverse_shell",
    severity: "critical",
    category: "network",
    description: "bash interactive reverse shell via /dev/tcp"
  },
  {
    regex: /\bngrok\b|\blocaltunnel\b|\bserveo\b|\bcloudflared\b/i,
    patternId: "tunnel_service",
    severity: "high",
    category: "network",
    description: "uses tunneling service for external access"
  },
  {
    regex: /webhook\.site|requestbin\.com|pipedream\.net|hookbin\.com/i,
    patternId: "exfil_service",
    severity: "high",
    category: "network",
    description: "references known data exfiltration/webhook service"
  },
  // ── Obfuscation, Inline Shell Auto-Exec, & Supply-Chain Pipe-to-Shell ──
  {
    regex:
      /(?:\bbase64\s+(?:-[^\s|]+\s+)*?(?:-[a-z]*d[a-z]*|--decode)\b|\bopenssl\s+(?:base64|enc)\b[^|;&\n]*?\s-d\b)[^\n]*?(?:\||;|&&)\s*(?:sh|bash|zsh|ksh|dash|python[\d.]*|perl|ruby|node)\b/i,
    patternId: "base64_decode_pipe",
    severity: "high",
    category: "obfuscation",
    description: "base64 decodes and pipes to interpreter execution"
  },
  {
    regex: new RegExp(`echo\\s+[^\\n]*\\|\\s*(?:${SHELL_NAMES_RE}|python|perl|ruby|node)`, "i"),
    patternId: "echo_pipe_exec",
    severity: "critical",
    category: "obfuscation",
    description: "echo piped to interpreter for execution"
  },
  {
    regex: /!`[^`\s][^`\n]*`/,
    patternId: "inline_shell_exec",
    severity: "high",
    category: "execution",
    description: "inline-shell auto-exec snippet (!`cmd`) in SKILL.md body (Hermes #63307)"
  },
  {
    regex: new RegExp(`curl\\s+[^|\\s][^\\n]*\\|\\s*${SUDO_PREFIX}${SHELL_NAMES_RE}`, "i"),
    patternId: "curl_pipe_shell",
    severity: "critical",
    category: "supply_chain",
    description: "curl piped directly to shell (download-and-execute)"
  },
  {
    regex: new RegExp(`wget\\s+[^\\n]*-O\\s*-\\s*\\|\\s*${SUDO_PREFIX}${SHELL_NAMES_RE}`, "i"),
    patternId: "wget_pipe_shell",
    severity: "critical",
    category: "supply_chain",
    description: "wget piped directly to shell (download-and-execute)"
  },
  {
    regex: /\/etc\/passwd|\/etc\/shadow/i,
    patternId: "system_passwd_access",
    severity: "critical",
    category: "traversal",
    description: "references system password files"
  }
];

// Unicode tag block (U+E0000..U+E007F) & bidi override characters (U+202A..U+202E, U+2066..U+2069)
const INVISIBLE_STEGANOGRAPHY_RE = /[\u202A-\u202E\u2066-\u2069]|[\uDB40][\uDC00-\uDC7F]/u;

export function computeVerdictFromFindings(findings: readonly SkillScanFinding[]): SkillVerdict {
  let hasMediumOrLow = false;
  for (const f of findings) {
    if (f.severity === "critical" || f.severity === "high") {
      return "dangerous";
    }
    if (f.severity === "medium" || f.severity === "low") {
      hasMediumOrLow = true;
    }
  }
  return hasMediumOrLow ? "caution" : "safe";
}

export function shouldAllowSkillInstall(
  scan: SkillScanResult,
  opts?: { force?: boolean; operatorApproved?: boolean }
): { allowed: boolean; reason: string } {
  const decision = INSTALL_POLICY[scan.trustLevel][VERDICT_INDEX[scan.verdict]];
  if (decision === "allow") {
    return { allowed: true, reason: `Policy allows ${scan.trustLevel} skill with verdict '${scan.verdict}'.` };
  }
  if (decision === "ask" && opts?.operatorApproved) {
    return { allowed: true, reason: `Operator approved '${scan.verdict}' skill '${scan.skillName}'.` };
  }
  if (opts?.force && scan.verdict !== "dangerous") {
    return { allowed: true, reason: `Force flag overrode '${scan.verdict}' verdict.` };
  }
  return {
    allowed: false,
    reason:
      `PROMOTION_BLOCKED_SECURITY_SCAN: Skill '${scan.skillName}' (${scan.trustLevel}) ` +
      `received verdict '${scan.verdict}' with ${scan.findings.length} finding(s): ` +
      scan.findings.map((f) => `${f.patternId}[${f.severity}]@${f.file}:${f.line}`).join(", ")
  };
}

/**
 * Scans an in-memory map of `{ [relativePath]: fileContent }` using `skills-guard-v10`.
 */
export function scanSkillBundle(params: {
  skillName: string;
  files: Readonly<Record<string, string>>;
  source?: string;
  trustLevel?: SkillTrustLevel;
}): SkillScanResult {
  const findings: SkillScanFinding[] = [];
  const hash = crypto.createHash("sha256");

  for (const relFile of Object.keys(params.files).sort()) {
    const content = params.files[relFile] ?? "";
    hash.update(relFile).update("\0").update(content).update("\0");
    const lines = content.split(/\r?\n/);

    // Full-content multi-line patterns (HTML comment injection, hidden div)
    for (const pat of THREAT_PATTERNS) {
      if (pat.patternId === "html_comment_injection" || pat.patternId === "hidden_div") {
        const m = pat.regex.exec(content);
        if (m) {
          const line = content.slice(0, m.index).split(/\r?\n/).length;
          findings.push({
            patternId: pat.patternId,
            severity: pat.severity,
            category: pat.category,
            file: relFile,
            line,
            match: m[0].slice(0, 120),
            description: pat.description
          });
        }
      }
    }

    for (let idx = 0; idx < lines.length; idx++) {
      const lineText = lines[idx]!;
      if (INVISIBLE_STEGANOGRAPHY_RE.test(lineText)) {
        findings.push({
          patternId: "unicode_steganography",
          severity: "critical",
          category: "steganography",
          file: relFile,
          line: idx + 1,
          match: "<invisible-bidi-or-tag-codepoint>",
          description: "contains invisible Unicode bidi override or ASCII tag steganography"
        });
      }
      for (const pat of THREAT_PATTERNS) {
        if (pat.patternId === "html_comment_injection" || pat.patternId === "hidden_div") continue;
        const m = pat.regex.exec(lineText);
        if (m) {
          findings.push({
            patternId: pat.patternId,
            severity: pat.severity,
            category: pat.category,
            file: relFile,
            line: idx + 1,
            match: m[0].slice(0, 120),
            description: pat.description
          });
        }
      }
    }
  }

  const verdict = computeVerdictFromFindings(findings);
  const trustLevel = params.trustLevel ?? "agent-created";
  return {
    skillName: params.skillName,
    source: params.source ?? "distiller",
    trustLevel,
    verdict,
    findings,
    scannedAt: new Date().toISOString(),
    summary:
      findings.length === 0
        ? `Clean (${SCANNER_VERSION})`
        : `${verdict.toUpperCase()}: ${findings.length} finding(s) across ${Object.keys(params.files).length} file(s)`,
    scannerVersion: SCANNER_VERSION,
    contentSha256: hash.digest("hex")
  };
}

// ---------------------------------------------------------------------------
// Hermes `skill_manager_tool.py` + `skill_manager_guards.py` + `curator.py`
// ---------------------------------------------------------------------------

export const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ALLOWED_SKILL_SUBDIRS = new Set(["references", "templates", "scripts", "assets"]);
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_DESCRIPTION_CHARS = 1_024;
export const SKILL_PROMPT_DESC_BUDGET_CHARS = 8_000;
export const DEFAULT_STALE_AFTER_DAYS = 14;
export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
  body: string;
  pinned: boolean;
}

/**
 * Ported from `NousResearch/hermes-agent` `tools/skill_manager_tool.py` (`_validate_frontmatter`).
 */
export function validateSkillFrontmatter(content: string):
  | { valid: true; parsed: ParsedSkillFrontmatter }
  | { valid: false; error: string } {
  if (!content || !content.trim()) {
    return { valid: false, error: "Content cannot be empty." };
  }
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return {
      valid: false,
      error: `Content exceeds maximum length (${MAX_SKILL_CONTENT_CHARS} chars).`
    };
  }
  if (!content.startsWith("---")) {
    return {
      valid: false,
      error: "SKILL.md must start with YAML frontmatter delimited by '---'."
    };
  }
  const endMatch = /\n---\s*\n/.exec(content.slice(3));
  if (!endMatch) {
    return {
      valid: false,
      error: "YAML frontmatter is not closed. Ensure a closing '---' line precedes the markdown body."
    };
  }
  const yamlBlock = content.slice(3, 3 + endMatch.index);
  const body = content.slice(3 + endMatch.index + endMatch[0].length).trim();
  if (!body) {
    return {
      valid: false,
      error: "SKILL.md body after frontmatter cannot be empty."
    };
  }

  const fields: Record<string, string> = {};
  for (const rawLine of yamlBlock.split(/\r?\n/)) {
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = rawLine.slice(0, colonIdx).trim();
    const val = rawLine
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    fields[key] = val;
  }

  const name = fields["name"] ?? "";
  const description = fields["description"] ?? "";
  if (!name) {
    return { valid: false, error: "Frontmatter must include 'name' field." };
  }
  if (!VALID_SKILL_NAME_RE.test(name)) {
    return {
      valid: false,
      error: `Invalid skill name '${name}'. Must match ${VALID_SKILL_NAME_RE.source}.`
    };
  }
  if (!description) {
    return { valid: false, error: "Frontmatter must include 'description' field." };
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return {
      valid: false,
      error: `'description' exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters (${description.length}).`
    };
  }
  return {
    valid: true,
    parsed: {
      name,
      description,
      body,
      pinned: fields["pinned"] === "true"
    }
  };
}

/**
 * Ported from `NousResearch/hermes-agent` `tools/skill_manager_guards.py` (`_validate_delete_target`):
 * Refuses symlinks (Kilo Code #11227 class defense), root directories, or path escapes!
 */
export function validateSafeSkillTargetDir(targetDir: string, allowedRootDir: string): string | null {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(allowedRootDir);
  } catch {
    return `Allowed skills root does not exist: '${allowedRootDir}'`;
  }

  try {
    const lstat = fs.lstatSync(targetDir);
    if (lstat.isSymbolicLink()) {
      return `SKILL_SYMLINK_REFUSED: Refusing to modify or delete symlink '${targetDir}' (Hermes/Kilo #11227 guard).`;
    }
    if (!lstat.isDirectory()) {
      return `Expected skill directory at '${targetDir}', found non-directory.`;
    }
  } catch {
    return `Skill target does not exist: '${targetDir}'.`;
  }

  const resolvedTarget = fs.realpathSync(targetDir);
  if (resolvedTarget === rootReal) {
    return `SKILL_ROOT_DELETE_REFUSED: Refusing to delete the skills root directory itself.`;
  }
  if (!resolvedTarget.startsWith(rootReal + path.sep)) {
    return `SKILL_ESCAPE_REFUSED: Target '${resolvedTarget}' resolves outside '${rootReal}'.`;
  }
  return null;
}

export interface SkillLedgerRecord {
  name: string;
  description: string;
  status: SkillLifecycleStatus;
  pinned: boolean;
  cronReferenced: boolean;
  useCount: number;
  createdAtMs: number;
  lastUsedAtMs: number | null;
  staleSinceMs: number | null;
  archivedAtMs: number | null;
  absorbedInto: string | null;
  lastScanVerdict: SkillVerdict;
  lastScanJson: string;
  contentSha256: string;
}

export interface CuratorTransitionSummary {
  markedStale: string[];
  archived: string[];
  skippedProtected: string[];
}

export class QuarantinedSkillCurator {
  private readonly db: DatabaseSync;
  private readonly workspaceRoot: string;
  private readonly durabilityMode: DurabilityMode;
  readonly quarantineDir: string;
  readonly activeSkillsDir: string;
  readonly archiveDir: string;
  private readonly readReviewedSkills = new Set<string>();

  constructor(params: {
    db: DatabaseSync;
    workspaceRoot: string;
    durabilityMode?: DurabilityMode;
  }) {
    this.db = params.db;
    this.workspaceRoot = path.resolve(params.workspaceRoot);
    this.durabilityMode = params.durabilityMode ?? "crash-safe";
    this.quarantineDir = path.join(this.workspaceRoot, ".skills-quarantine");
    this.activeSkillsDir = path.join(this.workspaceRoot, ".agents", "skills");
    this.archiveDir = path.join(this.workspaceRoot, ".agents", ".archive");

    fs.mkdirSync(this.quarantineDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(this.activeSkillsDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o755 });

    this._initSchema();
  }

  private _initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ring3_skills_ledger (
        name               TEXT PRIMARY KEY,
        description        TEXT NOT NULL,
        status             TEXT NOT NULL CHECK (status IN ('quarantined','active','stale','archived')),
        pinned             INTEGER NOT NULL DEFAULT 0,
        cron_referenced    INTEGER NOT NULL DEFAULT 0,
        use_count          INTEGER NOT NULL DEFAULT 0,
        created_at_ms      INTEGER NOT NULL,
        last_used_at_ms    INTEGER,
        stale_since_ms     INTEGER,
        archived_at_ms     INTEGER,
        absorbed_into      TEXT,
        last_scan_verdict  TEXT NOT NULL CHECK (last_scan_verdict IN ('safe','caution','dangerous')),
        last_scan_json     TEXT NOT NULL,
        content_sha256     TEXT NOT NULL
      );
    `);
  }

  /**
   * Distills or stages a new skill strictly into `.skills-quarantine/<name>/SKILL.md`.
   * NEVER writes directly into `.agents/skills/`!
   */
  distillToQuarantine(params: {
    skillMd: string;
    supportingFiles?: Record<string, string>;
    source?: string;
    trustLevel?: SkillTrustLevel;
    nowMs?: number;
  }): {
    quarantinedPath: string;
    scan: SkillScanResult;
    record: SkillLedgerRecord;
  } {
    const scrubbedSkillMd = scrubSecretsInfallible(params.skillMd);
    const fmCheck = validateSkillFrontmatter(scrubbedSkillMd);
    if (!fmCheck.valid) {
      throw new Error(`SKILL_FRONTMATTER_INVALID: ${fmCheck.error}`);
    }
    const { name, description, pinned } = fmCheck.parsed;

    const bundle: Record<string, string> = { "SKILL.md": scrubbedSkillMd };
    if (params.supportingFiles) {
      for (const [relPath, rawBody] of Object.entries(params.supportingFiles)) {
        const cleanRel = path.posix.normalize(relPath.replace(/\\/g, "/"));
        if (cleanRel.startsWith("..") || path.posix.isAbsolute(cleanRel)) {
          throw new Error(`SKILL_SUBFILE_ESCAPE: Supporting file '${relPath}' escapes skill root.`);
        }
        const topDir = cleanRel.split("/")[0] ?? "";
        if (!ALLOWED_SKILL_SUBDIRS.has(topDir)) {
          throw new Error(
            `SKILL_SUBDIR_FORBIDDEN: Supporting file '${relPath}' must live under ${[
              ...ALLOWED_SKILL_SUBDIRS
            ].join(", ")}.`
          );
        }
        bundle[cleanRel] = scrubSecretsInfallible(rawBody);
      }
    }

    const scan = scanSkillBundle({
      skillName: name,
      files: bundle,
      source: params.source ?? "autonomous-distiller",
      trustLevel: params.trustLevel ?? "agent-created"
    });

    const skillQuarantineDir = path.join(this.quarantineDir, name);
    for (const [relFile, body] of Object.entries(bundle)) {
      writeFileDurable(path.join(skillQuarantineDir, relFile), body, this.durabilityMode, {
        workspaceRoot: this.workspaceRoot,
        mode: 0o644
      });
    }

    const nowMs = params.nowMs ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO ring3_skills_ledger (
           name, description, status, pinned, cron_referenced, use_count,
           created_at_ms, last_used_at_ms, stale_since_ms, archived_at_ms,
           absorbed_into, last_scan_verdict, last_scan_json, content_sha256
         ) VALUES (?, ?, 'quarantined', ?, 0, 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           status = 'quarantined',
           pinned = excluded.pinned,
           last_scan_verdict = excluded.last_scan_verdict,
           last_scan_json = excluded.last_scan_json,
           content_sha256 = excluded.content_sha256`
      )
      .run(
        name,
        description,
        pinned ? 1 : 0,
        nowMs,
        scan.verdict,
        JSON.stringify(scan),
        scan.contentSha256
      );

    return {
      quarantinedPath: path.join(".skills-quarantine", name, "SKILL.md"),
      scan,
      record: this.getSkillRecord(name)!
    };
  }

  /**
   * Promotes a skill from `.skills-quarantine/<name>` -> `.agents/skills/<name>` ONLY IF:
   *  1. Operator explicitly approved promotion (`operatorApproved === true`)
   *  2. Re-scanning the quarantined files passes `shouldAllowSkillInstall` (`verdict !== 'dangerous'`)
   *  3. Active skill description budget (`SKILL_PROMPT_DESC_BUDGET_CHARS`) is respected.
   */
  promoteFromQuarantine(params: {
    name: string;
    operatorApproved: boolean;
    nowMs?: number;
  }): { promotedPath: string; scan: SkillScanResult; record: SkillLedgerRecord } {
    if (!VALID_SKILL_NAME_RE.test(params.name)) {
      throw new Error(`Invalid skill name '${params.name}'.`);
    }
    if (!params.operatorApproved) {
      throw new Error(
        `PROMOTION_REQUIRES_APPROVAL: Quarantined skill '${params.name}' cannot enter '.agents/skills/' without explicit operatorApproved=true.`
      );
    }

    const qDir = path.join(this.quarantineDir, params.name);
    const dirErr = validateSafeSkillTargetDir(qDir, this.quarantineDir);
    if (dirErr) {
      throw new Error(dirErr);
    }

    const bundle = this._readBundleRecursive(qDir);
    if (!bundle["SKILL.md"]) {
      throw new Error(`Quarantined skill '${params.name}' is missing SKILL.md.`);
    }

    const fmCheck = validateSkillFrontmatter(bundle["SKILL.md"]);
    if (!fmCheck.valid) {
      throw new Error(`SKILL_FRONTMATTER_INVALID: ${fmCheck.error}`);
    }

    const scan = scanSkillBundle({
      skillName: params.name,
      files: bundle,
      source: "quarantine-promotion",
      trustLevel: "agent-created"
    });
    const gate = shouldAllowSkillInstall(scan, { operatorApproved: params.operatorApproved });
    if (!gate.allowed) {
      throw new Error(gate.reason);
    }

    // Enforce Hermes `SKILL_PROMPT_DESC_LIMIT` across active skills
    const activeTotalChars = this.listSkills("active")
      .filter((s) => s.name !== params.name)
      .reduce((acc, s) => acc + s.name.length + s.description.length + 4, 0);
    if (
      activeTotalChars + fmCheck.parsed.name.length + fmCheck.parsed.description.length >
      SKILL_PROMPT_DESC_BUDGET_CHARS
    ) {
      throw new Error(
        `SKILL_INDEX_BUDGET_EXCEEDED: Promoting '${params.name}' would exceed ${SKILL_PROMPT_DESC_BUDGET_CHARS}-char active skill description index budget.`
      );
    }

    const activeDestDir = path.join(this.activeSkillsDir, params.name);
    for (const [relFile, body] of Object.entries(bundle)) {
      writeFileDurable(path.join(activeDestDir, relFile), body, this.durabilityMode, {
        workspaceRoot: this.workspaceRoot,
        mode: 0o644
      });
    }
    fs.rmSync(qDir, { recursive: true, force: true });

    const nowMs = params.nowMs ?? Date.now();
    this.db
      .prepare(
        `UPDATE ring3_skills_ledger
         SET status = 'active',
             description = ?,
             last_used_at_ms = COALESCE(last_used_at_ms, ?),
             stale_since_ms = NULL,
             archived_at_ms = NULL,
             last_scan_verdict = ?,
             last_scan_json = ?,
             content_sha256 = ?
         WHERE name = ?`
      )
      .run(
        fmCheck.parsed.description,
        nowMs,
        scan.verdict,
        JSON.stringify(scan),
        scan.contentSha256,
        params.name
      );

    return {
      promotedPath: path.join(".agents", "skills", params.name, "SKILL.md"),
      scan,
      record: this.getSkillRecord(params.name)!
    };
  }

  /**
   * Marks a skill as read/inspected in the current curation pass (Hermes `_background_review_read_before_write_guard`)
   * and optionally increments live usage telemetry.
   */
  inspectOrRecordUse(name: string, opts?: { recordUse?: boolean; nowMs?: number }): string {
    const rec = this.getSkillRecord(name);
    if (!rec) throw new Error(`Skill '${name}' not found.`);
    const dir =
      rec.status === "quarantined"
        ? path.join(this.quarantineDir, name)
        : rec.status === "archived"
          ? path.join(this.archiveDir, name)
          : path.join(this.activeSkillsDir, name);
    const mdPath = path.join(dir, "SKILL.md");
    const content = fs.readFileSync(mdPath, "utf8");
    this.readReviewedSkills.add(name);

    if (opts?.recordUse && (rec.status === "active" || rec.status === "stale")) {
      const nowMs = opts.nowMs ?? Date.now();
      this.db
        .prepare(
          `UPDATE ring3_skills_ledger
           SET use_count = use_count + 1,
               last_used_at_ms = ?,
               status = 'active',
               stale_since_ms = NULL
           WHERE name = ?`
        )
        .run(nowMs, name);
    }
    return content;
  }

  setSkillFlags(name: string, flags: { pinned?: boolean; cronReferenced?: boolean }): void {
    const rec = this.getSkillRecord(name);
    if (!rec) throw new Error(`Skill '${name}' not found.`);
    this.db
      .prepare(
        `UPDATE ring3_skills_ledger
         SET pinned = ?, cron_referenced = ?
         WHERE name = ?`
      )
      .run(
        (flags.pinned ?? rec.pinned) ? 1 : 0,
        (flags.cronReferenced ?? rec.cronReferenced) ? 1 : 0,
        name
      );
  }

  /**
   * Background curator consolidation archival (`NousResearch/hermes-agent` #29912 + #11227 guards):
   *  - Refuses symlinks & root deletion (`validateSafeSkillTargetDir`)
   *  - Refuses pinned or cron-referenced skills
   *  - Requires `inspectOrRecordUse(name)` read-before-write during review
   *  - Requires `absorbedInto` naming an existing active/stale umbrella skill (`#29912`)!
   */
  consolidateIntoUmbrella(params: {
    name: string;
    absorbedInto: string;
    nowMs?: number;
  }): SkillLedgerRecord {
    const rec = this.getSkillRecord(params.name);
    if (!rec) throw new Error(`Skill '${params.name}' not found.`);
    if (rec.pinned) {
      throw new Error(`SKILL_PINNED_GUARD: Skill '${params.name}' is pinned and cannot be archived.`);
    }
    if (rec.cronReferenced) {
      throw new Error(
        `SKILL_CRON_GUARD: Skill '${params.name}' is referenced by a scheduled cron job and cannot be archived.`
      );
    }
    if (!this.readReviewedSkills.has(params.name)) {
      throw new Error(
        `SKILL_READ_BEFORE_WRITE_GUARD: Curator must inspect '${params.name}' before consolidating it.`
      );
    }
    if (!params.absorbedInto || params.absorbedInto === params.name) {
      throw new Error(
        `SKILL_CONSOLIDATION_GUARD (#29912): Consolidating '${params.name}' requires absorbedInto='<umbrella-skill>'.`
      );
    }
    const umbrella = this.getSkillRecord(params.absorbedInto);
    if (!umbrella || (umbrella.status !== "active" && umbrella.status !== "stale")) {
      throw new Error(
        `SKILL_CONSOLIDATION_GUARD (#29912): Umbrella skill '${params.absorbedInto}' does not exist in active skills.`
      );
    }

    this._moveActiveSkillToArchive(params.name, params.nowMs ?? Date.now(), params.absorbedInto);
    return this.getSkillRecord(params.name)!;
  }

  /**
   * Ported directly from `NousResearch/hermes-agent` `agent/curator.py` (`apply_automatic_transitions`):
   *  - `active -> stale` after `staleAfterDays` (default 14d) of inactivity
   *  - `stale -> archived` after `archiveAfterDays` (default 30d) of inactivity
   *  - Never archives `pinned`, `cronReferenced`, or `useCount === 0` skills younger than `staleAfterDays`!
   */
  archiveSkill(name:string,nowMs=Date.now()):SkillLedgerRecord{
    const rec=this.getSkillRecord(name);if(!rec)throw new Error("SKILL_NOT_FOUND");
    if(rec.status!=="active"&&rec.status!=="stale")throw new Error("SKILL_ARCHIVE_STATUS_INVALID");
    if(rec.pinned||rec.cronReferenced)throw new Error("SKILL_ARCHIVE_PROTECTED");
    this._moveActiveSkillToArchive(name,nowMs,rec.absorbedInto);
    return this.getSkillRecord(name)!;
  }

  deleteSkill(name:string):void{
    const rec=this.getSkillRecord(name);if(!rec)throw new Error("SKILL_NOT_FOUND");
    if(rec.status!=="quarantined"&&rec.status!=="archived")throw new Error("SKILL_DELETE_STATUS_INVALID");
    const parent=rec.status==="quarantined"?this.quarantineDir:this.archiveDir;
    const dir=path.join(parent,name);const safeErr=validateSafeSkillTargetDir(dir,parent);if(safeErr)throw new Error(safeErr);
    fs.rmSync(dir,{recursive:true,force:true});this.db.prepare("DELETE FROM ring3_skills_ledger WHERE name=?").run(name);
  }

  runAutomaticLifecyclePass(params?: {
    nowMs?: number;
    staleAfterDays?: number;
    archiveAfterDays?: number;
  }): CuratorTransitionSummary {
    const nowMs = params?.nowMs ?? Date.now();
    const staleThresholdMs = (params?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS) * MS_PER_DAY;
    const archiveThresholdMs = (params?.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS) * MS_PER_DAY;

    const markedStale: string[] = [];
    const archived: string[] = [];
    const skippedProtected: string[] = [];

    for (const rec of this.listSkills()) {
      if (rec.status === "quarantined" || rec.status === "archived") continue;
      if (rec.pinned || rec.cronReferenced) {
        skippedProtected.push(rec.name);
        continue;
      }

      const ageSinceCreatedMs = Math.max(0, nowMs - rec.createdAtMs);
      const lastTouchMs = rec.lastUsedAtMs ?? rec.createdAtMs;
      const inactiveMs = Math.max(0, nowMs - lastTouchMs);

      // Hermes `curator.py` lines 234-236: never archive `use_count === 0` skills younger than stale window
      if (rec.useCount === 0 && ageSinceCreatedMs < staleThresholdMs) {
        continue;
      }

      if (rec.status === "active" && inactiveMs >= staleThresholdMs) {
        this.db
          .prepare(`UPDATE ring3_skills_ledger SET status = 'stale', stale_since_ms = ? WHERE name = ?`)
          .run(nowMs, rec.name);
        markedStale.push(rec.name);
      } else if (rec.status === "stale" && inactiveMs >= archiveThresholdMs) {
        this._moveActiveSkillToArchive(rec.name, nowMs, rec.absorbedInto);
        archived.push(rec.name);
      }
    }

    return { markedStale, archived, skippedProtected };
  }

  private _moveActiveSkillToArchive(
    name: string,
    nowMs: number,
    absorbedInto: string | null
  ): void {
    const activeDir = path.join(this.activeSkillsDir, name);
    const safeErr = validateSafeSkillTargetDir(activeDir, this.activeSkillsDir);
    if (safeErr) {
      throw new Error(safeErr);
    }

    const bundle = this._readBundleRecursive(activeDir);
    const destArchiveDir = path.join(this.archiveDir, name);
    for (const [relFile, body] of Object.entries(bundle)) {
      writeFileDurable(path.join(destArchiveDir, relFile), body, this.durabilityMode, {
        workspaceRoot: this.workspaceRoot,
        mode: 0o644
      });
    }
    fs.rmSync(activeDir, { recursive: true, force: true });

    this.db
      .prepare(
        `UPDATE ring3_skills_ledger
         SET status = 'archived',
             archived_at_ms = ?,
             absorbed_into = ?
         WHERE name = ?`
      )
      .run(nowMs, absorbedInto, name);
  }

  private _readBundleRecursive(rootDir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (currDir: string) => {
      for (const entry of fs.readdirSync(currDir, { withFileTypes: true })) {
        const full = path.join(currDir, entry.name);
        const lstat = fs.lstatSync(full);
        if (lstat.isSymbolicLink()) {
          throw new Error(
            `SKILL_SYMLINK_REFUSED: Symlink '${full}' inside skill bundle is forbidden (#11227).`
          );
        }
        if (lstat.isDirectory()) {
          walk(full);
        } else if (lstat.isFile()) {
          const rel = path.relative(rootDir, full).replace(/\\/g, "/");
          out[rel] = fs.readFileSync(full, "utf8");
        }
      }
    };
    walk(rootDir);
    return out;
  }

  getSkillRecord(name: string): SkillLedgerRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ring3_skills_ledger WHERE name = ?`)
      .get(name) as Record<string, unknown> | undefined;
    return row ? this._mapRow(row) : undefined;
  }

  listSkills(status?: SkillLifecycleStatus): SkillLedgerRecord[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM ring3_skills_ledger WHERE status = ? ORDER BY name ASC`)
          .all(status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM ring3_skills_ledger ORDER BY name ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this._mapRow(r));
  }

  private _mapRow(row: Record<string, unknown>): SkillLedgerRecord {
    return {
      name: String(row["name"]),
      description: String(row["description"]),
      status: row["status"] as SkillLifecycleStatus,
      pinned: Number(row["pinned"]) === 1,
      cronReferenced: Number(row["cron_referenced"]) === 1,
      useCount: Number(row["use_count"]),
      createdAtMs: Number(row["created_at_ms"]),
      lastUsedAtMs: row["last_used_at_ms"] !== null ? Number(row["last_used_at_ms"]) : null,
      staleSinceMs: row["stale_since_ms"] !== null ? Number(row["stale_since_ms"]) : null,
      archivedAtMs: row["archived_at_ms"] !== null ? Number(row["archived_at_ms"]) : null,
      absorbedInto: row["absorbed_into"] !== null ? String(row["absorbed_into"]) : null,
      lastScanVerdict: row["last_scan_verdict"] as SkillVerdict,
      lastScanJson: String(row["last_scan_json"]),
      contentSha256: String(row["content_sha256"])
    };
  }
}
