/**
 * Ring 7 — Native Node 22 WebSocket Headless Chromium CDP Driver (`src/ring7/chromium-cdp-driver.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 *  - `vercel-labs/agent-browser` @ `372ac5ce20fa` (`cli/src/native/snapshot.rs` & `eve/lib/browser.ts`,
 *    Apache-2.0 License, Vercel Labs):
 *    - Maps Chrome DevTools Protocol `Accessibility.getFullAXTree` nodes directly into `RawAXNode[]`
 *      for `buildAriaTree` / `formatAriaSnapshotFromNodes` (`@e1`–`@eN` deterministic refs).
 *    - Enforces `vercel-labs/agent-browser` Issue #1443 stale-ref protection (`STALE_SNAPSHOT_REF`)
 *      against *real live V8 JavaScript DOM mutations* via a `Page.addScriptToEvaluateOnNewDocument`
 *      `MutationObserver` (`window.__apexDomRevision`).
 *    - Captures genuine Chromium-rendered PNG `ImageContent` (`Page.captureScreenshot`).
 *
 * SECURITY & CONFINEMENT GUARANTEES:
 *  1. Spawns Chromium with `inheritEnv: false` and a minimal sanitized env (`PATH`, `HOME`, `TMPDIR`, `LANG`)
 *     so host `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AWS_SECRET_ACCESS_KEY` never enter the browser process.
 *  2. Blocks SSRF against link-local cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`)
 *     and blocks `file://` URLs escaping `<workspaceRoot>` or targeting secret basenames (`.env`, `.pem`, `.key`).
 *  3. Guaranteed `close()` teardown kills the Chromium child process and deletes its ephemeral `--user-data-dir`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { isSecretBasename } from "../core/safe-path.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import {
  type BrowserSnapshotResult,
  formatAriaSnapshotFromNodes,
  type RawAXNode,
  type RefTargetMetadata,
  type SnapshotOptions
} from "../ring2/agent-browser-ref.ts";

const CANDIDATE_CHROMIUM_BINS = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
] as const;

export function findLocalChromiumBinary(): string | null {
  const override = process.env["PI_APEX_CHROMIUM_BIN"]?.trim();
  if (override && fs.existsSync(override)) {
    return override;
  }
  for (const candidate of CANDIDATE_CHROMIUM_BINS) {
    if (candidate.startsWith("/") && fs.existsSync(candidate)) {
      return candidate;
    }
    const probe = spawnSync("which", [candidate], { encoding: "utf8" });
    if ((probe.status ?? 1) === 0) {
      const resolved = (probe.stdout ?? "").trim();
      if (resolved) return resolved;
    }
  }
  return null;
}

const BLOCKED_SSRF_HOSTS = new Set([
  "169.254.169.254",
  "[fd00:ec2::254]",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200"
]);

export function validateBrowserNavigationUrl(rawUrl: string, workspaceRoot?: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "about:blank" || trimmed.startsWith("data:text/html,")) {
    return trimmed;
  }
  if (trimmed.startsWith("file://")) {
    if (!workspaceRoot) {
      throw new Error(`UNSAFE_BROWSER_FILE_URL: file:// URLs require a confined workspaceRoot.`);
    }
    const parsed = new URL(trimmed);
    const filePath = decodeURIComponent(parsed.pathname);
    const resolvedWs = fs.realpathSync(workspaceRoot);
    const resolvedTarget = fs.existsSync(filePath)
      ? fs.realpathSync(filePath)
      : path.resolve(filePath);
    if (
      resolvedTarget !== resolvedWs &&
      !resolvedTarget.startsWith(`${resolvedWs}${path.sep}`)
    ) {
      throw new Error(
        `UNSAFE_BROWSER_FILE_URL: '${trimmed}' escapes workspaceRoot '${resolvedWs}'.`
      );
    }
    if (isSecretBasename(path.basename(resolvedTarget))) {
      throw new Error(
        `UNSAFE_BROWSER_FILE_URL: '${trimmed}' targets a protected secret file.`
      );
    }
    return trimmed;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    const hostLower = parsed.hostname.toLowerCase();
    if (BLOCKED_SSRF_HOSTS.has(hostLower)) {
      throw new Error(
        `SSRF_METADATA_URL_BLOCKED: navigation to cloud metadata host '${hostLower}' is forbidden.`
      );
    }
    return trimmed;
  }
  throw new Error(`UNSUPPORTED_BROWSER_URL: '${trimmed}'`);
}

interface CdpProperty {
  name?: string;
  value?: { type?: string; value?: unknown };
}

interface CdpAxNode {
  nodeId?: string | number;
  ignored?: boolean;
  role?: { type?: string; value?: unknown };
  name?: { type?: string; value?: unknown };
  value?: { type?: string; value?: unknown };
  properties?: CdpProperty[];
  backendDOMNodeId?: number;
  childIds?: Array<string | number>;
}

/**
 * Converts Chrome DevTools Protocol `Accessibility.getFullAXTree` nodes into
 * `vercel-labs/agent-browser` `RawAXNode[]`.
 */
