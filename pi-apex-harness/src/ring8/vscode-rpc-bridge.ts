/**
 * Ring 8 — VS Code / Cursor Headless RPC Bridge & Zero-Drift Editor Context Formatter
 * (`src/ring8/vscode-rpc-bridge.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 *  - Adapted directly from `@earendil-works/pi-coding-agent@1.4.0`:
 *      - `dist/modes/rpc/rpc-client.js` (`RpcClient`, NDJSON command/response correlation,
 *        `get_state`, `get_commands`, `prompt`, `steer`, `abort`, `new_session`, MIT)
 *      - `examples/rpc-extension-ui.ts` (`ExtensionUIRequest`, `handleExtensionUI`,
 *        `{ type: "extension_ui_response", id, value | confirmed | cancelled }` stdio dialog
 *        round-trip for `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, MIT).
 *
 * SECURITY & ZERO-PREFIX-DRIFT GUARANTEES:
 *  - `formatEditorSelectionEnvelope()` injects active editor path, 1-indexed line/col range,
 *    selected code, and IDE LSP diagnostics strictly at the user message tail (`<ide_active_editor>`)
 *    without mutating `session.systemPrompt` (`0` static prefix SHA-256 drift!).
 *  - Secret basenames (`.env`, `.pem`, `.key`, `.npmrc`, etc.) in active IDE selections are
 *    refused/redacted via `isSecretBasename()` + `scrubSecretsInfallible()` before crossing stdio!
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { isSecretBasename } from "../core/safe-path.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";

export interface IdeDiagnosticItem {
  severity: "error" | "warning" | "info" | "hint";
  line: number;
  column?: number;
  message: string;
  source?: string;
  code?: string | number;
}

export interface IdeEditorContext {
  filePath: string;
  languageId?: string;
  selection?: {
    startLine: number;
    startColumn?: number;
    endLine: number;
    endColumn?: number;
    selectedText: string;
  };
  diagnostics?: readonly IdeDiagnosticItem[];
}

export interface RpcExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  text?: string;
}

export interface IdeUiHostCallbacks {
  onSelect?: (title: string, options: string[]) => Promise<string | undefined>;
  onConfirm?: (title: string, message?: string) => Promise<boolean>;
  onInput?: (title: string, placeholder?: string) => Promise<string | undefined>;
  onEditor?: (title: string, prefill?: string) => Promise<string | undefined>;
  onNotify?: (message: string, level: "info" | "warning" | "error") => void;
  onStatusChange?: (key: string, statusText: string | undefined) => void;
  onWidgetUpdate?: (key: string, lines: string[]) => void;
  onSetEditorText?: (text: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolEvent?: (phase: "start" | "end", toolName: string, payload?: unknown) => void;
}

/**
 * Formats IDE active editor tab, selection, and LSP diagnostics into an append-only
 * `<ide_active_editor>` block while enforcing Ring 0 secret-file redaction.
 */
