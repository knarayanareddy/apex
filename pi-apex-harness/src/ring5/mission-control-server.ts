/**
 * Ring 5 — Out-of-Band Mission-Control HTTP + SSE Server (`src/ring5/mission-control-server.ts`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - `@earendil-works/pi-coding-agent@1.4.0` (`dist/modes/json-event.js` `toJsonEvent` delta wire
 *    serializer removing cumulative partial assistant snapshots on streaming channels, MIT).
 *  - `anomalyco/opencode` SSE control-plane event-bus pattern over live `AgentSessionRuntime`.
 *
 * PREVIEW & SECURITY INVARIANTS:
 *  1. Out-of-band operator server: adds `+0` tools to `session.agent.state.tools` (`1,073 === 1,073`
 *     `o200k_base` active schema tokens) and `0` live static-prefix SHA-256 drift.
 *  2. Binds `0.0.0.0` by default, accepts reverse-proxied preview hosts (`https://{port}-{sandboxId}.e2b.app`)
 *     without host-header rejection, and omits `X-Frame-Options` blocks so embedded browser previews work cleanly.
 *  3. Scrubs all outgoing JSON & SSE payloads through Ring 0 `scrubSecretsInfallible()`.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { ExecutionMode } from "../ring11/execution-mode-controller.ts";
import { rewindChatAndDiskToLeaf } from "../core/git-rewind.ts";
import { COMPILED_GUARDRAILS_SHA256, loadVerifiedGuardrails } from "../core/guardrail-pin.ts";
import { countO200kTokens } from "../core/prefix-budget.ts";
import { isSecretBasename } from "../core/safe-path.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import type { TrustArtifactKind } from "../ring2/plan-trust-artifacts.ts";
import type { CandidateRollout } from "../ring3/harness2-contrastive-evolver.ts";
import type { Ring4RuntimeController } from "../ring4/ring4-runtime.ts";
import { computeSessionUsageTelemetry } from "../ring6/provider-router.ts";
import { findGitMergeConflicts, type GitHubIssuePayload } from "../ring8/github-issue-bridge.ts";
import {
  listPersistedBenchmarks,
  runPersonalSweBenchmarkSuite
} from "../ring8/swe-eval-bench.ts";
import {
  type GatewayPlatform,
  generateSlackAppManifest
} from "../ring9/messaging-gateway.ts";
import type { DagNodeSpec } from "../ring9/multi-agent-orchestrator.ts";
import type { LearningEntryKind } from "../ring9/self-learning-ledger.ts";
import { SkillLibrary } from "../ring3/skill-library.ts";
import { renderMissionControlHtml } from "./mission-control-ui.ts";
import { DocumentInputError, DocumentProcessingError, extractDocument, formatExtractionForPrompt } from "../ring13/document-service.ts";
import { DocumentIsolationError } from "../ring13/document-worker.ts";
import { isTaskMode, routeTaskModePrompt, type TaskMode } from "./task-mode-routing.ts";

const DEFAULT_SURFACES_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "surfaces"
);

/**
 * Ported directly from `@earendil-works/pi-coding-agent@1.4.0` (`dist/modes/json-event.js`):
 * Strips cumulative `partial` assistant snapshots from streaming `message_update` events so SSE
 * wire payloads remain O(1) per delta.
 */
export function serializeSessionEventDelta(event: AgentSessionEvent): unknown {
  if (event.type !== "message_update") {
    return event;
  }
  const msgEvent = event.assistantMessageEvent as unknown as Record<string, unknown>;
  if (msgEvent["type"] === "toolcall_start") {
    const partial = msgEvent["partial"] as {
      content?: Array<{ type?: string; id?: string; name?: string }>;
    };
    const idx = Number(msgEvent["contentIndex"] ?? 0);
    const tc = partial?.content?.[idx];
    const { partial: _p, ...rest } = msgEvent;
    return {
      type: "message_update",
      usage: (event.message as { usage?: unknown }).usage,
      assistantMessageEvent: {
        ...rest,
        id: tc?.id ?? "",
        toolName: tc?.name ?? ""
      }
    };
  }
  const { partial: _p, ...rest } = msgEvent;
  return {
    type: "message_update",
    usage: (event.message as { usage?: unknown }).usage,
    assistantMessageEvent: rest
  };
}

