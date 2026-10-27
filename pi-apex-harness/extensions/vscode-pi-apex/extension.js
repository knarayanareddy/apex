"use strict";

/**
 * VS Code & Cursor Extension Host Entrypoint (`extensions/vscode-pi-apex/extension.js`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - Speaks the exact `@earendil-works/pi-coding-agent@1.4.0` NDJSON `--mode rpc` stdio protocol
 *    (`dist/modes/rpc/rpc-client.js` & `examples/rpc-extension-ui.ts`, MIT).
 *  - Enforces secret-file basename redaction (`.env`, `.pem`, `.key`, `.npmrc`) before forwarding
 *    active editor selections or IDE LSP diagnostics to `pi-apex --mode rpc`.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const SECRET_BASENAME_RE =
  /^\.env(\..+)?$|\.(pem|key|p12|pfx|keystore|kdbx)$|^(id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc|credentials\.json)$/i;

function isProtectedSecretFile(filePath) {
  const base = path.basename(filePath);
  if (/^\.env\.(example|sample|template)$/i.test(base)) return false;
  return SECRET_BASENAME_RE.test(base);
}

class VsCodeRpcSession {
  constructor(vscode, workspaceRoot, outputChannel, statusBarItem) {
    this.vscode = vscode;
    this.workspaceRoot = workspaceRoot;
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
    this.proc = null;
    this.reqSeq = 0;
    this.pending = new Map();
  }

  ensureStarted() {
    if (this.proc && this.proc.exitCode === null) return;
    const cfg = this.vscode.workspace.getConfiguration("piApex");
    const bin = cfg.get("binaryPath", "pi-apex");
    const model = cfg.get("defaultModel", "apex/auto");

    const args = ["--cwd", this.workspaceRoot, "--mode", "rpc"];
    if (model) {
      args.push("--model", model);
    }

    this.proc = spawn(bin, args, {
      cwd: this.workspaceRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.proc.stderr.on("data", (chunk) => {
      this.outputChannel.append(chunk.toString("utf8"));
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      void this.handleRpcLine(line);
    });

    this.proc.once("exit", (code) => {
      this.outputChannel.appendLine(`[pi-apex rpc exited: code=${code}]`);
      this.statusBarItem.text = "$(shield) Pi-Apex: Stopped";
      this.proc = null;
    });

    this.statusBarItem.text = `$(shield) Pi-Apex (${model})`;
  }

  sendJson(payload) {
    this.ensureStarted();
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  sendCommand(type, params = {}) {
    this.ensureStarted();
    const id = `vscode_${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendJson({ id, type, ...params });
    });
  }

  async handleRpcLine(line) {
    if (!line || !line.startsWith("{")) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "response" && msg.id && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.success === false) {
        waiter.reject(new Error(msg.error || "RPC error"));
      } else {
        waiter.resolve(msg.data);
      }
      return;
    }

    if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
      this.outputChannel.append(msg.assistantMessageEvent.delta);
      return;
    }

    if (msg.type === "agent_end" || msg.type === "agent_settled") {
      this.outputChannel.appendLine("\n---");
      return;
    }

    if (msg.type === "extension_ui_request") {
      await this.handleExtensionUi(msg);
    }
  }

  async handleExtensionUi(req) {
    const { id, method } = req;
    if (method === "select") {
      const picked = await this.vscode.window.showQuickPick(req.options || [], {
        placeHolder: req.title || "Pi-Apex Select"
      });
      if (picked !== undefined) {
        this.sendJson({ type: "extension_ui_response", id, value: picked });
      } else {
        this.sendJson({ type: "extension_ui_response", id, cancelled: true });
      }
    } else if (method === "confirm") {
      const ans = await this.vscode.window.showWarningMessage(
        `${req.title || "Confirm"}${req.message ? ": " + req.message : ""}`,
        { modal: true },
        "Yes",
        "No"
      );
      this.sendJson({ type: "extension_ui_response", id, confirmed: ans === "Yes" });
    } else if (method === "input" || method === "editor") {
      const val = await this.vscode.window.showInputBox({
        prompt: req.title || "Pi-Apex Input",
        placeHolder: req.placeholder || "",
        value: req.prefill || ""
      });
      if (val !== undefined) {
        this.sendJson({ type: "extension_ui_response", id, value: val });
      } else {
        this.sendJson({ type: "extension_ui_response", id, cancelled: true });
      }
    } else if (method === "notify") {
      const text = req.message || "";
      if (req.notifyType === "error") this.vscode.window.showErrorMessage(text);
      else if (req.notifyType === "warning") this.vscode.window.showWarningMessage(text);
      else this.vscode.window.showInformationMessage(text);
    } else if (method === "setStatus" && req.statusText) {
      this.statusBarItem.text = `$(shield) Pi-Apex: ${req.statusText}`;
    }
  }

  collectActiveEditorEnvelope(userPrompt) {
    const editor = this.vscode.window.activeTextEditor;
    if (!editor) return userPrompt;

    const absPath = editor.document.uri.fsPath;
    const relPath = path.relative(this.workspaceRoot, absPath).replace(/\\/g, "/");
    if (relPath.startsWith("..") || isProtectedSecretFile(absPath)) {
      return `<ide_active_editor file="${path.basename(absPath)}" redacted="true">\n[Protected secret file withheld]\n</ide_active_editor>\n\n${userPrompt}`;
    }

    const sel = editor.selection;
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const selectedText = editor.document.getText(sel);
    const diags = this.vscode.languages.getDiagnostics(editor.document.uri) || [];

    const lines = [
      `<ide_active_editor file="${relPath}" language="${editor.document.languageId}" lines="L${startLine}-L${endLine}">`
    ];
    if (selectedText.trim()) {
      lines.push(
        `Selected code (${relPath}:L${startLine}-L${endLine}):`,
        "```" + editor.document.languageId,
        selectedText.slice(0, 12000),
        "```"
      );
    }
    if (diags.length > 0) {
      lines.push("Active IDE LSP Diagnostics:");
      for (const d of diags.slice(0, 20)) {
        const sev = d.severity === 0 ? "ERROR" : d.severity === 1 ? "WARNING" : "INFO";
        lines.push(`- [${sev}] ${relPath}:${d.range.start.line + 1} — ${d.message}`);
      }
    }
    lines.push("</ide_active_editor>", "", userPrompt);
    return lines.join("\n");
  }

  dispose() {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}

let activeRpc = null;
let planEnabled = false;

function activate(context) {
  const vscode = require("vscode");
  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = folder ? folder.uri.fsPath : process.cwd();
  const outputChannel = vscode.window.createOutputChannel("Pi-Apex Agent");
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = "$(shield) Pi-Apex Ready";
  statusBarItem.command = "piApex.openCockpit";
  statusBarItem.show();

  activeRpc = new VsCodeRpcSession(vscode, workspaceRoot, outputChannel, statusBarItem);

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    vscode.commands.registerCommand("piApex.askSelection", async () => {
      const prompt = await vscode.window.showInputBox({
        prompt: "Ask Pi-Apex (active file selection & LSP diagnostics attached automatically)"
      });
      if (!prompt) return;
      outputChannel.show(true);
      outputChannel.appendLine(`\n> ${prompt}`);
      const fullMsg = activeRpc.collectActiveEditorEnvelope(prompt);
      await activeRpc.sendCommand("prompt", { message: fullMsg });
    }),
    vscode.commands.registerCommand("piApex.togglePlan", async () => {
      planEnabled = !planEnabled;
      const mode = planEnabled ? "on" : "off";
      outputChannel.show(true);
      await activeRpc.sendCommand("prompt", { message: `/plan ${mode}` });
      statusBarItem.text = `$(shield) Pi-Apex: Plan ${mode.toUpperCase()}`;
    }),
    vscode.commands.registerCommand("piApex.reviewDiff", async () => {
      outputChannel.show(true);
      await activeRpc.sendCommand("prompt", { message: "/review uncommitted" });
    }),
    vscode.commands.registerCommand("piApex.handoff", async () => {
      const goal = await vscode.window.showInputBox({
        prompt: "Goal for fresh parentSession-linked handoff thread"
      });
      if (!goal) return;
      outputChannel.show(true);
      await activeRpc.sendCommand("prompt", { message: `/handoff ${goal}` });
    }),
    vscode.commands.registerCommand("piApex.autonomousPr", async () => {
      const spec = await vscode.window.showInputBox({
        prompt: "GitHub Issue URL (#num) or PR title for Live-LLM Self-Healing /pr --auto",
        placeHolder: "https://github.com/owner/repo/issues/42  OR  Fix token refresh race"
      });
      if (!spec) return;
      outputChannel.show(true);
      await activeRpc.sendCommand("prompt", { message: `/pr --auto ${spec}` });
    }),
    vscode.commands.registerCommand("piApex.openCockpit", () => {
      const cfg = vscode.workspace.getConfiguration("piApex");
      const url = cfg.get("cockpitUrl", "http://127.0.0.1:4310");
      const panel = vscode.window.createWebviewPanel(
        "piApexCockpit",
        "Pi-Apex Mission Control",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0b0f17;height:100vh;overflow:hidden;">
  <iframe src="${url}" style="border:0;width:100%;height:100vh;"></iframe>
</body></html>`;
    })
  );
}

function deactivate() {
  if (activeRpc) {
    activeRpc.dispose();
    activeRpc = null;
  }
}

module.exports = { activate, deactivate, isProtectedSecretFile };