export function formatEditorSelectionEnvelope(opts: {
  workspaceRoot: string;
  editor?: IdeEditorContext;
  userPrompt: string;
}): { formattedMessage: string; redactedSecretFile: boolean } {
  const cleanPrompt = scrubSecretsInfallible(opts.userPrompt.trim());
  if (!opts.editor) {
    return { formattedMessage: cleanPrompt, redactedSecretFile: false };
  }

  const wsResolved = path.resolve(opts.workspaceRoot);
  const absFile = path.resolve(wsResolved, opts.editor.filePath);
  const relPath = path.relative(wsResolved, absFile).replace(/\\/g, "/");
  const basename = path.basename(absFile);

  if (
    relPath.startsWith("..") ||
    relPath === ".git" ||
    relPath.startsWith(".git/") ||
    isSecretBasename(basename)
  ) {
    const safeNotice = [
      `<ide_active_editor file="${basename}" redacted="true">`,
      `[GUARD: Active editor file '${basename}' is a protected secret or outside-workspace path; selection content was withheld from model context.]`,
      `</ide_active_editor>`,
      "",
      cleanPrompt
    ].join("\n");
    return { formattedMessage: safeNotice, redactedSecretFile: true };
  }

  const sel = opts.editor.selection;
  const rangeAttr = sel ? ` lines="L${sel.startLine}-L${sel.endLine}"` : "";
  const langAttr = opts.editor.languageId ? ` language="${opts.editor.languageId}"` : "";

  const lines: string[] = [
    `<ide_active_editor file="${relPath}"${langAttr}${rangeAttr}>`
  ];

  if (sel && sel.selectedText.trim().length > 0) {
    lines.push(
      `Selected code (${relPath}:L${sel.startLine}-L${sel.endLine}):`,
      `\`\`\`${opts.editor.languageId ?? ""}`,
      scrubSecretsInfallible(sel.selectedText.slice(0, 12_000)),
      `\`\`\``
    );
  }

  const diags = opts.editor.diagnostics ?? [];
  if (diags.length > 0) {
    lines.push("Active IDE LSP Diagnostics:");
    for (const d of diags.slice(0, 20)) {
      const src = d.source ? `[${d.source}${d.code !== undefined ? `:${d.code}` : ""}] ` : "";
      lines.push(
        `- [${d.severity.toUpperCase()}] ${relPath}:${d.line}${d.column ? `:${d.column}` : ""} — ${src}${scrubSecretsInfallible(d.message)}`
      );
    }
  }

  lines.push(`</ide_active_editor>`, "", cleanPrompt);
  return {
    formattedMessage: lines.join("\n"),
    redactedSecretFile: false
  };
}

export interface IdeRpcBridgeOptions {
  workspaceRoot: string;
  cliScriptPath?: string;
  nodeExecutable?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  uiCallbacks?: IdeUiHostCallbacks;
  requestTimeoutMs?: number;
}

export class IdeRpcBridge {
  private readonly workspaceRoot: string;
  private readonly cliScriptPath: string;
  private readonly nodeExecutable: string;
  private readonly extraArgs: string[];
  private readonly customEnv?: NodeJS.ProcessEnv;
  private readonly uiCallbacks: IdeUiHostCallbacks;
  private readonly requestTimeoutMs: number;

  private proc: ChildProcess | null = null;
  private reqSeq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly settleWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly rawEventListeners: Array<(evt: Record<string, unknown>) => void> = [];
  private stderrBuf = "";
  private lastAssistantDeltaAcc = "";