export function convertCdpAxNodesToRaw(cdpNodes: readonly CdpAxNode[]): RawAXNode[] {
  const byId = new Map<string, CdpAxNode>();
  for (const n of cdpNodes) {
    byId.set(String(n.nodeId ?? ""), n);
  }

  // Hoist non-ignored descendants through Chromium's `ignored: true` (`uninteresting`)
  // structural containers (`<html>`, `<body>`, layout wrappers) while keeping `aria-hidden`
  // subtrees (where descendants are also `ignored: true`) excluded!
  const hoistVisibleChildren = (rawChildIds: ReadonlyArray<string | number> | undefined, visited = new Set<string>()): string[] => {
    if (!rawChildIds || rawChildIds.length === 0) return [];
    const out: string[] = [];
    for (const rawCid of rawChildIds) {
      const cid = String(rawCid);
      if (visited.has(cid)) continue;
      visited.add(cid);
      const child = byId.get(cid);
      if (!child) continue;
      const roleVal = typeof child.role?.value === "string" ? child.role.value : "generic";
      if (child.ignored && roleVal !== "RootWebArea") {
        out.push(...hoistVisibleChildren(child.childIds, visited));
      } else {
        out.push(cid);
      }
    }
    return out;
  };

  return cdpNodes.map((n) => {
    let level: number | undefined;
    let checked: string | undefined;
    let expanded: boolean | undefined;
    let selected: boolean | undefined;
    let disabled: boolean | undefined;
    let required: boolean | undefined;
    let url: string | undefined;

    if (Array.isArray(n.properties)) {
      for (const prop of n.properties) {
        const pName = prop.name;
        const pVal = prop.value?.value;
        if (pName === "level" && typeof pVal === "number") level = pVal;
        else if (pName === "checked" && pVal !== undefined) checked = String(pVal);
        else if (pName === "expanded" && typeof pVal === "boolean") expanded = pVal;
        else if (pName === "selected" && typeof pVal === "boolean") selected = pVal;
        else if (pName === "disabled" && typeof pVal === "boolean") disabled = pVal;
        else if (pName === "required" && typeof pVal === "boolean") required = pVal;
        else if (pName === "url" && typeof pVal === "string") url = pVal;
      }
    }

    const role = typeof n.role?.value === "string" ? n.role.value : "generic";
    const isIgnored = Boolean(n.ignored) && role !== "RootWebArea";

    return {
      nodeId: String(n.nodeId ?? ""),
      role,
      name: typeof n.name?.value === "string" ? n.name.value : undefined,
      value:
        n.value?.value !== undefined && n.value?.value !== null
          ? String(n.value.value)
          : undefined,
      level,
      checked,
      expanded,
      selected,
      disabled,
      required,
      url,
      ignored: isIgnored,
      backendDOMNodeId:
        typeof n.backendDOMNodeId === "number" ? n.backendDOMNodeId : undefined,
      childIds: isIgnored ? [] : hoistVisibleChildren(n.childIds)
    };
  });
}

const MUTATION_OBSERVER_BOOTSTRAP_SCRIPT = `
(() => {
  if (typeof window === "undefined") return;
  if (typeof window.__apexDomRevision !== "number") {
    window.__apexDomRevision = 1;
  }
  const attach = () => {
    if (window.__apexObserverAttached) return;
    const root = document.documentElement || document;
    if (!root) return;
    window.__apexObserverAttached = true;
    const obs = new MutationObserver((records) => {
      if (records && records.length > 0) {
        window.__apexDomRevision = (window.__apexDomRevision || 1) + 1;
      }
    });
    obs.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  }
  attach();
})();
`;

export interface ChromiumCdpSessionOptions {
  workspaceRoot?: string;
  chromiumPath?: string;
  connectTimeoutMs?: number;
}

export class ChromiumCdpSession {
  private readonly workspaceRoot?: string;
  private readonly chromiumPath: string;
  private readonly connectTimeoutMs: number;
  private proc: ChildProcess | null = null;
  private userDataDir: string | null = null;
  private ws: WebSocket | null = null;
  private cmdSeq = 0;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  private currentUrl = "about:blank";
  private snapshotSeq = 0;
  private activeSnapshotId: string | null = null;
  private activeSnapshotDomRevision = -1;
  private activeRefs: Record<string, RefTargetMetadata> = {};
  private closed = false;

