import path from "node:path";

/**
 * Deterministic Stage-by-Stage Shell Pipeline & Egress Sandbox Gate.
 * Runs in <1ms inside Pi's `tool_call` hook (zero LLM tokens, zero hallucinations).
 */
export class ShellSandboxGate {
  constructor(policy = {}) {
    this.allowedDomains = new Set(
      policy.allowedDomains ?? ["api.github.com", "registry.npmjs.org", "pypi.org"]
    );
    this.denyPipeInterpreters = new Set(
      policy.denyPipeInterpreters ?? ["sh", "bash", "zsh", "dash", "python", "python3", "node", "perl", "ruby"]
    );
    this.denyCommands = new Set(policy.denyCommands ?? ["nc", "ncat", "socat", "telnet"]);
    this.readOnlyMounts = policy.readOnlyMounts ?? [".git/hooks", ".git/config", ".harness", ".pi"];
  }

  /**
   * Splits compound shell scripts into statements (`;`, `&&`, `||`, `\n`, `$(...)`, backticks)
   * and splits each statement into pipeline stages (`|`), respecting single/double quotes.
   */
  parseCompoundStages(script) {
    const stages = [];
    // Extract command substitutions `$(...)` and ``...`` recursively so subshells can't hide attacks
    const subshellRegex = /\$\(([^)]+)\)|`([^`]+)`/g;
    let m;
    while ((m = subshellRegex.exec(script)) !== null) {
      const inner = m[1] ?? m[2];
      stages.push(...this.parseCompoundStages(inner));
    }

    const statements = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < script.length; i++) {
      const ch = script[i];
      if (quote) {
        cur += ch;
        if (ch === quote && script[i - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === ";" || ch === "\n") {
        if (cur.trim()) statements.push(cur.trim());
        cur = "";
        continue;
      }
      if ((ch === "&" && script[i + 1] === "&") || (ch === "|" && script[i + 1] === "|")) {
        if (cur.trim()) statements.push(cur.trim());
        cur = "";
        i++;
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) statements.push(cur.trim());

    for (const stmt of statements) {
      // Split single `|` pipeline stages respecting quotes
      const pipeParts = [];
      let pCur = "";
      let pQuote = null;
      for (let i = 0; i < stmt.length; i++) {
        const ch = stmt[i];
        if (pQuote) {
          pCur += ch;
          if (ch === pQuote && stmt[i - 1] !== "\\") pQuote = null;
          continue;
        }
        if (ch === "'" || ch === '"') {
          pQuote = ch;
          pCur += ch;
          continue;
        }
        if (ch === "|") {
          if (pCur.trim()) pipeParts.push(pCur.trim());
          pCur = "";
          continue;
        }
        pCur += ch;
      }
      if (pCur.trim()) pipeParts.push(pCur.trim());
      stages.push({ statement: stmt, pipeline: pipeParts });
    }
    return stages;
  }

  inspectCommand(script) {
    const parsed = this.parseCompoundStages(script);
    for (const { statement, pipeline } of parsed) {
      // 1. Check pipe-to-interpreter (`curl ... | jq ... | sh`)
      if (pipeline.length > 1) {
        const hasNetworkProducer = pipeline.slice(0, -1).some((stage) =>
          /\b(curl|wget|fetch|http)\b/.test(stage)
        );
        for (let idx = 1; idx < pipeline.length; idx++) {
          const tokens = pipeline[idx].trim().split(/\s+/);
          // Skip leading env assignments `FOO=1 sh`
          const cmdToken = tokens.find((t) => !t.includes("=")) ?? tokens[0];
          const baseCmd = path.basename(cmdToken || "");
          if (this.denyPipeInterpreters.has(baseCmd) && (hasNetworkProducer || idx > 0)) {
            return {
              block: true,
              reason: `SHELL_AST_GATE: Blocked pipeline stage [${idx + 1}/${pipeline.length}] piping into interpreter '${baseCmd}' in: ${statement}`,
            };
          }
        }
      }

      for (const stage of pipeline) {
        const tokens = stage.trim().split(/\s+/);
        const cmdToken = tokens.find((t) => !t.includes("=")) ?? tokens[0];
        const baseCmd = path.basename(cmdToken || "");

        // 2. Raw socket tools that bypass proxy controls
        if (this.denyCommands.has(baseCmd)) {
          return {
            block: true,
            reason: `SHELL_AST_GATE: Disallowed raw socket binary '${baseCmd}'`,
          };
        }

        // 3. Proxy-bypass flags (`curl --noproxy '*'`)
        if (/\-\-noproxy\b|\bNO_PROXY=/i.test(stage)) {
          return {
            block: true,
            reason: `SHELL_AST_GATE: Proxy-bypass flag (--noproxy / NO_PROXY) is forbidden inside default-deny sandbox`,
          };
        }

        // 4. Protected secret / read-only harness path access
        if (/(\.env(\.|$|\s)|id_rsa|\.pem\b)/.test(stage)) {
          return {
            block: true,
            reason: `SHELL_AST_GATE: Direct shell access to secret file (.env / key) blocked: ${stage}`,
          };
        }
        if (/(\.git\/hooks|\.git\/config|\.harness\/|\.pi\/)/.test(stage) && /(>|>>|\brm\b|\bmv\b|\bcp\b|\btee\b|\bchmod\b)/.test(stage)) {
          return {
            block: true,
            reason: `SHELL_AST_GATE: Write/mutation targeting read-only control plane (.git/hooks, .harness, .pi) blocked`,
          };
        }

        // 5. Egress URL domain pre-check (defense-in-depth alongside network namespace proxy)
        const urlMatches = stage.match(/https?:\/\/([a-zA-Z0-9.-]+)/g) ?? [];
        for (const rawUrl of urlMatches) {
          const host = new URL(rawUrl).hostname;
          if (!this.allowedDomains.has(host)) {
            return {
              block: true,
              reason: `EGRESS_ALLOWLIST_GATE: Outbound host '${host}' is not in GUARDRAILS.yaml allowed_domains`,
            };
          }
        }
      }
    }
    return { block: false };
  }

  /**
   * Builds the OS-native confinement specification (`bwrap --unshare-net` on Linux,
   * `sandbox-exec` Seatbelt profile on macOS) with read-only `.git/hooks` & `.harness` mounts.
   */
  buildConfinementSpec(platform, workspaceRoot, proxyUnixSocket) {
    if (platform === "linux") {
      const args = [
        "bwrap",
        "--unshare-net", // Zero network interfaces inside namespace; egress only via proxy socket
        "--ro-bind", "/", "/",
        "--bind", workspaceRoot, workspaceRoot,
        "--tmpfs", "/tmp",
        "--ro-bind-try", path.join(workspaceRoot, ".git/hooks"), path.join(workspaceRoot, ".git/hooks"),
        "--ro-bind-try", path.join(workspaceRoot, ".git/config"), path.join(workspaceRoot, ".git/config"),
        "--ro-bind-try", path.join(workspaceRoot, ".harness"), path.join(workspaceRoot, ".harness"),
        "--ro-bind-try", path.join(workspaceRoot, ".pi"), path.join(workspaceRoot, ".pi"),
        "--bind", proxyUnixSocket, proxyUnixSocket,
        "--die-with-parent",
      ];
      return { engine: "linux-bwrap-netns", argvPrefix: args };
    }
    if (platform === "darwin") {
      const profile = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        `(allow file-write* (subpath "${workspaceRoot}") (subpath "/private/tmp"))`,
        `(deny file-write* (subpath "${path.join(workspaceRoot, ".git/hooks")}"))`,
        `(deny file-write* (subpath "${path.join(workspaceRoot, ".harness")}"))`,
        "(deny network-outbound)",
        `(allow network-outbound (remote unix-socket (path-literal "${proxyUnixSocket}")))`,
      ].join("\n");
      return { engine: "macos-seatbelt", argvPrefix: ["sandbox-exec", "-p", profile] };
    }
    return { engine: "win32-restricted-acl", argvPrefix: [] };
  }
}
