import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAndValidateWorkspacePath } from "../core/monotonic-guard.ts";
import { readWorkspaceFileSafe } from "../core/safe-path.ts";
import type { GuardrailsConfig } from "../types.ts";

export type LspOperationName =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls"
  | "diagnostics";

export interface LspDiagnosticItem {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1 = Error, 2 = Warning, 3 = Information, 4 = Hint
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspServerCommandSpec {
  languageId: string;
  extensions: string[];
  command: string;
  args: string[];
}

export interface LspManagerOptions {
  workspaceRoot: string;
  guardrails: GuardrailsConfig;
  /** Workspace trust flag (`false` disables spawning LSP subprocesses against untrusted repo configs!). Default `true`. */
  trustedRepo?: boolean;
  /** Explicit server specs (overrides/extends auto-detected system LSP binaries). */
  servers?: LspServerCommandSpec[];
  requestTimeoutMs?: number;
  diagnosticsWaitMs?: number;
}

const DEFAULT_SYSTEM_LSP_CANDIDATES: LspServerCommandSpec[] = [
  {
    languageId: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    command: "typescript-language-server",
    args: ["--stdio"]
  },
  {
    languageId: "python",
    extensions: [".py"],
    command: "pylsp",
    args: []
  },
  {
    languageId: "go",
    extensions: [".go"],
    command: "gopls",
    args: ["serve"]
  },
  {
    languageId: "rust",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: []
  },
  {
    languageId: "c",
    extensions: [".c", ".h", ".cpp", ".hpp"],
    command: "clangd",
    args: ["--log=error"]
  }
];

function commandExistsOnPath(cmd: string): boolean {
  if (path.isAbsolute(cmd)) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Single language server stdio `Content-Length` JSON-RPC 2.0 connection.
 */
class StdioLspConnection {
  readonly spec: LspServerCommandSpec;
  private readonly workspaceRoot: string;
  private readonly requestTimeoutMs: number;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readBuf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly docVersions = new Map<string, number>();
  private readonly diagnosticsByUri = new Map<string, LspDiagnosticItem[]>();
  private readonly diagWaiters = new Map<string, Array<(items: LspDiagnosticItem[]) => void>>();
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(spec: LspServerCommandSpec, workspaceRoot: string, requestTimeoutMs: number) {
    this.spec = spec;
    this.workspaceRoot = workspaceRoot;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async ensureInitialized(): Promise<void> {
    if (this.closed) throw new Error(`LSP connection for ${this.spec.languageId} is closed`);
    if (!this.initPromise) {
      this.initPromise = this.spawnAndInitialize();
    }
    return this.initPromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    const sanitizedEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8"
    };

    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.workspaceRoot,
      env: sanitizedEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc = child;

    child.stdout.on("data", (chunk: Buffer) => {
      this.onStdoutChunk(chunk);
    });

    child.on("error", (err) => {
      this.rejectAllPending(new Error(`LSP process error (${this.spec.languageId}): ${err.message}`));
    });

    child.on("close", (code, sig) => {
      this.proc = null;
      if (!this.closed) {
        this.rejectAllPending(
          new Error(`LSP process (${this.spec.languageId}) exited unexpectedly (code=${code}, sig=${sig})`)
        );
      }
    });

    const rootUri = pathToFileURL(this.workspaceRoot).href;
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          implementation: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true }
        },
        workspace: {
          symbol: { dynamicRegistration: false }
        }
      }
    });
    this.sendNotification("initialized", {});
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.readBuf = Buffer.concat([this.readBuf, chunk]);

    while (true) {
      const headerEnd = this.readBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerAscii = this.readBuf.subarray(0, headerEnd).toString("ascii");
      const m = headerAscii.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        // Malformed frame header; advance past separator safely
        this.readBuf = this.readBuf.subarray(headerEnd + 4);
        continue;
      }

      const contentLen = Number.parseInt(m[1], 10);
      const frameEnd = headerEnd + 4 + contentLen;
      if (this.readBuf.length < frameEnd) return; // Wait for remaining body bytes

      const jsonBytes = this.readBuf.subarray(headerEnd + 4, frameEnd);
      this.readBuf = this.readBuf.subarray(frameEnd);

      try {
        const msg = JSON.parse(jsonBytes.toString("utf8")) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { code: number; message: string };
        };
        this.handleParsedJsonRpc(msg);
      } catch {
        // Ignore non-JSON noise
      }
    }
  }

  private handleParsedJsonRpc(msg: {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
  }): void {
    if (typeof msg.id === "number" && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(`LSP RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "textDocument/publishDiagnostics") {
      const p = msg.params as { uri?: string; diagnostics?: LspDiagnosticItem[] } | undefined;
      if (p?.uri && Array.isArray(p.diagnostics)) {
        this.diagnosticsByUri.set(p.uri, p.diagnostics);
        const waiters = this.diagWaiters.get(p.uri);
        if (waiters && waiters.length > 0) {
          this.diagWaiters.delete(p.uri);
          for (const w of waiters) w(p.diagnostics);
        }
      }
      return;
    }

    // Respond cleanly to server-to-client requests (e.g. `workspace/configuration` or `client/registerCapability`)
    if (typeof msg.id === "number" && msg.method) {
      this.writeFrame({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }

  private writeFrame(payload: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error(`LSP stdin not writable (${this.spec.languageId})`);
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  sendNotification(method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeFrame({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async syncDocument(absPath: string, text: string): Promise<string> {
    await this.ensureInitialized();
    const uri = pathToFileURL(absPath).href;
    const prevVersion = this.docVersions.get(uri);

    if (prevVersion === undefined) {
      this.docVersions.set(uri, 1);
      this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.spec.languageId,
          version: 1,
          text
        }
      });
    } else {
      const nextVersion = prevVersion + 1;
      this.docVersions.set(uri, nextVersion);
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text }]
      });
    }
    return uri;
  }

  getCachedDiagnostics(absPath: string): LspDiagnosticItem[] {
    const uri = pathToFileURL(absPath).href;
    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async syncAndWaitDiagnostics(absPath: string, text: string, waitMs: number): Promise<LspDiagnosticItem[]> {
    await this.ensureInitialized();
    const uri = pathToFileURL(absPath).href;

    const waitPromise = new Promise<LspDiagnosticItem[]>((resolve) => {
      const timer = setTimeout(() => {
        const arr = this.diagWaiters.get(uri);
        if (arr) {
          const idx = arr.indexOf(onDiag);
          if (idx !== -1) arr.splice(idx, 1);
        }
        resolve(this.diagnosticsByUri.get(uri) ?? []);
      }, waitMs);

      const onDiag = (items: LspDiagnosticItem[]) => {
        clearTimeout(timer);
        resolve(items);
      };

      const list = this.diagWaiters.get(uri) ?? [];
      list.push(onDiag);
      this.diagWaiters.set(uri, list);
    });

    await this.syncDocument(absPath, text);
    return waitPromise;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.proc) return;

    try {
      await Promise.race([
        this.sendRequest("shutdown", null),
        new Promise((r) => setTimeout(r, 300))
      ]);
      this.sendNotification("exit", null);
    } catch {
      // Ignore shutdown errors on tear-down
    } finally {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.proc = null;
      this.rejectAllPending(new Error("LSP shut down"));
    }
  }
}

export class LspClientManager {
  readonly workspaceRoot: string;
  private readonly guardrails: GuardrailsConfig;
  private readonly trustedRepo: boolean;
  private readonly extToSpec = new Map<string, LspServerCommandSpec>();
  private readonly connections = new Map<string, StdioLspConnection>();
  private readonly requestTimeoutMs: number;
  private readonly diagnosticsWaitMs: number;
  readonly touchedFiles: string[] = [];

  constructor(opts: LspManagerOptions) {
    this.workspaceRoot = fs.realpathSync(opts.workspaceRoot);
    this.guardrails = opts.guardrails;
    this.trustedRepo = opts.trustedRepo ?? true;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.diagnosticsWaitMs = opts.diagnosticsWaitMs ?? 200;

    if (!this.trustedRepo) return;

    // Register auto-detected host LSP binaries first, then let explicit `opts.servers` override!
    for (const candidate of DEFAULT_SYSTEM_LSP_CANDIDATES) {
      if (commandExistsOnPath(candidate.command)) {
        for (const ext of candidate.extensions) {
          this.extToSpec.set(ext.toLowerCase(), candidate);
        }
      }
    }
    for (const custom of opts.servers ?? []) {
      for (const ext of custom.extensions) {
        this.extToSpec.set(ext.toLowerCase(), custom);
      }
    }
  }

  private getConnectionForFile(absPath: string): StdioLspConnection | null {
    if (!this.trustedRepo) return null;
    const ext = path.extname(absPath).toLowerCase();
    const spec = this.extToSpec.get(ext);
    if (!spec) return null;

    const key = `${spec.languageId}:${spec.command}`;
    let conn = this.connections.get(key);
    if (!conn) {
      conn = new StdioLspConnection(spec, this.workspaceRoot, this.requestTimeoutMs);
      this.connections.set(key, conn);
    }
    return conn;
  }

  private validateAndReadWorkspaceFile(filePath: string): { absPath: string; relPath: string; text: string } {
    const absPath = resolveAndValidateWorkspacePath(filePath, this.workspaceRoot, "read", this.guardrails);
    const relPath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, "/");
    const buf = readWorkspaceFileSafe({
      workspaceRoot: this.workspaceRoot,
      candidatePath: relPath,
      unmaskedExceptions: this.guardrails.sandbox.unmasked_exceptions
    });
    return { absPath, relPath, text: buf.toString("utf8") };
  }

  /**
   * OpenCode `read.ts` Pattern:
   * Non-blocking background warm-up (`didOpen`) triggered when `read` accesses a workspace source file.
   */
  touchFileBackground(filePath: string): void {
    try {
      const { absPath, relPath, text } = this.validateAndReadWorkspaceFile(filePath);
      const conn = this.getConnectionForFile(absPath);
      if (!conn) return;
      this.touchedFiles.push(relPath);
      void conn.syncDocument(absPath, text).catch(() => {
        // Background warm-up never throws into caller
      });
    } catch {
      // Ignore non-source or guard-denied files
    }
  }

  /**
   * Synchronizes a newly written/edited file with LSP and formats any error/warning diagnostics
   * for append-only `tool_result` tail injection (`Invariant I-02`).
   */
  async syncModifiedFileAndFormatTailDiagnostics(filePath: string): Promise<{
    diagnostics: LspDiagnosticItem[];
    formattedTailBlock: string;
  }> {
    let fileInfo: { absPath: string; relPath: string; text: string };
    try {
      fileInfo = this.validateAndReadWorkspaceFile(filePath);
    } catch {
      return { diagnostics: [], formattedTailBlock: "" };
    }

    const conn = this.getConnectionForFile(fileInfo.absPath);
    if (!conn) {
      return { diagnostics: [], formattedTailBlock: "" };
    }

    try {
      const diagnostics = await conn.syncAndWaitDiagnostics(
        fileInfo.absPath,
        fileInfo.text,
        this.diagnosticsWaitMs
      );
      const actionable = diagnostics.filter((d) => (d.severity ?? 1) <= 2);
      if (actionable.length === 0) {
        return { diagnostics, formattedTailBlock: "" };
      }

      const lines = actionable.slice(0, 10).map((d) => {
        const sev = (d.severity ?? 1) === 1 ? "ERROR" : "WARN";
        const ln = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        return `  [${sev}] L${ln}:${col}${d.code ? ` (${d.code})` : ""}: ${d.message}`;
      });

      const formattedTailBlock =
        `\n\n<lsp-diagnostics file="${fileInfo.relPath}">\n` +
        `${lines.join("\n")}\n` +
        `</lsp-diagnostics>`;

      return { diagnostics, formattedTailBlock };
    } catch {
      return { diagnostics: [], formattedTailBlock: "" };
    }
  }

  private normalizeLocations(raw: unknown): unknown {
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item) => {
      if (!item || typeof item !== "object") return item;
      const rec = item as {
        uri?: string;
        targetUri?: string;
        range?: { start?: { line: number; character: number } };
        targetSelectionRange?: { start?: { line: number; character: number } };
      };
      const uri = rec.uri ?? rec.targetUri;
      const r = rec.range ?? rec.targetSelectionRange;
      if (uri?.startsWith("file://")) {
        const abs = fileURLToPath(uri);
        const rel = abs.startsWith(this.workspaceRoot)
          ? path.relative(this.workspaceRoot, abs).replace(/\\/g, "/")
          : abs;
        return {
          file: rel,
          line: (r?.start?.line ?? 0) + 1,
          character: (r?.start?.character ?? 0) + 1
        };
      }
      return item;
    });
  }

  /**
   * Executes any of OpenCode's 9 semantic LSP operations + `diagnostics` (`exposure: "deferred"`).
   */
  async executeOperation(params: {
    operation: LspOperationName;
    filePath?: string;
    line?: number; // 1-based line input (converted to 0-based LSP Position)
    character?: number; // 1-based character input (converted to 0-based LSP Position)
    query?: string;
  }): Promise<unknown> {
    if (!this.trustedRepo) {
      return { available: false, reason: "LSP disabled in untrusted workspace (trustedRepo=false)" };
    }
    if (params.operation === "workspaceSymbol") {
      const firstConn =
        Array.from(this.connections.values())[0] ??
        (() => {
          const firstSpec = Array.from(this.extToSpec.values())[0];
          if (!firstSpec) return null;
          const c = new StdioLspConnection(firstSpec, this.workspaceRoot, this.requestTimeoutMs);
          this.connections.set(`${firstSpec.languageId}:${firstSpec.command}`, c);
          return c;
        })();

      if (!firstConn) {
        return { available: false, reason: "No LSP server configured or found on PATH" };
      }
      await firstConn.ensureInitialized();
      const res = await firstConn.sendRequest("workspace/symbol", { query: params.query ?? "" });
      return { available: true, operation: params.operation, result: res };
    }

    if (!params.filePath) {
      throw new Error(`LSP operation '${params.operation}' requires 'filePath'`);
    }

    const { absPath, text } = this.validateAndReadWorkspaceFile(params.filePath);
    const conn = this.getConnectionForFile(absPath);
    if (!conn) {
      return {
        available: false,
        reason: `No LSP server configured for extension '${path.extname(absPath)}'`
      };
    }

    if (params.operation === "diagnostics") {
      const diags = await conn.syncAndWaitDiagnostics(absPath, text, this.diagnosticsWaitMs);
      return { available: true, operation: "diagnostics", diagnostics: diags };
    }

    const uri = await conn.syncDocument(absPath, text);
    const pos = {
      line: Math.max(0, (params.line ?? 1) - 1),
      character: Math.max(0, (params.character ?? 1) - 1)
    };

    switch (params.operation) {
      case "goToDefinition": {
        const raw = await conn.sendRequest("textDocument/definition", {
          textDocument: { uri },
          position: pos
        });
        return { available: true, operation: params.operation, locations: this.normalizeLocations(raw) };
      }
      case "findReferences": {
        const raw = await conn.sendRequest("textDocument/references", {
          textDocument: { uri },
          position: pos,
          context: { includeDeclaration: true }
        });
        return { available: true, operation: params.operation, locations: this.normalizeLocations(raw) };
      }
      case "hover": {
        const raw = await conn.sendRequest("textDocument/hover", {
          textDocument: { uri },
          position: pos
        });
        return { available: true, operation: params.operation, hover: raw };
      }
      case "documentSymbol": {
        const raw = await conn.sendRequest("textDocument/documentSymbol", {
          textDocument: { uri }
        });
        return { available: true, operation: params.operation, symbols: raw };
      }
      case "goToImplementation": {
        const raw = await conn.sendRequest("textDocument/implementation", {
          textDocument: { uri },
          position: pos
        });
        return { available: true, operation: params.operation, locations: this.normalizeLocations(raw) };
      }
      case "prepareCallHierarchy": {
        const raw = await conn.sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri },
          position: pos
        });
        return { available: true, operation: params.operation, items: raw ?? [] };
      }
      case "incomingCalls": {
        const items = (await conn.sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri },
          position: pos
        })) as unknown[] | null;
        if (!items || items.length === 0) {
          return { available: true, operation: params.operation, calls: [] };
        }
        const calls = await conn.sendRequest("callHierarchy/incomingCalls", { item: items[0] });
        return { available: true, operation: params.operation, calls: calls ?? [] };
      }
      case "outgoingCalls": {
        const items = (await conn.sendRequest("textDocument/prepareCallHierarchy", {
          textDocument: { uri },
          position: pos
        })) as unknown[] | null;
        if (!items || items.length === 0) {
          return { available: true, operation: params.operation, calls: [] };
        }
        const calls = await conn.sendRequest("callHierarchy/outgoingCalls", { item: items[0] });
        return { available: true, operation: params.operation, calls: calls ?? [] };
      }
    }
  }

  async shutdownAll(): Promise<void> {
    const all = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.allSettled(all.map((c) => c.shutdown()));
  }
}