  constructor(opts: IdeRpcBridgeOptions) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.cliScriptPath =
      opts.cliScriptPath ?? path.resolve(this.workspaceRoot, "bin", "pi-apex");
    this.nodeExecutable = opts.nodeExecutable ?? process.execPath;
    this.extraArgs = opts.extraArgs ?? [];
    this.customEnv = opts.env;
    this.uiCallbacks = opts.uiCallbacks ?? {};
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
  }

  public isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  public getStderr(): string {
    return this.stderrBuf;
  }

  public onEvent(listener: (evt: Record<string, unknown>) => void): () => void {
    this.rawEventListeners.push(listener);
    return () => {
      const idx = this.rawEventListeners.indexOf(listener);
      if (idx >= 0) this.rawEventListeners.splice(idx, 1);
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning()) return;

    const spawnArgs = [
      "--experimental-strip-types",
      this.cliScriptPath,
      "--cwd",
      this.workspaceRoot,
      "--mode",
      "rpc",
      ...this.extraArgs
    ];

    const child = spawn(this.nodeExecutable, spawnArgs, {
      cwd: this.workspaceRoot,
      env: { ...process.env, ...this.customEnv },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBuf += chunk.toString("utf8");
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        void this.handleStdoutLine(line);
      });
    }

    child.once("exit", (code, sig) => {
      const err = new Error(
        `IDE_RPC_PROCESS_EXITED (code=${code ?? "null"}, signal=${sig ?? "null"}): ${this.stderrBuf.slice(-400)}`
      );
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      while (this.settleWaiters.length > 0) {
        this.settleWaiters.shift()?.reject(err);
      }
      if (this.proc === child) {
        this.proc = null;
      }
    });

    // Verify readiness by round-tripping `get_state`
    await this.sendCommand("get_state");
  }

  public async stop(): Promise<void> {
    if (!this.proc) return;
    const child = this.proc;
    this.proc = null;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 1_200);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  public sendRawJsonLine(payload: Record<string, unknown>): void {
    if (!this.proc?.stdin || !this.isRunning()) {
      throw new Error("IDE_RPC_NOT_STARTED: Call start() before sending RPC messages.");
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  public async handleExtensionUiRequest(req: RpcExtensionUiRequest): Promise<void> {
    const { id, method } = req;
    switch (method) {
      case "select": {
        const picked = this.uiCallbacks.onSelect
          ? await this.uiCallbacks.onSelect(req.title ?? "Select", req.options ?? [])
          : req.options?.[0];
        if (picked !== undefined) {
          this.sendRawJsonLine({ type: "extension_ui_response", id, value: picked });
        } else {
          this.sendRawJsonLine({ type: "extension_ui_response", id, cancelled: true });
        }
        break;
      }
      case "confirm": {
        const confirmed = this.uiCallbacks.onConfirm
          ? await this.uiCallbacks.onConfirm(req.title ?? "Confirm", req.message)
          : false;
        this.sendRawJsonLine({ type: "extension_ui_response", id, confirmed });
        break;
      }
      case "input": {
        const val = this.uiCallbacks.onInput
          ? await this.uiCallbacks.onInput(req.title ?? "Input", req.placeholder)
          : undefined;
        if (val !== undefined) {
          this.sendRawJsonLine({ type: "extension_ui_response", id, value: val });
        } else {
          this.sendRawJsonLine({ type: "extension_ui_response", id, cancelled: true });
        }
        break;
      }
      case "editor": {
        const edited = this.uiCallbacks.onEditor
          ? await this.uiCallbacks.onEditor(req.title ?? "Editor", req.prefill)
          : req.prefill;
        if (edited !== undefined) {
          this.sendRawJsonLine({ type: "extension_ui_response", id, value: edited });
        } else {
          this.sendRawJsonLine({ type: "extension_ui_response", id, cancelled: true });
        }
        break;
      }
      case "notify": {
        this.uiCallbacks.onNotify?.(req.message ?? "", req.notifyType ?? "info");
        break;
      }
      case "setStatus": {
        if (req.statusKey) {
          this.uiCallbacks.onStatusChange?.(req.statusKey, req.statusText);
        }
        break;
      }
      case "setWidget": {
        if (req.widgetKey) {
          this.uiCallbacks.onWidgetUpdate?.(req.widgetKey, req.widgetLines ?? []);
        }
        break;
      }
      case "set_editor_text": {
        this.uiCallbacks.onSetEditorText?.(req.text ?? "");
        break;
      }
      default:
        break;
    }
  }

  private async handleStdoutLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    for (const listener of this.rawEventListeners) {
      listener(parsed);
    }

    if (parsed["type"] === "response" && typeof parsed["id"] === "string") {
      const waiter = this.pending.get(parsed["id"]);
      if (waiter) {
        this.pending.delete(parsed["id"]);
        if (parsed["success"] === false) {
          waiter.reject(new Error(String(parsed["error"] ?? "RPC command failed")));
        } else {
          waiter.resolve(parsed["data"]);
        }
      }
      return;
    }

    if (parsed["type"] === "extension_ui_request") {
      await this.handleExtensionUiRequest(parsed as unknown as RpcExtensionUiRequest);
      return;
    }

    if (parsed["type"] === "message_update") {
      const evt = parsed["assistantMessageEvent"] as Record<string, unknown> | undefined;
      if (evt?.["type"] === "text_delta" && typeof evt["delta"] === "string") {
        this.lastAssistantDeltaAcc += evt["delta"];
        this.uiCallbacks.onTextDelta?.(evt["delta"]);
      }
      return;
    }

    if (parsed["type"] === "tool_execution_start") {
      this.uiCallbacks.onToolEvent?.("start", String(parsed["toolName"] ?? ""), parsed["args"]);
      return;
    }

    if (parsed["type"] === "tool_execution_end") {
      this.uiCallbacks.onToolEvent?.("end", String(parsed["toolName"] ?? ""), parsed["result"]);
      return;
    }

    if (parsed["type"] === "agent_end" || parsed["type"] === "agent_settled") {
      while (this.settleWaiters.length > 0) {
        this.settleWaiters.shift()?.resolve();
      }
    }
  }

  public async sendCommand<T = unknown>(
    type: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    await this.start();
    const id = `ide_req_${++this.reqSeq}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IDE_RPC_TIMEOUT (${type}): exceeded ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      this.sendRawJsonLine({ id, type, ...params });
    });
  }

  public async getWorkspaceState(): Promise<Record<string, unknown>> {
    return await this.sendCommand<Record<string, unknown>>("get_state");
  }

  public async listSlashCommands(): Promise<Array<{ name: string; description?: string }>> {
    const data = await this.sendCommand<{ commands: Array<{ name: string; description?: string }> }>(
      "get_commands"
    );
    return data?.commands ?? [];
  }

  public async promptAndWait(message: string): Promise<string> {
    await this.start();
    this.lastAssistantDeltaAcc = "";
    const isSlash = message.trim().startsWith("/");

    if (isSlash) {
      await this.sendCommand("prompt", { message });
      // Slash commands settle synchronously inside prompt handler; fetch last text/entries
      const last = await this.sendCommand<{ text?: string }>("get_last_assistant_text").catch(
        () => ({ text: "" })
      );
      return last?.text || this.lastAssistantDeltaAcc;
    }

    const settlePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve();
      }, this.requestTimeoutMs);
      this.settleWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    await this.sendCommand("prompt", { message });
    await settlePromise;
    if (this.lastAssistantDeltaAcc) {
      return this.lastAssistantDeltaAcc;
    }
    const last = await this.sendCommand<{ text?: string }>("get_last_assistant_text").catch(() => ({
      text: ""
    }));
    return last?.text ?? "";
  }

  public async askWithEditorContext(opts: {
    userPrompt: string;
    editor?: IdeEditorContext;
  }): Promise<{ assistantText: string; redactedSecretFile: boolean; formattedMessage: string }> {
    const env = formatEditorSelectionEnvelope({
      workspaceRoot: this.workspaceRoot,
      editor: opts.editor,
      userPrompt: opts.userPrompt
    });
    const assistantText = await this.promptAndWait(env.formattedMessage);
    return {
      assistantText,
      redactedSecretFile: env.redactedSecretFile,
      formattedMessage: env.formattedMessage
    };
  }

  public async togglePlanMode(mode: "on" | "off" | "status" = "on"): Promise<void> {
    await this.sendCommand("prompt", { message: `/plan ${mode}` });
  }

  public async runBugBotReview(target: "uncommitted" | string = "uncommitted"): Promise<void> {
    await this.sendCommand("prompt", { message: `/review ${target}` });
  }

  public async handoffFromSelection(goal: string, editor?: IdeEditorContext): Promise<void> {
    const locSuffix = editor?.selection
      ? ` (focused on ${editor.filePath}:L${editor.selection.startLine}-L${editor.selection.endLine})`
      : editor
        ? ` (focused on ${editor.filePath})`
        : "";
    await this.sendCommand("prompt", { message: `/handoff ${goal}${locSuffix}` });
  }

  public async runAutonomousPr(argsText: string): Promise<void> {
    await this.sendCommand("prompt", { message: `/pr ${argsText}` });
  }
}