  constructor(opts: ChromiumCdpSessionOptions = {}) {
    const resolvedBin = opts.chromiumPath ?? findLocalChromiumBinary();
    if (!resolvedBin) {
      throw new Error(
        "CHROMIUM_NOT_FOUND: No local chromium/google-chrome binary found on PATH."
      );
    }
    this.chromiumPath = resolvedBin;
    this.workspaceRoot = opts.workspaceRoot;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 12_000;
  }

  public get pid(): number | undefined {
    return this.proc?.pid;
  }

  public isOpen(): boolean {
    return !this.closed && this.ws !== null && this.proc !== null;
  }

  public async ensureStarted(): Promise<void> {
    if (this.isOpen()) return;
    this.closed = false;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-cdp-"));
    this.userDataDir = userDataDir;

    // Clean-env spawn (`inheritEnv: false` equivalent): zero host API keys passed to Chromium!
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: userDataDir,
      TMPDIR: os.tmpdir(),
      LANG: process.env["LANG"] ?? "C.UTF-8"
    };

    const proc = spawn(
      this.chromiumPath,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--remote-allow-origins=*",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--window-size=1280,800",
        `--user-data-dir=${userDataDir}`,
        "--remote-debugging-port=0",
        "about:blank"
      ],
      {
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    this.proc = proc;

    try {
      const browserWsUrl = await new Promise<string>((resolve, reject) => {
        let stderrBuf = "";
        const timer = setTimeout(() => {
          reject(
            new Error(
              `CHROMIUM_CDP_TIMEOUT: DevTools endpoint did not start within ${this.connectTimeoutMs}ms. stderr=${stderrBuf.slice(0, 400)}`
            )
          );
        }, this.connectTimeoutMs);

        proc.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.once("exit", (code, sig) => {
          clearTimeout(timer);
          reject(
            new Error(
              `CHROMIUM_EXITED_EARLY: code=${String(code)} sig=${String(sig)} stderr=${stderrBuf.slice(0, 400)}`
            )
          );
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString("utf8");
          const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
      });

      const hostPort = new URL(browserWsUrl).host;
      let pageWsUrl: string | undefined;
      for (let attempt = 0; attempt < 15; attempt++) {
        const resp = await fetch(`http://${hostPort}/json/list`);
        const targets = (await resp.json()) as Array<{
          type?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string"
        );
        if (page?.webSocketDebuggerUrl) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      if (!pageWsUrl) {
        throw new Error("CHROMIUM_CDP_NO_PAGE_TARGET: Could not find a page target in /json/list.");
      }

      const ws = new WebSocket(pageWsUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("CHROMIUM_CDP_WS_TIMEOUT")),
          this.connectTimeoutMs
        );
        ws.onopen = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("CHROMIUM_CDP_WS_ERROR"));
        };
      });

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            id?: number;
            result?: Record<string, unknown>;
            error?: { message?: string };
          };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const waiter = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) {
              waiter.reject(new Error(`CDP_ERROR: ${msg.error.message ?? "unknown"}`));
            } else {
              waiter.resolve(msg.result ?? {});
            }
          }
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        for (const [id, waiter] of this.pending) {
          waiter.reject(new Error(`CDP_WS_CLOSED (method=${waiter.method} id=${id})`));
        }
        this.pending.clear();
      };

      this.ws = ws;
      await this.sendCdp("Page.enable");
      await this.sendCdp("DOM.enable");
      await this.sendCdp("Runtime.enable");
      await this.sendCdp("Accessibility.enable");
      await this.sendCdp("Page.addScriptToEvaluateOnNewDocument", {
        source: MUTATION_OBSERVER_BOOTSTRAP_SCRIPT
      });
      await this.sendCdp("Runtime.evaluate", {
        expression: MUTATION_OBSERVER_BOOTSTRAP_SCRIPT,
        returnByValue: true
      });
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  public async sendCdp(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CHROMIUM_CDP_NOT_CONNECTED");
    }
    const id = ++this.cmdSeq;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP_COMMAND_TIMEOUT: ${method}`));
      }, this.connectTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  public async getLiveDomRevision(): Promise<number> {
    const evalRes = await this.sendCdp("Runtime.evaluate", {
      expression: `(() => {
        ${MUTATION_OBSERVER_BOOTSTRAP_SCRIPT}
        return Number(window.__apexDomRevision || 1);
      })()`,
      returnByValue: true
    });
    const resultObj = evalRes["result"] as { value?: unknown } | undefined;
    return typeof resultObj?.value === "number" ? resultObj.value : 1;
  }

  private async getLiveLocationHref(): Promise<string> {
    const evalRes = await this.sendCdp("Runtime.evaluate", {
      expression: "String(window.location.href || 'about:blank')",
      returnByValue: true
    });
    const resultObj = evalRes["result"] as { value?: unknown } | undefined;
    return typeof resultObj?.value === "string" ? resultObj.value : this.currentUrl;
  }

  public async navigate(url: string): Promise<{ url: string; domRevision: number }> {
    const safeUrl = validateBrowserNavigationUrl(url, this.workspaceRoot);
    await this.ensureStarted();
    await this.sendCdp("Page.navigate", { url: safeUrl });

    // Wait until document.readyState === 'complete' (bounded)
    for (let i = 0; i < 40; i++) {
      const stateRes = await this.sendCdp("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true
      }).catch((): Record<string, unknown> => ({}));
      const val = (stateRes["result"] as { value?: unknown } | undefined)?.value;
      if (val === "complete") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 30));

    this.currentUrl = await this.getLiveLocationHref();
    const domRevision = await this.getLiveDomRevision();
    // Invalidate prior snapshot refs across navigation!
    this.activeSnapshotId = null;
    this.activeSnapshotDomRevision = -1;
    this.activeRefs = {};

    return { url: this.currentUrl, domRevision };
  }

  public async snapshot(options: SnapshotOptions = {}): Promise<BrowserSnapshotResult> {
    await this.ensureStarted();
    const cleanOptions: SnapshotOptions = {
      ...options,
      compact: options.compact ?? true,
      selector:
        options.selector && !options.selector.startsWith("@") ? options.selector : undefined
    };

    const domRevision = await this.getLiveDomRevision();
    this.currentUrl = await this.getLiveLocationHref();
    const axResp = await this.sendCdp("Accessibility.getFullAXTree");
    const rawCdpNodes = Array.isArray(axResp["nodes"])
      ? (axResp["nodes"] as CdpAxNode[])
      : [];
    const axNodes = convertCdpAxNodesToRaw(rawCdpNodes);
    const { snapshot, refs } = formatAriaSnapshotFromNodes(axNodes, cleanOptions);

    const snapshotId = `cdp_snap_${++this.snapshotSeq}`;
    this.activeSnapshotId = snapshotId;
    this.activeSnapshotDomRevision = domRevision;
    this.activeRefs = refs;

    return {
      snapshotId,
      domRevision,
      url: this.currentUrl,
      snapshot: scrubSecretsInfallible(snapshot),
      refs
    };
  }

  private async resolveValidatedBackendNode(
    refOrSelector: string,
    expectedSnapshotId?: string
  ): Promise<{ meta: RefTargetMetadata; objectId: string }> {
    const cleanRef = refOrSelector.replace(/^@+/, "");
    if (!this.activeSnapshotId) {
      throw new Error(
        `SNAPSHOT_REQUIRED: no active CDP snapshot exists. Call browser snapshot before acting on '${refOrSelector}'.`
      );
    }
    if (expectedSnapshotId && expectedSnapshotId !== this.activeSnapshotId) {
      throw new Error(
        `STALE_SNAPSHOT_REF: expected snapshot '${expectedSnapshotId}' does not match active '${this.activeSnapshotId}'.`
      );
    }
    const liveRev = await this.getLiveDomRevision();
    if (liveRev !== this.activeSnapshotDomRevision) {
      throw new Error(
        `STALE_SNAPSHOT_REF: live Chromium DOM mutated (rev ${this.activeSnapshotDomRevision} -> ${liveRev}) since ${this.activeSnapshotId}. Take a fresh snapshot before acting on '@${cleanRef}'.`
      );
    }
    const meta = this.activeRefs[cleanRef];
    if (!meta || meta.backendNodeId === undefined) {
      throw new Error(`UNKNOWN_SNAPSHOT_REF: '@${cleanRef}' not found in ${this.activeSnapshotId}.`);
    }
    const resolved = await this.sendCdp("DOM.resolveNode", {
      backendNodeId: meta.backendNodeId
    });
    const obj = resolved["object"] as { objectId?: string } | undefined;
    if (!obj?.objectId) {
      throw new Error(`DETACHED_DOM_NODE: '@${cleanRef}' is detached from the live Chromium DOM.`);
    }
    return { meta, objectId: obj.objectId };
  }

  public async click(
    ref: string,
    opts?: { expectedSnapshotId?: string }
  ): Promise<{
    clickedRef: string;
    role: string;
    name: string;
    navigatedTo?: string;
    domMutated: boolean;
  }> {
    const { meta, objectId } = await this.resolveValidatedBackendNode(
      ref,
      opts?.expectedSnapshotId
    );
    if (meta.disabled) {
      throw new Error(`ELEMENT_DISABLED: '${meta.ref}' (${meta.role} "${meta.name}") is disabled.`);
    }
    const beforeUrl = this.currentUrl;
    const beforeRev = this.activeSnapshotDomRevision;

    await this.sendCdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (this.disabled) throw new Error("ELEMENT_DISABLED");
        if (typeof this.focus === "function") this.focus();
        if (typeof this.click === "function") {
          this.click();
        } else {
          this.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
      }`,
      returnByValue: true
    });

    await new Promise((r) => setTimeout(r, 45));
    const afterUrl = await this.getLiveLocationHref();
    const afterRev = await this.getLiveDomRevision();
    this.currentUrl = afterUrl;
    const navigatedTo = afterUrl !== beforeUrl ? afterUrl : undefined;
    const domMutated = afterRev !== beforeRev || Boolean(navigatedTo);

    return {
      clickedRef: meta.ref,
      role: meta.role,
      name: meta.name,
      navigatedTo,
      domMutated
    };
  }

  public async fill(
    ref: string,
    text: string,
    opts?: { expectedSnapshotId?: string }
  ): Promise<{
    filledRef: string;
    role: string;
    name: string;
    value: string;
    domMutated: boolean;
  }> {
    const { meta, objectId } = await this.resolveValidatedBackendNode(
      ref,
      opts?.expectedSnapshotId
    );
    if (meta.disabled) {
      throw new Error(`ELEMENT_DISABLED: '${meta.ref}' is disabled.`);
    }
    const beforeRev = this.activeSnapshotDomRevision;

    await this.sendCdp("Runtime.callFunctionOn", {
      objectId,
      arguments: [{ value: text }],
      functionDeclaration: `function(val) {
        if (this.disabled) throw new Error("ELEMENT_DISABLED");
        if (typeof this.focus === "function") this.focus();
        const proto = Object.getPrototypeOf(this);
        const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
        if (desc && typeof desc.set === "function") {
          desc.set.call(this, val);
        } else {
          this.value = val;
        }
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
      returnByValue: true
    });

    await new Promise((r) => setTimeout(r, 25));
    const afterRev = await this.getLiveDomRevision();
    meta.valueText = text;

    return {
      filledRef: meta.ref,
      role: meta.role,
      name: meta.name,
      value: text,
      domMutated: afterRev !== beforeRev
    };
  }

  public async getText(ref: string, opts?: { expectedSnapshotId?: string }): Promise<string> {
    const { objectId } = await this.resolveValidatedBackendNode(ref, opts?.expectedSnapshotId);
    const callRes = await this.sendCdp("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        return String(this.innerText ?? this.textContent ?? this.value ?? "").trim();
      }`,
      returnByValue: true
    });
    const raw = String((callRes["result"] as { value?: unknown } | undefined)?.value ?? "");
    return scrubSecretsInfallible(raw);
  }

  public async evaluateDomMutationForTest(jsExpression: string): Promise<number> {
    await this.sendCdp("Runtime.evaluate", {
      expression: jsExpression,
      returnByValue: true
    });
    await new Promise((r) => setTimeout(r, 30));
    return await this.getLiveDomRevision();
  }

  public async screenshot(): Promise<ImageContent> {
    await this.ensureStarted();
    const shot = await this.sendCdp("Page.captureScreenshot", { format: "png" });
    const data = String(shot["data"] ?? "");
    const decoded = Buffer.from(data, "base64");
    if (
      decoded.length < 8 ||
      decoded[0] !== 0x89 ||
      decoded[1] !== 0x50 ||
      decoded[2] !== 0x4e ||
      decoded[3] !== 0x47
    ) {
      throw new Error("CHROMIUM_SCREENSHOT_INVALID_PNG");
    }
    return {
      type: "image",
      mimeType: "image/png",
      data
    };
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("CDP_SESSION_CLOSED"));
    }
    this.pending.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      if (p.exitCode === null && p.signalCode === null) {
        try {
          p.kill("SIGKILL");
        } catch {
          // ignore
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1500);
          p.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }

    if (this.userDataDir) {
      const dir = this.userDataDir;
      this.userDataDir = null;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