function classifyProviderFailure(value: unknown): string {
  const message=typeof value==="string"?value.toLowerCase():"";
  if(/401|unauthori[sz]ed|invalid api.?key|authentication failed/.test(message))return "AUTH_REJECTED";
  if(/402|insufficient.{0,24}(credit|fund)|billing|payment required/.test(message))return "BILLING_OR_CREDITS";
  if(/403|forbidden|access denied/.test(message))return "ACCESS_DENIED";
  if(/404|model.{0,32}(not found|unavailable)|no endpoints/.test(message))return "MODEL_UNAVAILABLE";
  if(/408|429|rate.?limit|too many requests/.test(message))return "RATE_LIMITED";
  if(/timeout|timed out|aborted/.test(message))return "TIMEOUT";
  if(/5\d\d|server error/.test(message))return "PROVIDER_SERVER_ERROR";
  return "PROVIDER_ERROR";
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 262_144): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Payload exceeds ${maxBytes} bytes limit.`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

export interface MissionControlServerOptions {
  controller: Ring4RuntimeController;
  workspaceRoot: string;
  guardrailsPath?: string;
  expectedGuardrailsSha256?: string;
  host?: string;
  port?: number;
  authToken?: string;
  allowedHosts?: string[];
  requireAuth?: boolean;
}

export class MissionControlServer {
  private readonly controller: Ring4RuntimeController;
  private readonly workspaceRoot: string;
  private readonly guardrailsPath?: string;
  private readonly expectedGuardrailsSha256?: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly authToken: string;
  private readonly requireAuth: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly sseClients = new Set<http.ServerResponse>();
  private unsubscribeSession?: () => void;
  private unsubscribeHarnessSwitch?: () => void;
  private server: http.Server | null = null;
  private boundPort = 0;
  private ephemeralOpenRouter: { providerId: string; modelId: string; previousModel?: Model<any>; turns: number; expiresAtMs: number; timer: NodeJS.Timeout } | null = null;

  private async endEphemeralOpenRouterSession(): Promise<void> {
    const active=this.ephemeralOpenRouter;if(!active)return;this.ephemeralOpenRouter=null;clearTimeout(active.timer);
    const h=this.controller.getCurrentHarness();h.providerManager.endEphemeralOpenRouterSession(active.providerId);
    if(active.previousModel)await h.session.setModel(active.previousModel).catch(()=>{});
    this.broadcastSse({type:"ephemeral_provider_session_ended",providerId:active.providerId});
  }

  constructor(opts: MissionControlServerOptions) {
    this.controller = opts.controller;
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.guardrailsPath = opts.guardrailsPath;
    this.expectedGuardrailsSha256 = opts.expectedGuardrailsSha256;
    this.controller.getCurrentHarness().interactionController.setObserver((event) => this.broadcastSse({ type: event.type, approval: event.approval }));
    this.host = opts.host ?? "127.0.0.1";
    if (this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
      console.warn(`[APEX_COCKPIT_WARNING] MissionControlServer bound to non-loopback host '${this.host}'. Ensure TLS and network firewalling in production.`);
    }
    this.requestedPort = opts.port ?? 4310;
    this.authToken = opts.authToken ?? crypto.randomBytes(32).toString("hex");
    this.requireAuth = opts.requireAuth ?? true;
    this.allowedHosts = new Set([
      "127.0.0.1",
      "localhost",
      "::1",
      this.host.toLowerCase(),
      ...(opts.allowedHosts?.map((h) => h.toLowerCase()) ?? [])
    ]);
  }

  get token(): string {
    return this.authToken;
  }

  private _isAllowedHost(hostHeader?: string): boolean {
    if (!hostHeader) return true;
    const hostname = hostHeader.split(":")[0].toLowerCase();
    if (this.allowedHosts.has(hostname)) return true;
    if (hostname.endsWith(".e2b.app")) return true;
    return false;
  }

  private _isAllowedOrigin(originHeader?: string): boolean {
    if (!originHeader) return false;
    try {
      const u = new URL(originHeader);
      const hostname = u.hostname.toLowerCase();
      if (this.allowedHosts.has(hostname)) return true;
      if (hostname.endsWith(".e2b.app")) return true;
      return false;
    } catch {
      return false;
    }
  }

  private _isCookieAuthenticated(req: http.IncomingMessage): boolean {
    // If valid Bearer token is present, request is Bearer-authenticated (immune to ambient CSRF)
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const candidate = authHeader.slice("Bearer ".length).trim();
      if (candidate && timingSafeEqualStr(candidate, this.authToken)) {
        return false;
      }
    }
    const cookieHeader = req.headers["cookie"];
    if (cookieHeader) {
      const cookies = parseCookies(cookieHeader);
      const sessionVal = cookies["apex_session"];
      if (sessionVal && timingSafeEqualStr(sessionVal, this.authToken)) {
        return true;
      }
    }
    return false;
  }

  private _isExactTrustedOrigin(originHeader?: string): boolean {
    if (!originHeader) return false;
    try {
      const u = new URL(originHeader);
      const port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
      const boundPort = this.boundPort;
      // Must match server bound port (cross-port origins are untrusted for CSRF)
      if (boundPort && port !== boundPort) {
        return false;
      }
      const hostname = u.hostname.toLowerCase();
      if (
        hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === this.host.toLowerCase() ||
        this.allowedHosts.has(hostname) ||
        hostname.endsWith(".e2b.app")
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private _validateAuth(req: http.IncomingMessage): boolean {
    if (!this.requireAuth) return true;

    // 1. Authorization: Bearer <token>
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const candidate = authHeader.slice("Bearer ".length).trim();
      if (candidate && timingSafeEqualStr(candidate, this.authToken)) {
        return true;
      }
    }

    // 2. Cookie: apex_session=<token>
    const cookieHeader = req.headers["cookie"];
    if (cookieHeader) {
      const cookies = parseCookies(cookieHeader);
      const sessionVal = cookies["apex_session"];
      if (sessionVal && timingSafeEqualStr(sessionVal, this.authToken)) {
        return true;
      }
    }

    return false;
  }

  get port(): number {
    return this.boundPort;
  }

  private _getWorkspaceRoot(): string {
    return this.controller.getActiveWorkspaceRoot() || this.workspaceRoot;
  }

  private _bindSessionStream(): void {
    this.unsubscribeSession?.();
    const session = this.controller.runtimeHost.session;
    this.unsubscribeSession = session.subscribe((ev) => {
      this.broadcastSse(serializeSessionEventDelta(ev));
    });
  }

  broadcastSse(payload: unknown): void {
    if (this.sseClients.size === 0) return;
    const safeJson = scrubSecretsInfallible(JSON.stringify(payload));
    const frame = `data: ${safeJson}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(frame);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  private _sendJson(res: http.ServerResponse, status: number, body: unknown, req?: http.IncomingMessage): void {
    const safePayload = scrubSecretsInfallible(JSON.stringify(body));
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    if (req?.headers.origin && this._isAllowedOrigin(req.headers.origin)) {
      headers["Access-Control-Allow-Origin"] = req.headers.origin;
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }
    res.writeHead(status, headers);
    res.end(safePayload);
  }

  private _collectStatusSnapshot(): Record<string, unknown> {
    const h = this.controller.getCurrentHarness();
    const sessionId = h.session.sessionManager.getSessionId();
    const currentLeafId = h.session.sessionManager.getLeafId() ?? null;

    const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
      h.session.systemPrompt,
      h.session.agent.state.tools
    );
    const activeSchemaTokens = countO200kTokens(
      JSON.stringify(
        h.session.agent.state.tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? null
        }))
      )
    );
    const totalPrefixTokens = h.prefix.componentTokens.textTotal + activeSchemaTokens;

    const gVer = loadVerifiedGuardrails(this.guardrailsPath, this.expectedGuardrailsSha256);
    const expectedPin = this.expectedGuardrailsSha256 ?? COMPILED_GUARDRAILS_SHA256;

    const checkpoints = h.stateDb.db
      .prepare(
        `SELECT leaf_id, turn_index, git_tree_oid, created_at_ms
         FROM git_checkpoints WHERE session_id = ? ORDER BY turn_index DESC LIMIT 30`
      )
      .all(sessionId);

    const walRows = h.stateDb.db
      .prepare(
        `SELECT tool_call_id, tool_name, mutability_class, target_path, status, updated_at_ms
         FROM wal_intents WHERE session_id = ? ORDER BY updated_at_ms DESC LIMIT 30`
      )
      .all(sessionId);

    const memoryMd = h.dreamingConsolidator.readDiskMemoryMd();
    const experienceMd = h.experienceEvolver.readCurrentExperienceMd();
    const driftCount = Math.max(0, new Set(h.observedPrefixHashes).size - 1);
    const usage = computeSessionUsageTelemetry(
      h.session.state.messages as ReadonlyArray<{ role?: string }>
    );
    const activeModel = h.session.model
      ? `${h.session.model.provider}/${h.session.model.id}`
      : "none";

    return {
      workspaceRoot: this._getWorkspaceRoot(),
      sessionId,
      currentLeafId,
      activeModel,
      activePreset: h.presetController.getActivePreset()?.name ?? null,
      bookmarksCount: h.bookmarkController.listBookmarks(h.session.sessionManager).length,
      prRunsCount: h.prPipeline.listRuns().length,
      chromiumAvailable: h.browserController.hasLocalChromium(),
      obsidianVault: h.obsidianVault?.status() ?? { enabled: false, readOnly: true, markdownOnly: true },
      planModeActive: h.trustArtifacts.isPlanModeActive(),
      cuaEnabled: h.cuaDriver.isEnabled(),
      guardrailsSha256: gVer.sha256,
      guardrailsPinVerified: gVer.sha256 === expectedPin,
      usage,
      mcpServers: h.mcpHub.listServers(),
      prefix: {
        activeSchemaTokens,
        staticTextTokens: h.prefix.componentTokens.textTotal,
        bootMemoryTokens: h.prefix.componentTokens.memoryMd,
        totalPrefixTokens,
        maxPrefixTokens: h.guardrails.prefix_caps_o200k.total_max,
        livePrefixSha256,
        driftCount
      },
      artifacts: h.trustArtifacts.listArtifacts(),
      skills: h.skillCurator.listSkills(),
      checkpoints,
      walRows,
      surfaces: {
        memoryMd,
        memoryTokens: countO200kTokens(memoryMd),
        experienceMd,
        experienceTokens: countO200kTokens(experienceMd)
      }
    };
  }

  async start(): Promise<{ host: string; port: number; url: string; token: string }> {
    if (this.server) {
      return {
        host: this.host,
        port: this.boundPort,
        url: `http://${this.host}:${this.boundPort}`,
        token: this.authToken
      };
    }

    this.controller.getCurrentHarness().interactionController.setApprovalConsumerAttached(true);
    this._bindSessionStream();
    this.unsubscribeHarnessSwitch = this.controller.onHarnessSwitch(() => {
      const next = this.controller.getCurrentHarness();
      next.interactionController.setObserver((event) => this.broadcastSse({ type: event.type, approval: event.approval }));
      next.interactionController.setApprovalConsumerAttached(true);
      this._bindSessionStream();
      this.broadcastSse({ type: "cockpit_refresh", reason: "session_rebound" });
    });

    this.server = http.createServer(async (req, res) => {
      try {
        if (!this._isAllowedHost(req.headers["host"])) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Host header (DNS rebinding protection)" }));
          return;
        }

        if (req.method === "OPTIONS") {
          const origin = req.headers.origin;
          const headers: Record<string, string> = {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Allow-Credentials": "true"
          };
          if (origin && this._isAllowedOrigin(origin)) {
            headers["Access-Control-Allow-Origin"] = origin;
          }
          res.writeHead(204, headers);
          res.end();
          return;
        }

        const parsedUrl = new URL(req.url ?? "/", "http://pi-apex.local");
        const pathname = parsedUrl.pathname;

        // 1. Self-contained Operator Cockpit HTML (with ?token= handshake)
        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
          const tokenParam = parsedUrl.searchParams.get("token");
          if (tokenParam && timingSafeEqualStr(tokenParam, this.authToken)) {
            res.writeHead(302, {
              "Set-Cookie": `apex_session=${this.authToken}; HttpOnly; SameSite=Strict; Path=/`,
              Location: pathname === "/index.html" ? "/index.html" : "/"
            });
            res.end();
            return;
          }

          if (this.requireAuth && !this._validateAuth(req)) {
            res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              "<!DOCTYPE html><html><body><h1>401 Unauthorized</h1><p>Mission Control Cockpit requires authentication. Connect with ?token=&lt;token&gt; or Authorization: Bearer.</p></body></html>"
            );
            return;
          }

          const html = renderMissionControlHtml();
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
          });
          res.end(html);
          return;
        }

        // Protected routes gate: reject all unauthenticated requests with 401
        if (this.requireAuth && !this._validateAuth(req)) {
          this._sendJson(
            res,
            401,
            { error: "Unauthorized: valid Bearer token or apex_session cookie required" },
            req
          );
          return;
        }

        // Exact-Origin Protection: reject untrusted, cross-port, or missing Origin for cookie-authenticated mutations (Reviewer P1-2)
        const isMutatingMethod =
          req.method === "POST" ||
          req.method === "PUT" ||
          req.method === "DELETE" ||
          req.method === "PATCH";

        if (isMutatingMethod && this._isCookieAuthenticated(req)) {
          const rawOrigin = req.headers["origin"];
          const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
          if (!this._isExactTrustedOrigin(origin)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "CSRF_ORIGIN_MISMATCH: untrusted, cross-port, or missing Origin for cookie-authenticated mutation"
              })
            );
            return;
          }
        }

        // 2. Live SSE event stream
        if (req.method === "GET" && pathname === "/api/events") {
          const sseHeaders: Record<string, string> = {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive"
          };
          if (req.headers.origin && this._isAllowedOrigin(req.headers.origin)) {
            sseHeaders["Access-Control-Allow-Origin"] = req.headers.origin;
            sseHeaders["Access-Control-Allow-Credentials"] = "true";
          }
          res.writeHead(200, sseHeaders);
          res.write(
            `data: ${JSON.stringify({
              type: "connected",
              sessionId: this.controller.runtimeHost.session.sessionManager.getSessionId()
            })}\n\n`
          );
          this.sseClients.add(res);
          req.on("close", () => {
            this.sseClients.delete(res);
          });
          return;
        }

        // 3. Full cockpit telemetry snapshot
        if (req.method === "GET" && pathname === "/api/status") {
          this._sendJson(res, 200, this._collectStatusSnapshot());
          return;
        }

        const h = this.controller.getCurrentHarness();

        // 4. Toggle Plan Mode
        if (req.method === "POST" && pathname === "/api/plan/toggle") {
          const body = await readJsonBody(req);
          const next =
            typeof body["enabled"] === "boolean"
              ? body["enabled"]
              : !h.trustArtifacts.isPlanModeActive();
          h.trustArtifacts.setPlanMode(next);
          this.broadcastSse({ type: "cockpit_refresh", reason: "plan_mode_toggled", planModeActive: next });
          this._sendJson(res, 200, { planModeActive: next });
          return;
        }

        // 5. Create or update Trust Artifact
        if (req.method === "POST" && pathname === "/api/artifacts") {
          const body = await readJsonBody(req);
          const kind = ((body["kind"] as string) ?? "plan") as TrustArtifactKind;
          const art = h.trustArtifacts.createOrUpdateArtifact({
            artifactId: typeof body["artifactId"] === "string" ? body["artifactId"] : undefined,
            kind,
            title: String(body["title"] ?? "Plan Artifact"),
            markdown: String(body["markdown"] ?? "")
          });
          this.broadcastSse({ type: "cockpit_refresh", reason: "artifact_updated", artifactId: art.artifactId });
          this._sendJson(res, 200, art);
          return;
        }

        // 6. Approve Plan Trust Artifact
        const approveMatch = /^\/api\/artifacts\/([^/]+)\/approve$/.exec(pathname);
        if (req.method === "POST" && approveMatch) {
          const artifactId = decodeURIComponent(approveMatch[1]!);
          const art = h.trustArtifacts.approvePlanArtifact(artifactId, true);
          this.broadcastSse({ type: "cockpit_refresh", reason: "artifact_approved", artifactId });
          this._sendJson(res, 200, art);
          return;
        }

        // 7. Inline Line-Anchored `steer()` Review Comment
        const steerMatch = /^\/api\/artifacts\/([^/]+)\/steer$/.exec(pathname);
        if (req.method === "POST" && steerMatch) {
          const artifactId = decodeURIComponent(steerMatch[1]!);
          const body = await readJsonBody(req);
          const commentText = String(body["comment"] ?? "").trim();
          if (!commentText) {
            this._sendJson(res, 400, { error: "Review comment cannot be empty." });
            return;
          }
          const cmt = await h.trustArtifacts.addInlineCommentAndSteer({
            artifactId,
            lineStart: Number(body["lineStart"] ?? 1),
            lineEnd: Number(body["lineEnd"] ?? body["lineStart"] ?? 1),
            comment: commentText,
            author: "cockpit-operator"
          });
          this.broadcastSse({ type: "cockpit_refresh", reason: "artifact_steered", artifactId });
          this._sendJson(res, 200, cmt);
          return;
        }

        if (pathname === "/api/skills" && req.method === "POST") {
          const h=this.controller.getCurrentHarness();const body=await readJsonBody(req);const action=String(body["action"]??"");const name=String(body["name"]??"");
          if(action==="archive"){const record=h.skillCurator.archiveSkill(name);this.broadcastSse({type:"cockpit_refresh",reason:"skill_archived",name});this._sendJson(res,200,{record});return;}
          if(action==="delete"){h.skillCurator.deleteSkill(name);this.broadcastSse({type:"cockpit_refresh",reason:"skill_deleted",name});this._sendJson(res,200,{ok:true});return;}
          this._sendJson(res,400,{error:"Unknown skill action."});return;
        }
        if (pathname === "/api/skills" && req.method === "GET") {
          const h = this.controller.getCurrentHarness();
          const library = new SkillLibrary({
            workspaceRoot: this._getWorkspaceRoot(),
            listLedger: () => h.skillCurator.listSkills(),
            extraRoots: [
              { path: path.join(this._getWorkspaceRoot(), ".skills-quarantine"), label: "quarantine", kind: "quarantine" },
              { path: path.join(this._getWorkspaceRoot(), ".agents", ".archive"), label: "archive", kind: "archive" }
            ]
          });
          const skillId = parsedUrl.searchParams.get("id");
          if (skillId) this._sendJson(res, 200, library.read(skillId));
          else {
            const skills=library.list();const counts=new Map<string,number>();skills.forEach(s=>counts.set(s.name,(counts.get(s.name)??0)+1));
            skills.forEach(s=>{if((counts.get(s.name)??0)>1)s.warnings.push("Duplicate skill name across discovered sources.");});
            this._sendJson(res, 200, { skills });
          }
          return;
        }

        // 8. Distill skill into `.skills-quarantine/`
        if (req.method === "POST" && pathname === "/api/quarantine/distill") {
          const body = await readJsonBody(req, 2_500_000);
          const rawFiles = body["supportingFiles"];
          const supportingFiles: Record<string,string> = {};
          if (rawFiles && typeof rawFiles === "object" && !Array.isArray(rawFiles)) {
            for (const [rel, value] of Object.entries(rawFiles as Record<string,unknown>)) {
              if (typeof value !== "string" || Buffer.byteLength(value) > 512_000) throw new Error("SKILL_IMPORT_FILE_LIMIT");
              supportingFiles[rel] = value;
            }
          }
          const skillMd = String(body["skillMd"] ?? supportingFiles["SKILL.md"] ?? "");
          delete supportingFiles["SKILL.md"];
          const resDistill = h.skillCurator.distillToQuarantine({
            skillMd,
            supportingFiles,
            source: String(body["source"] ?? "operator-created-or-imported"),
            trustLevel: "agent-created"
          });
          this.broadcastSse({
            type: "cockpit_refresh",
            reason: "skill_distilled",
            name: resDistill.record.name,
            verdict: resDistill.scan.verdict
          });
          this._sendJson(res, 200, resDistill);
          return;
        }

        // 9. Operator-approved promotion from `.skills-quarantine/`
        const promoteMatch = /^\/api\/quarantine\/([^/]+)\/promote$/.exec(pathname);
        if (req.method === "POST" && promoteMatch) {
          const skillName = decodeURIComponent(promoteMatch[1]!);
          const promoted = h.skillCurator.promoteFromQuarantine({
            name: skillName,
            operatorApproved: true
          });
          this.broadcastSse({ type: "cockpit_refresh", reason: "skill_promoted", name: skillName });
          this._sendJson(res, 200, promoted);
          return;
        }

        // 10. Skill Curator automatic lifecycle pass
        if (req.method === "POST" && pathname === "/api/quarantine/lifecycle") {
          const summary = h.skillCurator.runAutomaticLifecyclePass();
          this.broadcastSse({ type: "cockpit_refresh", reason: "skill_lifecycle_pass" });
          this._sendJson(res, 200, summary);
          return;
        }

        // 11. Atomic Kernel-Locked `/tree` Git Rewind
        if (req.method === "POST" && pathname === "/api/rewind") {
          const body = await readJsonBody(req);
          const toLeafId = String(body["toLeafId"] ?? "").trim();
          const fromLeafId = h.session.sessionManager.getLeafId();
          if (!toLeafId || !fromLeafId) {
            this._sendJson(res, 400, { error: "Both current leaf and target toLeafId are required." });
            return;
          }
          const receipt = rewindChatAndDiskToLeaf({
            stateDb: h.stateDb,
            workspaceRoot: this._getWorkspaceRoot(),
            sessionManager: h.session.sessionManager,
            sessionId: h.session.sessionManager.getSessionId(),
            fromLeafId,
            toLeafId,
            durabilityMode: h.stateDb.durabilityMode
          });
          this.broadcastSse({ type: "cockpit_refresh", reason: "workspace_rewound", toLeafId });
          this._sendJson(res, 200, receipt);
          return;
        }

        // 12. `Dreaming` offline FTS5 episodic memory consolidator
        if (req.method === "POST" && pathname === "/api/dream") {
          const body = await readJsonBody(req);
          const dreamRes = h.dreamingConsolidator.runDreamingPass({
            query: typeof body["query"] === "string" ? body["query"] : undefined
          });
          const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
            h.session.systemPrompt,
            h.session.agent.state.tools
          );
          this.broadcastSse({ type: "cockpit_refresh", reason: "dreaming_completed" });
          this._sendJson(res, 200, { ...dreamRes, livePrefixSha256 });
          return;
        }

        // 13. `Harness²` 4-gate contrastive evolution / recall
        if (req.method === "POST" && pathname === "/api/evolve") {
          const body = await readJsonBody(req);
          if (body["action"] === "recall") {
            const entries = h.experienceEvolver.recallRelevantExperiences({
              domain: String(body["domain"] ?? "general"),
              query: typeof body["query"] === "string" ? body["query"] : undefined
            });
            this._sendJson(res, 200, { entries });
            return;
          }
          const evoRes = h.experienceEvolver.runProposeProbeCompose({
            domain: String(body["domain"] ?? "general"),
            taskId: String(body["taskId"] ?? "cockpit-task"),
            baseline: body["baseline"] as CandidateRollout,
            candidates: (body["candidates"] as CandidateRollout[]) ?? []
          });
          this.broadcastSse({ type: "cockpit_refresh", reason: "evolution_completed", adopted: evoRes.adopted });
          this._sendJson(res, 200, evoRes);
          return;
        }

        // 14. Execute any `/` operator slash command
        if (req.method === "POST" && pathname === "/api/slash") {
          const body = await readJsonBody(req);
          const rawCmd = String(body["command"] ?? "").trim();
          if (!rawCmd.startsWith("/")) {
            this._sendJson(res, 400, { error: "Slash command must start with '/'." });
            return;
          }
          const beforeCount = h.session.state.messages.length;
          await h.session.prompt(rawCmd);
          const afterMessages = h.session.state.messages.slice(beforeCount);
          const lastCustom = [...afterMessages]
            .reverse()
            .find((m) => (m as { role?: string }).role === "custom") as
            | { content?: unknown; details?: unknown }
            | undefined;
          const markdown =
            typeof lastCustom?.content === "string"
              ? lastCustom.content
              : JSON.stringify(lastCustom?.content ?? "");
          this.broadcastSse({ type: "cockpit_refresh", reason: "slash_command", command: rawCmd });
          this._sendJson(res, 200, {
            command: rawCmd,
            markdown,
            details: lastCustom?.details ?? null
          });
          return;
        }

        // 15. `/new` Fresh Session Reload (activates staged `surfaces/MEMORY.md`)
        if (req.method === "POST" && pathname === "/api/new-session") {
          const sw = await this.controller.runtimeHost.newSession();
          this._bindSessionStream();
          const nextH = this.controller.getCurrentHarness();
          const prefixSha256 = nextH.prefix.verifyInvariantBeforeRequest(
            nextH.session.systemPrompt,
            nextH.session.agent.state.tools
          );
          this.broadcastSse({ type: "cockpit_refresh", reason: "new_session_started" });
          this._sendJson(res, 200, {
            cancelled: sw.cancelled,
            sessionId: nextH.session.sessionManager.getSessionId(),
            prefixSha256
          });
          return;
        }

        // 16. Live Agent Prompt / Steer Turn (`POST /api/prompt`)
        if (req.method === "POST" && pathname === "/api/prompt") {
          const body = await readJsonBody(req, 46 * 1024 * 1024);
          let text = String(body["text"] ?? "").trim();
          const mode = body["mode"] === "steer" ? "steer" : "prompt";
          const taskModeRaw = body["taskMode"] ?? "automatic";
          if (taskModeRaw !== "automatic" && !isTaskMode(taskModeRaw)) { this._sendJson(res, 400, { error: "TASK_MODE_INVALID" }); return; }
          const taskMode = taskModeRaw === "automatic" ? "automatic" : taskModeRaw as TaskMode;
          let appliedTaskMode: "automatic" | TaskMode = "automatic";
          const imagesRaw = Array.isArray(body["images"]) ? body["images"] : [];
          if (imagesRaw.length > 4) { this._sendJson(res, 413, { error: "IMAGE_COUNT_LIMIT: at most 4 images per message." }); return; }
          const images: ImageContent[] = [];
          const documentRaw = body["document"];
          if (taskMode === "teamwork" && (imagesRaw.length > 0 || (documentRaw !== undefined && documentRaw !== null))) {
            this._sendJson(res, 400, { error: "TEAMWORK_ATTACHMENTS_UNSUPPORTED", message: "Teamwork mode is text-only for now; remove attachments or choose another mode." }); return;
          }
          let totalImageBytes = 0;
          for (const raw of imagesRaw) {
            if (typeof raw !== "object" || raw === null) { this._sendJson(res, 400, { error: "IMAGE_ATTACHMENT_INVALID" }); return; }
            const item = raw as Record<string, unknown>;
            const mimeType = String(item["mimeType"] ?? "").toLowerCase();
            const data = String(item["data"] ?? "");
            if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || !/^[A-Za-z0-9+/]+=*$/.test(data)) { this._sendJson(res, 400, { error: "IMAGE_FORMAT_OR_BASE64_INVALID" }); return; }
            const bytes = Buffer.from(data, "base64");
            if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) { this._sendJson(res, 413, { error: "IMAGE_SIZE_OR_ENCODING_INVALID" }); return; }
            const signatureOk = mimeType === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : mimeType === "image/png" ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
            if (!signatureOk) { this._sendJson(res, 400, { error: "IMAGE_CONTENT_MISMATCH: file content does not match its declared image type." }); return; }
            totalImageBytes += bytes.length; if (totalImageBytes > 32 * 1024 * 1024) { this._sendJson(res, 413, { error: "IMAGE_TOTAL_SIZE_LIMIT" }); return; }
            images.push({ type: "image", mimeType, data });
          }
          if (documentRaw !== undefined && documentRaw !== null) {
            if (mode === "steer") { this._sendJson(res, 400, { error: "DOCUMENT_STEER_UNSUPPORTED: send documents in a new prompt." }); return; }
            if (images.length) { this._sendJson(res, 400, { error: "DOCUMENT_IMAGE_MIX_UNSUPPORTED: send one document or image attachments per prompt." }); return; }
            if (typeof documentRaw !== "object" || Array.isArray(documentRaw)) { this._sendJson(res, 400, { error: "DOCUMENT_ATTACHMENT_INVALID" }); return; }
            const item = documentRaw as Record<string, unknown>;
            if (Object.keys(item).some((key) => !["filename", "dataBase64", "mimeType"].includes(key)) || typeof item["filename"] !== "string" || typeof item["dataBase64"] !== "string") { this._sendJson(res, 400, { error: "DOCUMENT_ATTACHMENT_SHAPE_INVALID" }); return; }
            const documentAbort = new AbortController();
            const onRequestAborted = () => documentAbort.abort();
            const onResponseClosed = () => { if (!res.writableEnded) documentAbort.abort(); };
            req.once("aborted", onRequestAborted); res.once("close", onResponseClosed);
            try {
              const extracted = await extractDocument({ filename: item["filename"], dataBase64: item["dataBase64"], mimeType: typeof item["mimeType"] === "string" ? item["mimeType"] : undefined }, { signal: documentAbort.signal });
              text += `${text ? "\\n\\n" : "Please inspect the attached document."}\\n\\n${formatExtractionForPrompt(extracted)}`;
            } catch (error) {
              if (error instanceof DocumentInputError) { this._sendJson(res, 400, { error: "DOCUMENT_INPUT_INVALID", message: error.message }); return; }
              if (error instanceof DocumentProcessingError) { this._sendJson(res, 422, { error: error.code, message: error.message }); return; }
              if (error instanceof DocumentIsolationError) { this._sendJson(res, 503, { error: "DOCUMENT_FEATURE_UNAVAILABLE", message: error.message }); return; }
              throw error;
            } finally {
              req.removeListener("aborted", onRequestAborted); res.removeListener("close", onResponseClosed);
            }
          }
          if (!text && images.length) text = "Please inspect the attached image(s).";
          if (!text) { this._sendJson(res, 400, { error: "Prompt text cannot be empty." }); return; }
          if (mode === "steer" && images.length) { this._sendJson(res, 400, { error: "STEER_IMAGE_UNSUPPORTED: send images in a new prompt." }); return; }
          if (mode === "steer" && h.session.isStreaming) {
            await h.session.steer(text);
            this._sendJson(res, 200, { ok: true, mode: "steer", sessionId: h.session.sessionManager.getSessionId() });
            return;
          }
          const personaId = typeof body["personaId"] === "string" ? body["personaId"] : undefined;
          const buildProfile = typeof body["buildProfile"] === "string" ? body["buildProfile"] : undefined;
          const selected = h.interactionController.setPersonaProfile(personaId, buildProfile);
          if (personaId && personaId !== "general") {
            const personaContext = h.interactionController.getPersonaContext().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            text = `<operator-selected-chat-style persona="${selected.persona}" profile="${selected.buildProfile}">${personaContext}</operator-selected-chat-style>\n\n${text}`;
          }
          if (images.length && !h.session.model?.input?.includes("image")) { this._sendJson(res, 400, { error: "ACTIVE_MODEL_NO_IMAGE_INPUT: select a model with image input support." }); return; }
          if (mode === "prompt" && !text.trimStart().startsWith("/")) {
            appliedTaskMode = taskMode;
            const route = routeTaskModePrompt(text, taskMode);
            if (route.enablePlanMode) {
              h.trustArtifacts.setPlanMode(true);
              this.broadcastSse({ type: "cockpit_refresh", reason: "task_mode_plan_enabled", planModeActive: true });
            }
            text = route.prompt;
          }
          await h.session.prompt(text, { ...(images.length ? { images } : {}) });
          if(this.ephemeralOpenRouter&&h.session.model?.provider===this.ephemeralOpenRouter.providerId){this.ephemeralOpenRouter.turns++;if(this.ephemeralOpenRouter.turns>=3)await this.endEphemeralOpenRouterSession();}
          const msgs = h.session.state.messages;
          const lastAssistant = [...msgs]
            .reverse()
            .find((m) => (m as { role?: string }).role === "assistant") as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined;
          const replyText =
            lastAssistant?.content
              ?.filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n") ?? "";
          this.broadcastSse({ type: "cockpit_refresh", reason: "prompt_completed" });
          this._sendJson(res, 200, {
            ok: true,
            mode: "prompt",
            taskMode: appliedTaskMode,
            replyText,
            sessionId: h.session.sessionManager.getSessionId()
          });
          return;
        }

        // 17. Ring 6 Cockpit v2 — Multi-Turn Normalized Chat Transcript (`GET /api/transcript`)
        if (req.method === "GET" && pathname === "/api/transcript") {
          const rawMessages = h.session.state.messages;
          const items = rawMessages.map((raw, idx) => {
            const m = raw as Record<string, unknown>;
            const role = String(m["role"] ?? "unknown");
            let text = "";
            const toolCalls: Array<{ name: string; argsPreview: string }> = [];

            if (typeof m["content"] === "string") {
              text = m["content"];
            } else if (Array.isArray(m["content"])) {
              const parts: string[] = [];
              for (const blk of m["content"] as Array<Record<string, unknown>>) {
                if (blk["type"] === "text" && typeof blk["text"] === "string") {
                  parts.push(blk["text"]);
                } else if (blk["type"] === "toolCall") {
                  toolCalls.push({
                    name: String(blk["name"] ?? ""),
                    argsPreview: JSON.stringify(blk["arguments"] ?? {}).slice(0, 180)
                  });
                } else if (blk["type"] === "image") {
                  parts.push(`[image: ${String(blk["mimeType"] ?? "image/png")}]`);
                }
              }
              text = parts.join("\n");
            }
            return {
              index: idx,
              role,
              toolName: typeof m["toolName"] === "string" ? m["toolName"] : undefined,
              isError: Boolean(m["isError"]),
              stopReason: typeof m["stopReason"] === "string" ? m["stopReason"] : undefined,
              failureCode: m["stopReason"] === "error" ? classifyProviderFailure(m["errorMessage"]) : undefined,
              model:
                typeof m["provider"] === "string" && typeof m["model"] === "string"
                  ? `${m["provider"]}/${m["model"]}`
                  : undefined,
              text: text.slice(0, 8000),
              toolCalls
            };
          });
          const usage = computeSessionUsageTelemetry(
            rawMessages as ReadonlyArray<{ role?: string }>
          );
          this._sendJson(res, 200, {
            sessionId: h.session.sessionManager.getSessionId(),
            isStreaming: h.session.isStreaming,
            activeModel: h.session.model ? `${h.session.model.provider}/${h.session.model.id}` : "none",
            usage,
            messages: items
          });
          return;
        }

        // 18. Ring 6 Cockpit v2 — Abort Streaming Turn (`POST /api/abort`)
        if (req.method === "POST" && pathname === "/api/abort") {
          await h.session.abort();
          this.broadcastSse({ type: "cockpit_refresh", reason: "turn_aborted" });
          this._sendJson(res, 200, { aborted: true });
          return;
        }

        // 19. Ring 6 Cockpit v2 — Live Workspace Git Diff & Status Viewer (`GET /api/diff`)
        if (req.method === "GET" && pathname === "/api/diff") {
          const activeWs = this._getWorkspaceRoot();
          const stOut = spawnSync("git", ["status", "--short"], {
            cwd: activeWs,
            encoding: "utf8"
          });
          const statusLines = (stOut.stdout ?? "")
            .split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => {
              if (!l) return false;
              const filePart = l.slice(3).trim();
              if (filePart.startsWith(".harness/") || filePart === ".harness") return false;
              if (isSecretBasename(path.basename(filePart))) return false;
              return true;
            });

          const diffOut = spawnSync("git", ["diff", "HEAD", "--", ".", ":(exclude).harness"], {
            cwd: activeWs,
            encoding: "utf8",
            maxBuffer: 1024 * 1024
          });
          const rawDiff = (diffOut.stdout ?? "").slice(0, 120_000);
          this._sendJson(res, 200, {
            changedFilesCount: statusLines.length,
            statusLines,
            diffText: scrubSecretsInfallible(rawDiff)
          });
          return;
        }

        // 20. Ring 6 Cockpit v2 — Multi-Session Browser & Switcher (`/api/sessions`)
        if (pathname === "/api/sessions") {
          const activeWs = this._getWorkspaceRoot();
          const sessionsDir = path.join(activeWs, ".harness", "sessions");
          if (req.method === "GET") {
            const curId = h.session.sessionManager.getSessionId();
            const curFile = h.session.sessionManager.getSessionFile() ?? null;
            const listed = fs.existsSync(sessionsDir)
              ? await SessionManager.list(activeWs, sessionsDir)
              : [];
            const sessions = listed.map((s) => ({
              id: s.id,
              path: s.path,
              name: s.name ?? null,
              modifiedMs: s.modified.getTime(),
              messageCount: s.messageCount,
              firstMessage: s.firstMessage.slice(0, 140),
              isCurrent: s.id === curId || s.path === curFile
            }));
            this._sendJson(res, 200, {
              currentSessionId: curId,
              currentSessionFile: curFile,
              sessions
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const rawSessionPath = String(body["sessionPath"] ?? "").trim();
            if (!rawSessionPath) {
              this._sendJson(res, 400, { error: "sessionPath is required." });
              return;
            }
            const resolvedSessionPath = path.resolve(rawSessionPath);
            const resolvedSessionsDir = path.resolve(sessionsDir);
            if (!resolvedSessionPath.startsWith(resolvedSessionsDir + path.sep)) {
              this._sendJson(res, 400, {
                error: "SESSION_PATH_OUTSIDE_WORKSPACE: Session file must reside inside .harness/sessions."
              });
              return;
            }
            const sw = await this.controller.runtimeHost.switchSession(resolvedSessionPath);
            this._bindSessionStream();
            const nextH = this.controller.getCurrentHarness();
            this.broadcastSse({ type: "cockpit_refresh", reason: "session_switched" });
            this._sendJson(res, 200, {
              cancelled: sw.cancelled,
              sessionId: nextH.session.sessionManager.getSessionId()
            });
            return;
          }
        }

        // Ring 12 — searchable, paginated runtime + optional advisory models.dev catalog.
        if (pathname === "/api/catalog") {
          const h = this.controller.getCurrentHarness();
          if(req.method==="POST"){
            const body=await readJsonBody(req);const action=String(body["action"]??"");
            if(action==="refresh_remote"){
              const refreshed=await h.providerManager.refreshRemoteCatalog();this.broadcastSse({type:"model_catalog_refreshed",modelCount:refreshed.modelCount,refreshedAtMs:refreshed.refreshedAtMs});
              this._sendJson(res,200,{...refreshed,source:"models.dev"});return;
            }
            if(action==="refresh_runtime"){
              const providers=h.modelRuntime.getProviders().filter(p=>h.modelRuntime.hasConfiguredAuth(p.id)).map(p=>p.id);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15_000);
              try{const result=await h.modelRuntime.refresh({allowNetwork:true,force:true,providers,signal:controller.signal});const failed=[...result.errors.keys()];this.broadcastSse({type:"model_runtime_refreshed",providerCount:providers.length,failedCount:failed.length});this._sendJson(res,200,{providerCount:providers.length,failedProviderIds:failed,aborted:result.aborted});return;}finally{clearTimeout(timer);}
            }
            this._sendJson(res,400,{error:"CATALOG_ACTION_UNSUPPORTED"});return;
          }
          if(req.method==="GET"){
            const url = new URL(req.url ?? "/api/catalog", "http://mission-control.local");
            const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
            const providerFilter = (url.searchParams.get("provider") ?? "").trim();
            const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
            const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50));
            const index=new Map<string,Record<string,unknown>>();
            for(const m of h.modelRuntime.getModels()) index.set(`${m.provider}/${m.id}`,{provider:m.provider,id:m.id,name:m.name,api:m.api,
              supportsImage:Boolean(m.input?.includes("image")),reasoning:Boolean(m.reasoning),contextWindow:m.contextWindow,maxTokens:m.maxTokens,
              configured:h.modelRuntime.hasConfiguredAuth(m.provider),runtimeRegistered:true,isVirtual:m.api==="pi-virtual",source:"pi-runtime"});
            const remote=h.providerManager.getRemoteCatalog();
            for(const m of remote?.models??[]){const key=`${m.provider}/${m.id}`;if(!index.has(key))index.set(key,{...m,api:null,
              configured:h.modelRuntime.hasConfiguredAuth(m.provider),runtimeRegistered:false,isVirtual:false,source:"models.dev"});}
            const prefs=h.providerManager.getModelPreferences();const favoriteSet=new Set(prefs.favorites);const recentOrder=new Map(prefs.recent.map((ref,i)=>[ref,i]));
            const onlyFavorites=url.searchParams.get("favorites")==="1";const onlyRecent=url.searchParams.get("recent")==="1";
            const entries: Array<Record<string,unknown>>=[...index.values()].map(m=>({...m,favorite:favoriteSet.has(`${m["provider"]}/${m["id"]}`),recentlyUsedIndex:recentOrder.get(`${m["provider"]}/${m["id"]}`)??null}));
            const filtered=entries.filter(m=>(!onlyFavorites||m["favorite"]===true)&&(!onlyRecent||m["recentlyUsedIndex"]!==null)&&(!providerFilter||m["provider"]===providerFilter)&&
                (!q||`${m["provider"]} ${m["id"]} ${m["name"]} ${m["api"]??""}`.toLowerCase().includes(q)))
              .sort((a,b)=>(Number(a["recentlyUsedIndex"]??99999)-Number(b["recentlyUsedIndex"]??99999))||String(a["provider"]).localeCompare(String(b["provider"]))||String(a["id"]).localeCompare(String(b["id"])));
            const total=filtered.length;const models=filtered.slice(offset,offset+limit);
            this._sendJson(res,200,{models,total,offset,limit,hasMore:offset+models.length<total,favorites:prefs.favorites,
              recent:prefs.recent,remoteCatalog:remote?{source:"models.dev",refreshedAtMs:remote.refreshedAtMs,modelCount:remote.models.length,stale:Date.now()-remote.refreshedAtMs>7*24*60*60*1000}:null});return;
          }
        }

        // Ring 12 — provider inventory and custom compatible connections.
        if (pathname === "/api/providers") {
          const h = this.controller.getCurrentHarness();
          if (req.method === "GET") {
            const connections = h.providerManager.list();
            const connectionIds = new Set(connections.map(c => c.id));
            const providers = h.modelRuntime.getProviders().map(p => {
              const auth = h.modelRuntime.getProviderAuthStatus(p.id);
              return { id: p.id, name: p.name, modelCount: h.modelRuntime.getAllModels(p.id).length,
                configured: h.modelRuntime.hasConfiguredAuth(p.id), authSource: auth?.source ?? null,
                connection: connectionIds.has(p.id) };
            }).sort((a,b) => a.name.localeCompare(b.name));
            this._sendJson(res, 200, { providers, connections: connections.map(c => ({ ...c, apiKey: undefined })) });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req, 1_000_000);
            const action = String(body["action"] ?? "");
            if (action === "discover_custom") {
              const baseUrl = String(body["baseUrl"] ?? "");
              const apiKey = String(body["apiKey"] ?? "");
              try {
                const models = await h.providerManager.discoverOpenAICompatibleModels(baseUrl, apiKey);
                this._sendJson(res, 200, { models, source: "endpoint", capabilities: "unknown" });
              } catch (error) {
                const code = error instanceof Error ? error.message.split(":")[0] : "PROVIDER_DISCOVERY_FAILED";
                const status = code === "PROVIDER_KEY_REQUIRED_FOR_REMOTE_ENDPOINT" ? 400 : 502;
                this._sendJson(res, status, { error: code, message: code === "PROVIDER_KEY_REQUIRED_FOR_REMOTE_ENDPOINT" ? "An API key is required for remote endpoints." : "Could not safely discover models. You can enter a model ID manually instead." });
              }
              return;
            }
            if (action === "add_custom") {
              const connection = await h.providerManager.add({
                name: String(body["name"] ?? ""),
                adapter: body["adapter"] as "openai-compatible" | "anthropic-compatible",
                baseUrl: String(body["baseUrl"] ?? ""),
                apiKey: String(body["apiKey"] ?? ""),
                models: Array.isArray(body["models"]) ? (body["models"] as Array<{id:string;name?:string;input?:Array<"text"|"image">;reasoning?:boolean;contextWindow?:number;maxTokens?:number}>).map(m => ({ ...m, name: m.name ?? m.id })) : []
              });
              this.broadcastSse({ type: "provider_connection_added", providerId: connection.id });
              this._sendJson(res, 201, { connection, configured: true });
              return;
            }
            if(action==="one_shot_openrouter_test"){
              try {
                const apiKey=typeof body["apiKey"]==="string"?body["apiKey"]:"";
                const modelId=typeof body["modelId"]==="string"?body["modelId"]:"";
                const result=await h.providerManager.oneShotOpenRouterTest(apiKey,modelId);
                this._sendJson(res,200,result);
              } catch {
                // Do not reflect provider errors, request metadata, or credential material.
                this._sendJson(res,502,{error:"ONE_SHOT_PROVIDER_FAILED",message:"The one-time OpenRouter request failed. Check the model ID, key permissions, provider availability, and rate limits."});
              }
              return;
            }
            if(action==="begin_ephemeral_openrouter_session"){
              if(this.ephemeralOpenRouter){this._sendJson(res,409,{error:"EPHEMERAL_PROVIDER_SESSION_ACTIVE"});return;}
              const apiKey=typeof body["apiKey"]==="string"?body["apiKey"]:"";const modelId=typeof body["modelId"]==="string"?body["modelId"]:"";
              let registered:{providerId:string;modelId:string};
              try{registered=await h.providerManager.beginEphemeralOpenRouterSession(apiKey,modelId);}catch(error){const code=error instanceof Error?error.message:"";if(code==="ONE_SHOT_AUTH_REJECTED"){this._sendJson(res,401,{error:code,message:"OpenRouter rejected this key. It may be expired, revoked, or missing inference permission."});return;}if(code==="ONE_SHOT_FREE_MODEL_REQUIRED"){this._sendJson(res,400,{error:code,message:"Temporary chat tests accept only model IDs ending in :free."});return;}this._sendJson(res,502,{error:"EPHEMERAL_PROVIDER_SETUP_FAILED",message:"Could not validate the temporary provider. Check the model ID, key, and OpenRouter availability."});return;}
              const previousModel=h.session.model??h.modelRuntime.getModel("apex","auto");const model=h.modelRuntime.getModel(registered.providerId,registered.modelId);
              if(!model){h.providerManager.endEphemeralOpenRouterSession(registered.providerId);this._sendJson(res,400,{error:"EPHEMERAL_PROVIDER_SETUP_FAILED"});return;}
              try{await h.session.setModel(model);}catch{h.providerManager.endEphemeralOpenRouterSession(registered.providerId);this._sendJson(res,400,{error:"EPHEMERAL_PROVIDER_SETUP_FAILED"});return;}
              const expiresAtMs=Date.now()+5*60_000;const timer=setTimeout(()=>{if(this.ephemeralOpenRouter?.providerId===registered.providerId){h.session.abort();void this.endEphemeralOpenRouterSession();}},5*60_000);timer.unref();
              this.ephemeralOpenRouter={providerId:registered.providerId,modelId:registered.modelId,previousModel,turns:0,expiresAtMs,timer};
              this.broadcastSse({type:"ephemeral_provider_session_started",providerId:registered.providerId,modelId:registered.modelId,expiresAtMs});
              this._sendJson(res,200,{ok:true,providerId:registered.providerId,modelId:registered.modelId,expiresAtMs,maxTurns:3,keyPersisted:false});return;
            }
            if(action==="end_ephemeral_openrouter_session"){
              if(!this.ephemeralOpenRouter){this._sendJson(res,200,{ok:true,active:false});return;}
              await this.endEphemeralOpenRouterSession();this._sendJson(res,200,{ok:true,active:false});return;
            }
            if(action==="test_connection"){
              const id=String(body["id"]??"");const result=await h.providerManager.testConnection(id);this._sendJson(res,200,result);return;
            }
            if(action==="set_enabled"){
              const id=String(body["id"]??"");if(typeof body["enabled"]!=="boolean"){this._sendJson(res,400,{error:"PROVIDER_ENABLED_FLAG_REQUIRED"});return;}
              await h.providerManager.setEnabled(id,body["enabled"]);this.broadcastSse({type:"provider_connection_toggled",providerId:id,enabled:body["enabled"]});this._sendJson(res,200,{ok:true,id,enabled:body["enabled"]});return;
            }
            if (action === "remove_connection") {
              const id = String(body["id"] ?? "");
              await h.providerManager.remove(id);
              this.broadcastSse({ type: "provider_connection_removed", providerId: id });
              this._sendJson(res, 200, { ok: true, id });
              return;
            }
            this._sendJson(res, 400, { error: "PROVIDER_ACTION_UNSUPPORTED" });
            return;
          }
        }

        // 21. Ring 6 Cockpit v2 — Provider, Local Ollama & `apex/auto` Router Control (`/api/models`)
        if (pathname === "/api/models") {
          if (req.method === "GET") {
            const available = h.modelRuntime.getAvailableSnapshot();
            const apexAuto = h.modelRuntime.getModel("apex", "auto");
            const ollamaModels = h.modelRuntime.getModels("ollama");
            const customConnectionModels = h.providerManager.list().flatMap(c => h.modelRuntime.getModels(c.id));
            const seen = new Set<string>();
            const catalog: Array<{ provider: string; id: string; name: string; isVirtual: boolean; supportsImage: boolean }> = [];
            for (const m of [...(apexAuto ? [apexAuto] : []), ...ollamaModels, ...customConnectionModels, ...available]) {
              const key = `${m.provider}/${m.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              catalog.push({
                provider: m.provider,
                id: m.id,
                name: m.name,
                isVirtual: m.api === "pi-virtual",
                supportsImage: Boolean(m.input?.includes("image"))
              });
            }
            const usage = computeSessionUsageTelemetry(
              h.session.state.messages as ReadonlyArray<{ role?: string }>
            );
            this._sendJson(res, 200, {
              activeModel: h.session.model
                ? `${h.session.model.provider}/${h.session.model.id}`
                : "none",
              thinkingLevel: h.session.thinkingLevel,
              autoTargets: h.routerController.getAutoTargets(),
              routeHistory: h.routerController.getRouteHistory(),
              usage,
              models: catalog.slice(0, 60)
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "");
            if (action === "set_api_key") {
              const provider = String(body["provider"] ?? "").trim();
              const apiKey = String(body["apiKey"] ?? "").trim();
              if (!provider || !apiKey) {
                this._sendJson(res, 400, { error: "provider and apiKey are required." });
                return;
              }
              await h.onboardingVault.saveProviderKey(provider, apiKey);
              this.broadcastSse({ type: "cockpit_refresh", reason: "api_key_configured", provider });
              this._sendJson(res, 200, { ok: true, provider });
              return;
            }
            if (action === "register_ollama") {
              const modelId = String(body["modelId"] ?? "qwen2.5-coder:32b").trim();
              const baseUrl =
                typeof body["baseUrl"] === "string" && body["baseUrl"].trim()
                  ? body["baseUrl"].trim()
                  : undefined;
              const reg = await h.routerController.registerLocalOllamaProvider({
                baseUrl,
                models: [{ id: modelId }]
              });
              const m = h.modelRuntime.getModel(reg.providerId, modelId);
              if (m && body["activate"] !== false) {
                await h.session.setModel(m);
              }
              this.broadcastSse({ type: "cockpit_refresh", reason: "ollama_registered" });
              this._sendJson(res, 200, {
                ...reg,
                activeModel: h.session.model
                  ? `${h.session.model.provider}/${h.session.model.id}`
                  : "none"
              });
              return;
            }
            if(action==="set_favorite"){
              const provider=String(body["provider"]??"");const modelId=String(body["modelId"]??"");const favorite=body["favorite"]===true;
              const result=h.providerManager.setFavorite(`${provider}/${modelId}`,favorite);this._sendJson(res,200,result);return;
            }
            if (action === "set_thinking_level") {
              const requested = String(body["thinkingLevel"] ?? "");
              const allowed = ["low", "medium", "high", "max"];
              if (!allowed.includes(requested)) { this._sendJson(res, 400, { error: "THINKING_LEVEL_INVALID" }); return; }
              h.session.setThinkingLevel(requested as "low" | "medium" | "high" | "max");
              const effective = h.session.thinkingLevel;
              this.broadcastSse({ type: "cockpit_refresh", reason: "thinking_level_changed", requested, effective });
              this._sendJson(res, 200, { requested, effective });
              return;
            }
            if (action === "set_model") {
              const provider = String(body["provider"] ?? "").trim();
              const modelId = String(body["modelId"] ?? "").trim();
              const target = h.modelRuntime.getModel(provider, modelId);
              if (!target) {
                this._sendJson(res, 404, { error: `Model '${provider}/${modelId}' not found in catalog.` });
                return;
              }
              await h.session.setModel(target);
              h.providerManager.recordRecent(`${provider}/${modelId}`);
              this.broadcastSse({
                type: "cockpit_refresh",
                reason: "model_switched",
                activeModel: `${provider}/${modelId}`
              });
              this._sendJson(res, 200, { activeModel: `${provider}/${modelId}` });
              return;
            }
            if (action === "configure_auto") {
              const pProv = String(body["planningProvider"] ?? "").trim();
              const pId = String(body["planningModelId"] ?? "").trim();
              const iProv = String(body["implementationProvider"] ?? "").trim();
              const iId = String(body["implementationModelId"] ?? "").trim();
              const updated = h.routerController.configureAutoTargets({
                planningModel: pProv && pId ? { provider: pProv, id: pId } : undefined,
                implementationModel: iProv && iId ? { provider: iProv, id: iId } : undefined
              });
              this._sendJson(res, 200, { autoTargets: updated });
              return;
            }
            this._sendJson(res, 400, { error: `Unknown /api/models action '${action}'.` });
            return;
          }
        }

        // 22. Ring 6 Cockpit v2 — Confined `@earendil-works/pi-mcp` Control (`/api/mcp`)
        if (pathname === "/api/mcp") {
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              workspaceTrusted: h.mcpHub.isWorkspaceTrusted(),
              restoreIssues: h.mcpHub.listRestoreIssues(),
              servers: h.mcpHub.listServers(),
              tools: h.mcpHub.listTools({ includePoisoned: true })
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "");
            if (action === "connect_stdio") {
              const name = String(body["name"] ?? "").trim();
              const command = String(body["command"] ?? "").trim();
              const args = Array.isArray(body["args"]) ? body["args"].map(String) : [];
              if (!name || !command) {
                this._sendJson(res, 400, { error: "name and command are required." });
                return;
              }
              const summary = await h.mcpHub.connectStdioServer({
                name,
                command,
                args,
                source: "operator"
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "mcp_connected", name });
              this._sendJson(res, 200, { summary });
              return;
            }
            if (action === "connect_http") {
              const name = String(body["name"] ?? "").trim();
              const url = String(body["url"] ?? "").trim();
              if (!name || !url) {
                this._sendJson(res, 400, { error: "name and url are required." });
                return;
              }
              const summary = await h.mcpHub.connectHttpServer({
                name,
                url,
                source: "operator"
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "mcp_connected", name });
              this._sendJson(res, 200, { summary });
              return;
            }
            if (action === "disconnect") {
              const name = String(body["name"] ?? "").trim();
              const removed = await h.mcpHub.disconnectServer(name);
              this.broadcastSse({ type: "cockpit_refresh", reason: "mcp_disconnected", name });
              this._sendJson(res, 200, { name, removed });
              return;
            }
            if (action === "call_tool") {
              const serverName = String(body["serverName"] ?? "").trim();
              const toolName = String(body["toolName"] ?? "").trim();
              const args =
                typeof body["args"] === "object" && body["args"] !== null
                  ? (body["args"] as Record<string, unknown>)
                  : {};
              const result = await h.mcpHub.callTool({ serverName, toolName, args });
              this._sendJson(res, 200, result);
              return;
            }
            if (action === "list_resources") {
              const serverName = String(body["serverName"] ?? "").trim();
              const resources = await h.mcpHub.listResources(serverName);
              this._sendJson(res, 200, { serverName, resources });
              return;
            }
            this._sendJson(res, 400, { error: `Unknown /api/mcp action '${action}'.` });
            return;
          }
        }

        // 23. Ring 7 & Ring 8 — Autonomous 6-Stage Issue-to-PR Pipeline (`/api/pr-pipeline`)
        if (pathname === "/api/pr-pipeline") {
          if (req.method === "GET") {
            const activeWs = this._getWorkspaceRoot();
            const runs = h.prPipeline.listRuns().map((r) => {
              let markdown = "";
              const mdAbs = path.join(activeWs, r.prMarkdownRelPath);
              if (fs.existsSync(mdAbs)) {
                try {
                  markdown = fs.readFileSync(mdAbs, "utf8");
                } catch {
                  // ignore
                }
              }
              return { ...r, markdown, ghCommand: r.ghPrCommand };
            });
            this._sendJson(res, 200, { runs });
            return;
          }
          if (req.method === "POST") {
            if (h.prPipeline.getSandboxMode() === "read-only") {
              this._sendJson(
                res,
                403,
                { error: "READ_ONLY_SANDBOX: PR pipeline execution is denied in read-only sandbox mode." },
                req
              );
              return;
            }
            const body = await readJsonBody(req);
            const title = String(body["title"] ?? "").trim();
            const githubIssueRef =
              typeof body["githubIssueRef"] === "string" && body["githubIssueRef"].trim()
                ? body["githubIssueRef"].trim()
                : undefined;
            const issueDescription = String(body["issueDescription"] ?? title).trim();
            if (!title && !githubIssueRef) {
              this._sendJson(res, 400, {
                error: "title or githubIssueRef is required to run AutonomousPrPipeline."
              });
              return;
            }
            const filePatches = Array.isArray(body["filePatches"])
              ? (body["filePatches"] as Array<Record<string, unknown>>).map((p) => ({
                  relPath: String(p["relPath"] ?? ""),
                  content: String(p["content"] ?? "")
                }))
              : undefined;
            const receipt = await h.prPipeline.run({
              title: title || undefined,
              issueDescription: issueDescription || undefined,
              githubIssueRef,
              githubApiBaseUrl:
                typeof body["githubApiBaseUrl"] === "string"
                  ? body["githubApiBaseUrl"]
                  : undefined,
              allowQuarantinedIssue: Boolean(body["allowQuarantinedIssue"]),
              liveLlm: Boolean(body["liveLlm"]),
              maxRepairAttempts:
                typeof body["maxRepairAttempts"] === "number"
                  ? body["maxRepairAttempts"]
                  : undefined,
              slug: typeof body["slug"] === "string" ? body["slug"] : undefined,
              scope: typeof body["scope"] === "string" ? body["scope"] : undefined,
              baseBranch: typeof body["baseBranch"] === "string" ? body["baseBranch"] : undefined,
              filePatches,
              testCommand:
                typeof body["testCommand"] === "string" && body["testCommand"].trim()
                  ? body["testCommand"].trim()
                  : undefined,
              keepFeatureBranchCheckedOut:
                typeof body["keepFeatureBranchCheckedOut"] === "boolean"
                  ? body["keepFeatureBranchCheckedOut"]
                  : true
            });
            this.broadcastSse({
              type: "cockpit_refresh",
              reason: "pr_pipeline_completed",
              prId: receipt.prId,
              status: receipt.status
            });
            this._sendJson(res, 200, receipt);
            return;
          }
        }

        // 24. Ring 7 Cockpit v3 — Focused Secret-Scrubbed Session Handoff (`POST /api/handoff`)
        if (req.method === "POST" && pathname === "/api/handoff") {
          const body = await readJsonBody(req);
          const goal = String(body["goal"] ?? "").trim();
          const switchNow = Boolean(body["switchNow"]);
          if (!goal) {
            this._sendJson(res, 400, { error: "goal is required for /api/handoff." });
            return;
          }
          const activeWs = this._getWorkspaceRoot();
          const brief = await h.handoffController.generateHandoffBrief({
            sessionManager: h.session.sessionManager,
            goal,
            trustArtifacts: h.trustArtifacts,
            modelRuntime: h.modelRuntime,
            model: h.session.model
          });
          const sessionDir =
            h.session.sessionManager.getSessionDir() ||
            path.join(activeWs, ".harness", "sessions");
          const created = h.handoffController.createChildHandoffSessionFile({
            cwd: activeWs,
            sessionDir,
            parentSessionFile: brief.parentSessionFile,
            brief
          });
          let switched = false;
          if (switchNow) {
            const sw = await this.controller.runtimeHost.switchSession(created.childSessionFile);
            this._bindSessionStream();
            switched = !sw.cancelled;
          }
          this.broadcastSse({
            type: "cockpit_refresh",
            reason: "session_handoff_created",
            childSessionId: created.childSessionId
          });
          this._sendJson(res, 200, {
            ...brief,
            childSessionId: created.childSessionId,
            childSessionFile: created.childSessionFile,
            switched
          });
          return;
        }

        // 25. Ring 7 Cockpit v3 — Zero-Prefix-Drift Named Presets & Bookmarks (`/api/presets`)
        if (pathname === "/api/presets") {
          if (req.method === "GET") {
            const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
              h.session.systemPrompt,
              h.session.agent.state.tools
            );
            this._sendJson(res, 200, {
              activePreset: h.presetController.getActivePreset()?.name ?? null,
              presets: h.presetController.listPresets(),
              bookmarks: h.bookmarkController.listBookmarks(h.session.sessionManager),
              livePrefixSha256
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "apply_preset");
            if (action === "apply_preset") {
              const name = String(body["name"] ?? "clear").trim();
              const applied = await h.presetController.applyPresetToSession(
                name,
                h.session,
                h.modelRuntime
              );
              const livePrefixSha256 = h.prefix.verifyInvariantBeforeRequest(
                h.session.systemPrompt,
                h.session.agent.state.tools
              );
              this.broadcastSse({
                type: "cockpit_refresh",
                reason: "preset_changed",
                activated: applied.activated
              });
              this._sendJson(res, 200, { ...applied, livePrefixSha256 });
              return;
            }
            if (action === "add_bookmark") {
              const label = typeof body["label"] === "string" ? body["label"] : undefined;
              const targetEntryId =
                typeof body["entryId"] === "string" ? body["entryId"] : undefined;
              const created = h.bookmarkController.addBookmark(
                h.session.sessionManager,
                label,
                targetEntryId
              );
              this.broadcastSse({ type: "cockpit_refresh", reason: "bookmark_added" });
              this._sendJson(res, 200, created);
              return;
            }
            if (action === "remove_bookmark") {
              const targetEntryId =
                typeof body["entryId"] === "string" ? body["entryId"] : undefined;
              const removed = h.bookmarkController.removeBookmark(
                h.session.sessionManager,
                targetEntryId
              );
              this.broadcastSse({ type: "cockpit_refresh", reason: "bookmark_removed" });
              this._sendJson(res, 200, { removed });
              return;
            }
            this._sendJson(res, 400, { error: `Unknown /api/presets action '${action}'.` });
            return;
          }
        }

        // 26. Ring 7 Cockpit v3 — Live Headless Chromium CDP & Virtual Browser Driver (`/api/browser`)
        if (pathname === "/api/browser") {
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              hasLocalChromium: h.browserController.hasLocalChromium(),
              isCdpActive: h.browserController.isCdpActive()
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "snapshot");
            const backend = body["backend"] === "virtual" ? "virtual" : "cdp";
            if (action === "navigate") {
              const url = String(body["url"] ?? "").trim();
              if (!url) {
                this._sendJson(res, 400, { error: "url is required for browser navigate." });
                return;
              }
              const nav =
                backend === "cdp"
                  ? await h.browserController.navigateCdp(url)
                  : await h.browserController.navigate(url);
              this._sendJson(res, 200, nav);
              return;
            }
            if (action === "snapshot") {
              const snap =
                backend === "cdp"
                  ? await h.browserController.snapshotCdp({ compact: true })
                  : h.browserController.snapshot({ compact: true });
              this._sendJson(res, 200, snap);
              return;
            }
            if (action === "click") {
              const ref = String(body["ref"] ?? "").trim();
              const out =
                backend === "cdp"
                  ? await h.browserController.clickCdp(ref)
                  : h.browserController.click(ref);
              this._sendJson(res, 200, out);
              return;
            }
            if (action === "fill") {
              const ref = String(body["ref"] ?? "").trim();
              const text = String(body["text"] ?? "");
              const out =
                backend === "cdp"
                  ? await h.browserController.fillCdp(ref, text)
                  : h.browserController.fill(ref, text);
              this._sendJson(res, 200, out);
              return;
            }
            if (action === "screenshot") {
              const img =
                backend === "cdp"
                  ? await h.browserController.screenshotCdp()
                  : h.browserController.screenshot();
              this._sendJson(res, 200, {
                backend,
                mimeType: img.mimeType,
                data: img.data
              });
              return;
            }
            if (action === "close_cdp") {
              await h.browserController.closeCdp();
              this._sendJson(res, 200, { closed: true });
              return;
            }
            this._sendJson(res, 400, { error: `Unknown /api/browser action '${action}'.` });
            return;
          }
        }

        // 27. Ring 7 Cockpit v3 — Multi-Repo Workspace Switcher (`/api/workspaces`)
        if (pathname === "/api/workspaces") {
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              activeWorkspaceRoot: this.controller.getActiveWorkspaceRoot(),
              workspaces: this.controller.listWorkspaces()
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "switch");
            const targetPath = String(body["workspaceRoot"] ?? "").trim();
            if (!targetPath) {
              this._sendJson(res, 400, { error: "workspaceRoot is required." });
              return;
            }
            if (action === "register") {
              const registered = this.controller.registerWorkspace(targetPath);
              this._sendJson(res, 200, {
                registered,
                workspaces: this.controller.listWorkspaces()
              });
              return;
            }
            if (action === "switch") {
              const sw = await this.controller.switchWorkspace(targetPath);
              this._bindSessionStream();
              this.broadcastSse({
                type: "cockpit_refresh",
                reason: "workspace_switched",
                workspaceRoot: sw.workspaceRoot
              });
              this._sendJson(res, 200, {
                ...sw,
                workspaces: this.controller.listWorkspaces()
              });
              return;
            }
            this._sendJson(res, 400, { error: `Unknown /api/workspaces action '${action}'.` });
            return;
          }
        }

        // 28. Ring 8 Cockpit v4 — Quarantine-Scanned GitHub Issue Bridge & Merge Conflicts (`/api/github-issue`)
        if (pathname === "/api/github-issue") {
          const activeWs = this._getWorkspaceRoot();
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              ingestions: h.issueBridge.listIngestions(),
              conflicts: findGitMergeConflicts(activeWs, {
                scanAllTrackedIfNoUnmergedIndex: true
              })
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const refOrUrl =
              typeof body["refOrUrl"] === "string" && body["refOrUrl"].trim()
                ? body["refOrUrl"].trim()
                : undefined;
            const inlineIssue =
              typeof body["inlineIssue"] === "object" && body["inlineIssue"] !== null
                ? (body["inlineIssue"] as GitHubIssuePayload)
                : undefined;
            const apiBaseUrl =
              typeof body["apiBaseUrl"] === "string" ? body["apiBaseUrl"] : undefined;
            const allowQuarantinedIssue = Boolean(body["allowQuarantinedIssue"]);
            const runPr = Boolean(body["runPr"]);

            const quarantined = await h.issueBridge.ingestIssue({
              refOrUrl,
              inlineIssue,
              apiBaseUrl,
              allowQuarantinedIssue
            });

            if (runPr) {
              const prReceipt = await h.prPipeline.run({
                title: `Resolve ${quarantined.repo}#${quarantined.number}: ${quarantined.title}`,
                issueDescription: quarantined.isolatedPromptEnvelope,
                liveLlm: Boolean(body["liveLlm"] ?? true),
                keepFeatureBranchCheckedOut: false
              });
              this.broadcastSse({
                type: "cockpit_refresh",
                reason: "github_issue_pr_completed",
                prId: prReceipt.prId
              });
              this._sendJson(res, 200, { quarantined, prReceipt });
              return;
            }

            this.broadcastSse({
              type: "cockpit_refresh",
              reason: "github_issue_ingested",
              ingestionId: quarantined.ingestionId
            });
            this._sendJson(res, 200, quarantined);
            return;
          }
        }

        // 29. Ring 8 Cockpit v4 — Personal SWE Eval & Prompt-Cache Benchmark Suite (`/api/bench`)
        if (pathname === "/api/bench") {
          const activeWs = this._getWorkspaceRoot();
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              benchmarks: listPersistedBenchmarks(activeWs)
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const compareExperienceAb =
              typeof body["compareExperienceAb"] === "boolean"
                ? body["compareExperienceAb"]
                : true;
            const report = await runPersonalSweBenchmarkSuite({
              surfacesTemplateDir: DEFAULT_SURFACES_TEMPLATE_DIR,
              persistWorkspaceRoot: activeWs,
              compareExperienceAb
            });
            this.broadcastSse({
              type: "cockpit_refresh",
              reason: "swe_benchmark_completed",
              benchId: report.benchId
            });
            this._sendJson(res, 200, report);
            return;
          }
        }

        // 30. Ring 9 Cockpit v5 — Omni-Channel Messaging Gateway (`/api/gateway`)
        if (pathname === "/api/gateway") {
          const gw = h.gateway;
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              status: gw.getStatusSummary(),
              allowedSenders: gw.listAllowedSenders(),
              approvals: gw.listApprovals(),
              recentMessages: gw.listRecentMessages(25),
              slackManifest: generateSlackAppManifest({
                slashCommands: h.registeredSlashCommands
              })
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "status");
            if (action === "issue_pair") {
              const platform = String(body["platform"] ?? "telegram") as GatewayPlatform;
              const token = gw.issuePairingCode(platform);
              this._sendJson(res, 200, token);
              return;
            }
            if (action === "pair_whatsapp_baileys") {
              const phone = typeof body["phoneE164"] === "string" ? body["phoneE164"] : undefined;
              const state = gw.initWhatsAppBaileysPairing(phone);
              this.broadcastSse({ type: "cockpit_refresh", reason: "whatsapp_baileys_updated" });
              this._sendJson(res, 200, state);
              return;
            }
            if (action === "send") {
              const receipt = await gw.send({
                platform: String(body["platform"] ?? "telegram") as GatewayPlatform,
                channelId: String(body["channelId"] ?? ""),
                text: String(body["text"] ?? "")
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "gateway_outbound_sent" });
              this._sendJson(res, 200, receipt);
              return;
            }
            if (action === "inbound") {
              const outcome = await gw.handleInbound({
                platform: String(body["platform"] ?? "telegram") as GatewayPlatform,
                senderId: String(body["senderId"] ?? ""),
                channelId: String(body["channelId"] ?? body["senderId"] ?? ""),
                text: String(body["text"] ?? ""),
                isGroup: Boolean(body["isGroup"]),
                mentionedBot: Boolean(body["mentionedBot"])
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "gateway_inbound_handled" });
              this._sendJson(res, 200, outcome);
              return;
            }
            if (action === "slack_manifest") {
              this._sendJson(
                res,
                200,
                generateSlackAppManifest({ slashCommands: h.registeredSlashCommands })
              );
              return;
            }
            throw new Error(`Unsupported /api/gateway action: '${action}'`);
          }
        }

        // 31. Ring 9 Cockpit v5 — Multi-Agent Persona Registry & Orchestrator (`/api/swarm`)
        if (pathname === "/api/swarm") {
          const orch = h.orchestrator;
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              personas: orch.listPersonas(),
              recentRuns: orch.getRecentRuns()
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "run");
            if (action === "save_persona") {
              const created = orch.saveCustomPersona({
                name: String(body["name"] ?? ""),
                description: String(body["description"] ?? ""),
                role: (body["role"] as "explore" | "plan" | "execute" | "verify" | "review") ?? "explore",
                systemPrompt: String(body["systemPrompt"] ?? "")
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "persona_saved" });
              this._sendJson(res, 200, created);
              return;
            }
            const topology = (body["topology"] ?? "debate") as
              | "dag"
              | "supervisor"
              | "debate"
              | "map_reduce";
            const run = await orch.runOrchestration({
              topology,
              goal: typeof body["goal"] === "string" ? body["goal"] : undefined,
              nodes: Array.isArray(body["nodes"])
                ? (body["nodes"] as unknown as DagNodeSpec[])
                : undefined,
              debatePersonas: Array.isArray(body["debatePersonas"])
                ? (body["debatePersonas"] as unknown[]).map(String)
                : undefined
            });
            this.broadcastSse({ type: "cockpit_refresh", reason: "swarm_completed" });
            this._sendJson(res, 200, run);
            return;
          }
        }

        // 32. Ring 9 Cockpit v5 — Quarantine-Scanned External Plugin Host (`/api/plugins`)
        if (pathname === "/api/plugins") {
          const host = h.pluginHost;
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              plugins: host.listPlugins()
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "list");
            if (action === "audit") {
              const report = host.auditPluginDirectory(String(body["sourceDir"] ?? ""));
              this._sendJson(res, 200, report);
              return;
            }
            if (action === "install" || action === "enable" || action === "disable" || action === "remove") {
              if (host.getSandboxMode() === "read-only") {
                this._sendJson(
                  res,
                  403,
                  { error: "READ_ONLY_SANDBOX: Plugin modifications are denied in read-only sandbox mode." },
                  req
                );
                return;
              }
            }
            if (action === "install") {
              const summary = await host.installAndLoadPlugin(String(body["sourceDir"] ?? ""), {
                allowCaution: Boolean(body["allowCaution"])
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "plugin_installed" });
              this._sendJson(res, 200, summary);
              return;
            }
            if (action === "disable") {
              const summary = host.disablePlugin(String(body["pluginId"] ?? ""));
              this.broadcastSse({ type: "cockpit_refresh", reason: "plugin_disabled" });
              this._sendJson(res, 200, summary);
              return;
            }
            if (action === "enable") {
              const summary = await host.enablePlugin(String(body["pluginId"] ?? ""));
              this.broadcastSse({ type: "cockpit_refresh", reason: "plugin_enabled" });
              this._sendJson(res, 200, summary);
              return;
            }
            if (action === "remove") {
              const result=host.removePlugin(String(body["pluginId"]??""));
              this.broadcastSse({type:"cockpit_refresh",reason:"plugin_removed",pluginId:result.id});
              this._sendJson(res,200,result);return;
            }
            if (action === "call_tool") {
              const out = await host.invokePluginTool(
                String(body["pluginId"] ?? ""),
                String(body["toolName"] ?? ""),
                typeof body["args"] === "object" && body["args"] !== null
                  ? (body["args"] as Record<string, unknown>)
                  : {}
              );
              this._sendJson(res, 200, out);
              return;
            }
            throw new Error(`Unsupported /api/plugins action: '${action}'`);
          }
        }

        // 33. Ring 9 Cockpit v5 — Hash-Chained Unified Self-Learning Ledger (`/api/ledger`)
        if (pathname === "/api/ledger") {
          const ledger = h.learningLedger;
          if (req.method === "GET") {
            this._sendJson(res, 200, {
              integrity: ledger.verifyIntegrity(),
              entries: ledger.listEntries({ limit: 50 })
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "verify");
            if (action === "verify") {
              this._sendJson(res, 200, ledger.verifyIntegrity());
              return;
            }
            if (action === "record") {
              const entry = ledger.recordLesson({
                sourceEvent: "manual_operator",
                kind: ((body["kind"] as string) ?? "experience_cue") as Exclude<
                  LearningEntryKind,
                  "tombstone"
                >,
                domain: typeof body["domain"] === "string" ? body["domain"] : "general",
                cue: String(body["cue"] ?? ""),
                lesson: String(body["lesson"] ?? ""),
                evidence: typeof body["evidence"] === "string" ? body["evidence"] : "cockpit",
                forbiddenPattern:
                  typeof body["forbiddenPattern"] === "string"
                    ? body["forbiddenPattern"]
                    : undefined,
                glob: typeof body["glob"] === "string" ? body["glob"] : undefined
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "ledger_entry_recorded" });
              this._sendJson(res, 200, entry);
              return;
            }
            if (action === "outcome") {
              const updated = ledger.recordOutcome(
                String(body["entryId"] ?? ""),
                Boolean(body["helped"])
              );
              this.broadcastSse({ type: "cockpit_refresh", reason: "ledger_outcome_recorded" });
              this._sendJson(res, 200, updated);
              return;
            }
            if (action === "rollback") {
              const rolled = ledger.rollbackEntry(
                String(body["entryId"] ?? ""),
                typeof body["reason"] === "string" ? body["reason"] : "cockpit rollback"
              );
              this.broadcastSse({ type: "cockpit_refresh", reason: "ledger_entry_rolled_back" });
              this._sendJson(res, 200, rolled);
              return;
            }
            if (action === "materialize") {
              const mat = ledger.materializeSurfaces({
                surfacesDir: DEFAULT_SURFACES_TEMPLATE_DIR
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "ledger_materialized" });
              this._sendJson(res, 200, mat);
              return;
            }
            throw new Error(`Unsupported /api/ledger action: '${action}'`);
          }
        }

        // 34. Ring 10 Studio v6 — 1-Click Provider, Local Ollama & Channel Onboarding Vault (`/api/onboarding`)
        if (pathname === "/api/onboarding") {
          const vault = h.onboardingVault;
          if (req.method === "GET") {
            this._sendJson(res, 200, vault.getVaultStatus());
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "status");
            if (action === "save_provider_key") {
              const saved = await vault.saveProviderKey(
                String(body["provider"] ?? ""),
                String(body["apiKey"] ?? "")
              );
              this.broadcastSse({ type: "cockpit_refresh", reason: "onboarding_key_saved" });
              this._sendJson(res, 200, { saved, status: vault.getVaultStatus() });
              return;
            }
            if (action === "remove_provider_key") {
              vault.removeProviderKey(String(body["provider"] ?? ""));
              this.broadcastSse({ type: "cockpit_refresh", reason: "onboarding_key_removed" });
              this._sendJson(res, 200, vault.getVaultStatus());
              return;
            }
            if (action === "discover_ollama") {
              const disc = await vault.discoverAndRegisterOllama({
                ollamaHostUrl:
                  typeof body["ollamaHostUrl"] === "string" && body["ollamaHostUrl"].trim()
                    ? body["ollamaHostUrl"].trim()
                    : undefined,
                bindApexAuto:
                  typeof body["bindApexAuto"] === "boolean" ? body["bindApexAuto"] : true
              });
              this.broadcastSse({ type: "cockpit_refresh", reason: "ollama_discovered" });
              this._sendJson(res, 200, { discovery: disc, status: vault.getVaultStatus() });
              return;
            }
            if (action === "save_channel_credentials") {
              const channels =
                typeof body["channels"] === "object" && body["channels"] !== null
                  ? (body["channels"] as Record<string, unknown>)
                  : {};
              const status = vault.saveChannelCredentials(channels);
              this.broadcastSse({ type: "cockpit_refresh", reason: "channel_credentials_saved" });
              this._sendJson(res, 200, status);
              return;
            }
            throw new Error(`Unsupported /api/onboarding action: '${action}'`);
          }
        }

        // 35. Ring 11 — Safe voice I/O, image-ready chat profile, and operator approval controls.
        if (pathname === "/api/speech") {
          if (req.method === "GET") { this._sendJson(res, 200, h.speechIo.getStatus()); return; }
          if (req.method === "POST") {
            const body = await readJsonBody(req, 12 * 1024 * 1024);
            const action = String(body["action"] ?? "");
            if (action === "transcribe") {
              const result = await h.speechIo.transcribe({ audioBase64: String(body["audioBase64"] ?? ""), mimeType: String(body["mimeType"] ?? ""), provider: body["provider"] === "local" ? "local" : "cloud" });
              this._sendJson(res, 200, result); return;
            }
            if (action === "synthesize") {
              const result = await h.speechIo.synthesize({ text: String(body["text"] ?? ""), voice: typeof body["voice"] === "string" ? body["voice"] : undefined, provider: body["provider"] === "local" ? "local" : "cloud" });
              this._sendJson(res, 200, result); return;
            }
            this._sendJson(res, 400, { error: "SPEECH_ACTION_INVALID" }); return;
          }
        }
        if (pathname === "/api/interaction") {
          const interaction = h.interactionController;
          if (req.method === "GET") { this._sendJson(res, 200, { ...interaction.getInteractionState(), personas: interaction.listPersonas() }); return; }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const action = String(body["action"] ?? "");
            if (action === "set_mode") {
              const mode = interaction.setMode(String(body["mode"] ?? "") as ExecutionMode);
              this.broadcastSse({ type: "interaction_mode_changed", mode });
              this._sendJson(res, 200, interaction.getInteractionState()); return;
            }
            if (action === "set_profile") {
              const state = interaction.setPersonaProfile(typeof body["persona"] === "string" ? body["persona"] : undefined, typeof body["buildProfile"] === "string" ? body["buildProfile"] : undefined);
              this.broadcastSse({ type: "interaction_profile_changed", ...state });
              this._sendJson(res, 200, interaction.getInteractionState()); return;
            }
            if (action === "resolve_approval") {
              const id = String(body["approvalId"] ?? "");
              const approved = interaction.resolveApproval(id, body["allow"] === true);
              if (!approved) { this._sendJson(res, 404, { error: "APPROVAL_NOT_PENDING" }); return; }
              this._sendJson(res, 200, interaction.getInteractionState()); return;
            }
            this._sendJson(res, 400, { error: "INTERACTION_ACTION_INVALID" }); return;
          }
        }

        this._sendJson(res, 404, { error: `Unknown endpoint: ${req.method} ${pathname}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._sendJson(res, 400, { error: msg });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.requestedPort, this.host, () => {
        const addr = this.server!.address() as AddressInfo;
        this.boundPort = addr.port;
        resolve();
      });
    });

    return {
      host: this.host,
      port: this.boundPort,
      url: `http://${this.host}:${this.boundPort}`,
      token: this.authToken
    };
  }

  async stop(): Promise<void> {
    await this.endEphemeralOpenRouterSession();
    this.controller.getCurrentHarness().interactionController.setApprovalConsumerAttached(false);
    this.unsubscribeHarnessSwitch?.();
    this.unsubscribeHarnessSwitch = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }
}
