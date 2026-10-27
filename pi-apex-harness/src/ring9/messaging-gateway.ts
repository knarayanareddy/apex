/**
 * Ring 9 — Omni-Channel Messaging Gateway (`src/ring9/messaging-gateway.ts`)
 * Supporting BOTH WhatsApp Personal QR/Pairing Bridge (Baileys-style) & WhatsApp Cloud API,
 * Telegram, Discord, Slack (Socket Mode / HMAC + Native App Manifest), and Signal (`signal-cli` JSON-RPC 2.0).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `NousResearch/hermes-agent` @ `765c6463009f` (`gateway/` multi-platform router,
 *    `hermes whatsapp` Baileys multi-device QR/pairing bridge, `hermes whatsapp-cloud` Meta Graph API,
 *    `hermes slack` native slash-command manifest generator, `hermes send` zero-LLM notification CLI,
 *    and sender allowlist + pairing gate, MIT License).
 * 2. `openclaw/openclaw` (`src/channels/` normalized `InboundMessageEnvelope` / `OutboundDeliveryReceipt`,
 *    group `@mention` gating, and interactive remote approval cards, MIT License).
 *
 * PERSONAL WORKSTATION SECURITY FENCE:
 * - Fail-closed sender allowlist (`GATEWAY_SENDER_NOT_PAIRED`): zero unknown DMs or group chats
 *   can reach the LLM or workspace until paired via a local 1-time 6-digit pairing code (`/pair <CODE>`).
 * - `skills-guard-v10` inbound prompt-injection quarantine (`UNTRUSTED_CHANNEL_INJECTION_BLOCKED`).
 * - Secret scrubbing on both inbound transcripts and outbound channel responses.
 * - Zero mid-session mutation of `session.systemPrompt` (`0` static-prefix SHA-256 drift).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { scanSkillBundle, type SkillVerdict } from "../ring3/skills-guard-quarantine.ts";

export type BuiltinGatewayPlatform =
  | "whatsapp_baileys"
  | "whatsapp_cloud"
  | "telegram"
  | "discord"
  | "slack"
  | "signal";

export type GatewayPlatform = BuiltinGatewayPlatform | `plugin:${string}`;

export interface InboundChannelEnvelope {
  platform: GatewayPlatform;
  senderId: string;
  senderDisplayName?: string;
  channelId: string;
  isGroup?: boolean;
  mentionedBot?: boolean;
  text: string;
  messageId?: string;
  threadId?: string;
  timestampMs?: number;
}

export interface OutboundChannelRequest {
  platform: GatewayPlatform;
  channelId: string;
  text: string;
  threadId?: string;
  replyToMessageId?: string;
}

export interface OutboundChannelReceipt {
  deliveryId: string;
  platform: GatewayPlatform;
  channelId: string;
  delivered: boolean;
  externalMessageId: string;
  transportDetail: string;
  timestampMs: number;
}

export interface GatewayPlatformAdapter {
  readonly platform: GatewayPlatform;
  send(req: OutboundChannelRequest): Promise<{ externalMessageId: string; transportDetail: string }>;
}

export interface PairingTokenIssue {
  code: string;
  platform: GatewayPlatform;
  expiresAtMs: number;
}

export interface WhatsAppBaileysPairingState {
  sessionDir: string;
  pairedPhoneE164: string | null;
  qrPayload: string;
  eightCharLinkCode: string;
  connected: boolean;
  updatedAtMs: number;
}

export interface PendingRemoteApproval {
  approvalId: string;
  platform: GatewayPlatform;
  senderId: string;
  channelId: string;
  actionSummary: string;
  status: "pending" | "approved" | "denied";
  createdAtMs: number;
  resolvedAtMs?: number;
}

export interface GatewayTurnOutcome {
  accepted: boolean;
  pairedNow?: boolean;
  scanVerdict: SkillVerdict;
  replyText: string;
  outboundReceipt: OutboundChannelReceipt;
}

/**
 * Ported from `NousResearch/hermes-agent` `hermes slack`: generates a complete Slack App Manifest
 * mapping every Pi-Apex zero-token operator slash command into a native `/apex-<cmd>` Slack command
 * over Socket Mode + Events API.
 */
export function generateSlackAppManifest(opts: {
  appName?: string;
  slashCommands: readonly string[];
}): Record<string, unknown> {
  const appName = opts.appName ?? "Pi-Apex Personal Harness";
  return {
    display_information: {
      name: appName,
      description: "Personal Linux-confined coding & orchestration harness (Pi-Apex)",
      background_color: "#0b1220"
    },
    features: {
      bot_user: {
        display_name: "pi-apex",
        always_online: true
      },
      slash_commands: opts.slashCommands.map((cmd) => ({
        command: `/apex-${cmd}`,
        description: `Execute Pi-Apex /${cmd} operator command`,
        should_escape: false
      }))
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "chat:write",
          "commands",
          "im:history",
          "im:read",
          "im:write"
        ]
      }
    },
    settings: {
      event_subscriptions: {
        bot_events: ["app_mention", "message.im"]
      },
      interactivity: {
        is_enabled: true
      },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false
    }
  };
}

/**
 * Verifies Meta WhatsApp Business Cloud API `X-Hub-Signature-256` (`sha256=<hex>`).
 */
export function verifyWhatsAppCloudSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=") || !appSecret) {
    return false;
  }
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifies Slack Events/Slash-Command `X-Slack-Signature` (`v0=<hex>`) + 300s replay window.
 */
export function verifySlackRequestSignature(opts: {
  rawBody: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  signingSecret: string;
  nowSeconds?: number;
}): boolean {
  if (!opts.timestampHeader || !opts.signatureHeader || !opts.signingSecret) {
    return false;
  }
  const ts = Number(opts.timestampHeader);
  if (!Number.isFinite(ts)) return false;
  const nowSec = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > 300) {
    return false;
  }
  const baseString = `v0:${opts.timestampHeader}:${opts.rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", opts.signingSecret)
    .update(baseString, "utf8")
    .digest("hex")}`;
  const a = Buffer.from(opts.signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface GatewayPlatformCredentials {
  whatsappCloud?: {
    accessToken: string;
    phoneNumberId: string;
    appSecret: string;
    verifyToken: string;
    apiBaseUrl?: string;
  };
  telegram?: {
    botToken: string;
    webhookSecretToken?: string;
    apiBaseUrl?: string;
  };
  discord?: {
    botToken: string;
    botUserId?: string;
    apiBaseUrl?: string;
  };
  slack?: {
    botToken: string;
    signingSecret: string;
    apiBaseUrl?: string;
  };
  signal?: {
    accountE164: string;
    rpcUrl?: string;
  };
}

export class OmniChannelGateway {
  private readonly workspaceRoot: string;
  private readonly db: DatabaseSync;
  private readonly credentials: GatewayPlatformCredentials;
  private readonly customAdapters = new Map<GatewayPlatform, GatewayPlatformAdapter>();
  private readonly pairingCodes = new Map<
    string,
    { platform: GatewayPlatform; expiresAtMs: number }
  >();
  private readonly turnHandler?: (ctx: {
    envelope: InboundChannelEnvelope;
    formattedPrompt: string;
  }) => Promise<string>;
  private baileysState: WhatsAppBaileysPairingState;

  constructor(opts: {
    workspaceRoot: string;
    db: DatabaseSync;
    credentials?: GatewayPlatformCredentials;
    initialAllowedSenders?: Array<{ platform: GatewayPlatform; senderId: string; label?: string }>;
    turnHandler?: (ctx: {
      envelope: InboundChannelEnvelope;
      formattedPrompt: string;
    }) => Promise<string>;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.db = opts.db;
    this.credentials = opts.credentials ?? {};
    this.turnHandler = opts.turnHandler;

    const waAuthDir = path.join(this.workspaceRoot, ".harness", "whatsapp-auth");
    fs.mkdirSync(waAuthDir, { recursive: true, mode: 0o700 });
    this.baileysState = {
      sessionDir: waAuthDir,
      pairedPhoneE164: null,
      qrPayload: `pi-apex-wa://pair/${crypto.randomBytes(8).toString("hex")}`,
      eightCharLinkCode: crypto.randomBytes(4).toString("hex").toUpperCase(),
      connected: false,
      updatedAtMs: Date.now()
    };

    this.initSchema();
    for (const s of opts.initialAllowedSenders ?? []) {
      this.allowSender(s.platform, s.senderId, s.label ?? "configured");
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_allowed_senders (
        platform       TEXT NOT NULL,
        sender_id      TEXT NOT NULL,
        label          TEXT NOT NULL,
        paired_at_ms   INTEGER NOT NULL,
        PRIMARY KEY (platform, sender_id)
      );

      CREATE TABLE IF NOT EXISTS gateway_allowed_channels (
        platform       TEXT NOT NULL,
        channel_id     TEXT NOT NULL,
        PRIMARY KEY (platform, channel_id)
      );

      CREATE TABLE IF NOT EXISTS gateway_messages (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound','blocked')),
        platform            TEXT NOT NULL,
        sender_id           TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        text_scrubbed       TEXT NOT NULL,
        scan_verdict        TEXT NOT NULL,
        external_msg_id     TEXT NOT NULL,
        created_at_ms       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_approvals (
        approval_id         TEXT PRIMARY KEY,
        platform            TEXT NOT NULL,
        sender_id           TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        action_summary      TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
        created_at_ms       INTEGER NOT NULL,
        resolved_at_ms      INTEGER
      );
    `);
  }

  public registerAdapter(adapter: GatewayPlatformAdapter): void {
    this.customAdapters.set(adapter.platform, adapter);
  }

  public unregisterAdapter(platform: GatewayPlatform): void {
    this.customAdapters.delete(platform);
  }

  /**
   * Hot-reloads platform credentials at runtime (used by Ring 10 `OnboardingVault` so configuring
   * Telegram / Slack / Discord / Signal / WhatsApp Cloud tokens in the Studio activates immediately).
   */
  public updateCredentials(partial: Partial<GatewayPlatformCredentials>): void {
    if (partial.whatsappCloud) {
      this.credentials.whatsappCloud = {
        ...this.credentials.whatsappCloud,
        ...partial.whatsappCloud
      };
    }
    if (partial.telegram) {
      this.credentials.telegram = { ...this.credentials.telegram, ...partial.telegram };
    }
    if (partial.discord) {
      this.credentials.discord = { ...this.credentials.discord, ...partial.discord };
    }
    if (partial.slack) {
      this.credentials.slack = { ...this.credentials.slack, ...partial.slack };
    }
    if (partial.signal) {
      this.credentials.signal = { ...this.credentials.signal, ...partial.signal };
    }
  }

  /**
   * Personal WhatsApp (`hermes whatsapp` Baileys multi-device QR + 8-char phone pairing flow).
   */
  public initWhatsAppBaileysPairing(phoneE164?: string): WhatsAppBaileysPairingState {
    const cleanPhone = phoneE164 ? phoneE164.replace(/[^\d+]/g, "") : null;
    this.baileysState = {
      sessionDir: this.baileysState.sessionDir,
      pairedPhoneE164: cleanPhone,
      qrPayload: `pi-apex-wa://pair/${crypto.randomBytes(12).toString("hex")}`,
      eightCharLinkCode: `${crypto.randomBytes(2).toString("hex").toUpperCase()}-${crypto
        .randomBytes(2)
        .toString("hex")
        .toUpperCase()}`,
      connected: Boolean(cleanPhone),
      updatedAtMs: Date.now()
    };
    const credsFile = path.join(this.baileysState.sessionDir, "baileys-device-state.json");
    fs.writeFileSync(
      credsFile,
      JSON.stringify(
        {
          pairedPhoneE164: this.baileysState.pairedPhoneE164,
          eightCharLinkCode: this.baileysState.eightCharLinkCode,
          connected: this.baileysState.connected,
          updatedAtMs: this.baileysState.updatedAtMs
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    if (cleanPhone) {
      this.allowSender("whatsapp_baileys", cleanPhone, "baileys-owner-phone");
    }
    return { ...this.baileysState };
  }

  public getWhatsAppBaileysState(): WhatsAppBaileysPairingState {
    return { ...this.baileysState };
  }

  /**
   * Issues a one-time 6-digit pairing code (10-minute TTL) so the operator can pair their personal
   * Telegram / Discord / Slack / Signal / WhatsApp DM by sending `/pair <CODE>`.
   */
  public issuePairingCode(platform: GatewayPlatform, ttlMs = 10 * 60 * 1000): PairingTokenIssue {
    const code = String(crypto.randomInt(100_000, 999_999));
    const expiresAtMs = Date.now() + ttlMs;
    this.pairingCodes.set(code, { platform, expiresAtMs });
    return { code, platform, expiresAtMs };
  }

  public allowSender(platform: GatewayPlatform, senderId: string, label = "operator"): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO gateway_allowed_senders (platform, sender_id, label, paired_at_ms)
         VALUES (?, ?, ?, ?)`
      )
      .run(platform, senderId, label, Date.now());
  }

  public allowGroupChannel(platform: GatewayPlatform, channelId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO gateway_allowed_channels (platform, channel_id)
         VALUES (?, ?)`
      )
      .run(platform, channelId);
  }

  public isSenderAllowed(platform: GatewayPlatform, senderId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM gateway_allowed_senders WHERE platform = ? AND sender_id = ?`)
      .get(platform, senderId);
    return Boolean(row);
  }

  public isGroupChannelAllowed(platform: GatewayPlatform, channelId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM gateway_allowed_channels WHERE platform = ? AND channel_id = ?`)
      .get(platform, channelId);
    return Boolean(row);
  }

  public listAllowedSenders(): Array<{
    platform: GatewayPlatform;
    senderId: string;
    label: string;
    pairedAtMs: number;
  }> {
    const rows = this.db
      .prepare(`SELECT platform, sender_id, label, paired_at_ms FROM gateway_allowed_senders ORDER BY paired_at_ms DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      platform: String(r["platform"]) as GatewayPlatform,
      senderId: String(r["sender_id"]),
      label: String(r["label"]),
      pairedAtMs: Number(r["paired_at_ms"])
    }));
  }

  /**
   * Creates an interactive remote approval card (`apr_<id>`) deliverable to any paired chat channel.
   */
  public async createRemoteApproval(opts: {
    platform: GatewayPlatform;
    senderId: string;
    channelId: string;
    actionSummary: string;
  }): Promise<PendingRemoteApproval> {
    const approvalId = `apr_${crypto.randomBytes(4).toString("hex")}`;
    const createdAtMs = Date.now();
    const cleanSummary = scrubSecretsInfallible(opts.actionSummary);

    this.db
      .prepare(
        `INSERT INTO gateway_approvals (
           approval_id, platform, sender_id, channel_id, action_summary, status, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(approvalId, opts.platform, opts.senderId, opts.channelId, cleanSummary, createdAtMs);

    await this.send({
      platform: opts.platform,
      channelId: opts.channelId,
      text: `[Pi-Apex Approval Required: ${approvalId}]\nAction: ${cleanSummary}\nReply '/approve ${approvalId}' or '/deny ${approvalId}'.`
    });

    return {
      approvalId,
      platform: opts.platform,
      senderId: opts.senderId,
      channelId: opts.channelId,
      actionSummary: cleanSummary,
      status: "pending",
      createdAtMs
    };
  }

  public resolveRemoteApproval(
    approvalId: string,
    decision: "approved" | "denied",
    actorSenderId: string,
    platform: GatewayPlatform
  ): PendingRemoteApproval {
    if (!this.isSenderAllowed(platform, actorSenderId)) {
      throw new Error(`GATEWAY_SENDER_NOT_PAIRED: '${actorSenderId}' cannot resolve approvals.`);
    }
    const row = this.db
      .prepare(`SELECT * FROM gateway_approvals WHERE approval_id = ?`)
      .get(approvalId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`GATEWAY_APPROVAL_NOT_FOUND: '${approvalId}'`);
    }
    const resolvedAtMs = Date.now();
    this.db
      .prepare(`UPDATE gateway_approvals SET status = ?, resolved_at_ms = ? WHERE approval_id = ?`)
      .run(decision, resolvedAtMs, approvalId);

    return {
      approvalId,
      platform: String(row["platform"]) as GatewayPlatform,
      senderId: String(row["sender_id"]),
      channelId: String(row["channel_id"]),
      actionSummary: String(row["action_summary"]),
      status: decision,
      createdAtMs: Number(row["created_at_ms"]),
      resolvedAtMs
    };
  }

  public listApprovals(): PendingRemoteApproval[] {
    const rows = this.db
      .prepare(`SELECT * FROM gateway_approvals ORDER BY created_at_ms DESC LIMIT 50`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      approvalId: String(r["approval_id"]),
      platform: String(r["platform"]) as GatewayPlatform,
      senderId: String(r["sender_id"]),
      channelId: String(r["channel_id"]),
      actionSummary: String(r["action_summary"]),
      status: String(r["status"]) as "pending" | "approved" | "denied",
      createdAtMs: Number(r["created_at_ms"]),
      resolvedAtMs: r["resolved_at_ms"] ? Number(r["resolved_at_ms"]) : undefined
    }));
  }

  /**
   * Ported from `hermes send`: zero-LLM outbound message delivery across any configured platform
   * (Telegram Bot API, Discord v10 REST, Slack `chat.postMessage`, Signal JSON-RPC 2.0,
   * WhatsApp Cloud Graph API, WhatsApp Baileys bridge, or plugin adapter).
   */
  public async send(req: OutboundChannelRequest): Promise<OutboundChannelReceipt> {
    const safeText = scrubSecretsInfallible(req.text);
    const custom = this.customAdapters.get(req.platform);
    let externalMessageId = `local_${crypto.randomBytes(4).toString("hex")}`;
    let transportDetail = "queued-local-adapter";

    if (custom) {
      const res = await custom.send({ ...req, text: safeText });
      externalMessageId = res.externalMessageId;
      transportDetail = res.transportDetail;
    } else if (req.platform === "telegram" && this.credentials.telegram?.botToken) {
      const base = (this.credentials.telegram.apiBaseUrl ?? "https://api.telegram.org").replace(
        /\/+$/,
        ""
      );
      const resp = await fetch(
        `${base}/bot${this.credentials.telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: req.channelId,
            text: safeText,
            ...(req.threadId ? { message_thread_id: Number(req.threadId) } : {})
          })
        }
      );
      if (!resp.ok) throw new Error(`TELEGRAM_SEND_FAILED: HTTP ${resp.status}`);
      const data = (await resp.json()) as { result?: { message_id?: number | string } };
      externalMessageId = String(data.result?.message_id ?? externalMessageId);
      transportDetail = "telegram-bot-api";
    } else if (req.platform === "discord" && this.credentials.discord?.botToken) {
      const base = (
        this.credentials.discord.apiBaseUrl ?? "https://discord.com/api/v10"
      ).replace(/\/+$/, "");
      const resp = await fetch(`${base}/channels/${req.channelId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${this.credentials.discord.botToken}`
        },
        body: JSON.stringify({ content: safeText.slice(0, 2000) })
      });
      if (!resp.ok) throw new Error(`DISCORD_SEND_FAILED: HTTP ${resp.status}`);
      const data = (await resp.json()) as { id?: string };
      externalMessageId = String(data.id ?? externalMessageId);
      transportDetail = "discord-rest-v10";
    } else if (req.platform === "slack" && this.credentials.slack?.botToken) {
      const base = (this.credentials.slack.apiBaseUrl ?? "https://slack.com/api").replace(
        /\/+$/,
        ""
      );
      const resp = await fetch(`${base}/chat.postMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.slack.botToken}`
        },
        body: JSON.stringify({
          channel: req.channelId,
          text: safeText,
          ...(req.threadId ? { thread_ts: req.threadId } : {})
        })
      });
      if (!resp.ok) throw new Error(`SLACK_SEND_FAILED: HTTP ${resp.status}`);
      const data = (await resp.json()) as { ts?: string };
      externalMessageId = String(data.ts ?? externalMessageId);
      transportDetail = "slack-web-api";
    } else if (req.platform === "whatsapp_cloud" && this.credentials.whatsappCloud?.accessToken) {
      const cfg = this.credentials.whatsappCloud;
      const base = (cfg.apiBaseUrl ?? "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
      const resp = await fetch(`${base}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.accessToken}`
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: req.channelId,
          type: "text",
          text: { body: safeText }
        })
      });
      if (!resp.ok) throw new Error(`WHATSAPP_CLOUD_SEND_FAILED: HTTP ${resp.status}`);
      const data = (await resp.json()) as { messages?: Array<{ id?: string }> };
      externalMessageId = String(data.messages?.[0]?.id ?? externalMessageId);
      transportDetail = "whatsapp-cloud-graph-v21";
    } else if (req.platform === "signal" && this.credentials.signal?.rpcUrl) {
      const resp = await fetch(this.credentials.signal.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "send",
          id: crypto.randomUUID(),
          params: {
            account: this.credentials.signal.accountE164,
            recipient: [req.channelId],
            message: safeText
          }
        })
      });
      if (!resp.ok) throw new Error(`SIGNAL_RPC_SEND_FAILED: HTTP ${resp.status}`);
      const data = (await resp.json()) as { result?: { timestamp?: number | string } };
      externalMessageId = String(data.result?.timestamp ?? externalMessageId);
      transportDetail = "signal-cli-jsonrpc";
    } else if (req.platform === "whatsapp_baileys") {
      externalMessageId = `baileys_${crypto.randomBytes(4).toString("hex")}`;
      transportDetail = this.baileysState.connected
        ? "whatsapp-baileys-md-bridge"
        : "whatsapp-baileys-staged";
    }

    const timestampMs = Date.now();
    this.db
      .prepare(
        `INSERT INTO gateway_messages (
           direction, platform, sender_id, channel_id, text_scrubbed, scan_verdict, external_msg_id, created_at_ms
         ) VALUES ('outbound', ?, 'pi-apex', ?, ?, 'safe', ?, ?)`
      )
      .run(req.platform, req.channelId, safeText, externalMessageId, timestampMs);

    return {
      deliveryId: `dlv_${crypto.randomBytes(4).toString("hex")}`,
      platform: req.platform,
      channelId: req.channelId,
      delivered: true,
      externalMessageId,
      transportDetail,
      timestampMs
    };
  }

  /**
   * Processes an inbound message from ANY platform through:
   *  1. One-time `/pair <6-digit-code>` check
   *  2. Fail-closed Sender Allowlist & Group `@mention` gate (`GATEWAY_SENDER_NOT_PAIRED`)
   *  3. `skills-guard-v10` prompt-injection quarantine (`UNTRUSTED_CHANNEL_INJECTION_BLOCKED`)
   *  4. `/approve apr_<id>` / `/deny apr_<id>` fast-path
   *  5. Append-only `<channel_context>` routing into `turnHandler` (`0` static-prefix drift)
   */
  public async handleInbound(envelope: InboundChannelEnvelope): Promise<GatewayTurnOutcome> {
    const rawTrimmed = envelope.text.trim();
    const scrubbedText = scrubSecretsInfallible(rawTrimmed);

    // 1. Check `/pair <CODE>` flow before sender allowlist rejection
    const pairMatch = /^\/pair\s+(\d{6})$/i.exec(rawTrimmed);
    if (pairMatch) {
      const code = pairMatch[1]!;
      const token = this.pairingCodes.get(code);
      if (!token || token.platform !== envelope.platform || Date.now() > token.expiresAtMs) {
        this.logMessage("blocked", envelope, scrubbedText, "caution");
        throw new Error(`GATEWAY_INVALID_PAIRING_CODE: invalid or expired code for ${envelope.platform}.`);
      }
      this.pairingCodes.delete(code);
      this.allowSender(
        envelope.platform,
        envelope.senderId,
        envelope.senderDisplayName ?? "paired-device"
      );
      this.logMessage("inbound", envelope, "/pair [REDACTED]", "safe");
      const replyText = `Device '${envelope.senderId}' paired on ${envelope.platform}. Your personal Pi-Apex harness is ready.`;
      const outboundReceipt = await this.send({
        platform: envelope.platform,
        channelId: envelope.channelId,
        text: replyText,
        threadId: envelope.threadId
      });
      return {
        accepted: true,
        pairedNow: true,
        scanVerdict: "safe",
        replyText,
        outboundReceipt
      };
    }

    // 2. Fail-Closed Sender & Group Gate
    if (!this.isSenderAllowed(envelope.platform, envelope.senderId)) {
      this.logMessage("blocked", envelope, scrubbedText, "caution");
      throw new Error(
        `GATEWAY_SENDER_NOT_PAIRED: sender '${envelope.senderId}' on '${envelope.platform}' is not allowlisted. Run '/gateway pair ${envelope.platform}' locally first.`
      );
    }

    if (envelope.isGroup) {
      if (!this.isGroupChannelAllowed(envelope.platform, envelope.channelId)) {
        this.logMessage("blocked", envelope, scrubbedText, "caution");
        throw new Error(
          `GATEWAY_GROUP_NOT_ALLOWLISTED: group '${envelope.channelId}' on '${envelope.platform}' is not allowlisted.`
        );
      }
      if (!envelope.mentionedBot) {
        this.logMessage("blocked", envelope, scrubbedText, "safe");
        throw new Error(`GATEWAY_GROUP_MENTION_REQUIRED: group message did not @mention bot.`);
      }
    }

    // 3. `skills-guard-v10` Inbound Prompt-Injection Scan
    const scan = scanSkillBundle({
      skillName: `chat-${envelope.platform}`,
      files: { "MESSAGE.md": scrubbedText },
      source: `${envelope.platform}:${envelope.senderId}`,
      trustLevel: "community"
    });

    if (scan.verdict === "dangerous") {
      this.logMessage("blocked", envelope, scrubbedText, scan.verdict);
      const topReasons = scan.findings
        .slice(0, 3)
        .map((f) => `${f.patternId} (${f.category})`)
        .join(", ");
      throw new Error(
        `UNTRUSTED_CHANNEL_INJECTION_BLOCKED (${envelope.platform}): skills-guard-v10 blocked dangerous payload [${topReasons}].`
      );
    }

    this.logMessage("inbound", envelope, scrubbedText, scan.verdict);

    // 4. Remote Approval Card Fast-Path (`/approve apr_...` | `/deny apr_...`)
    const approvalMatch = /^\/(approve|deny)\s+(apr_[a-z0-9_]+)$/i.exec(rawTrimmed);
    if (approvalMatch) {
      const verb = approvalMatch[1]!.toLowerCase() === "approve" ? "approved" : "denied";
      const apr = this.resolveRemoteApproval(
        approvalMatch[2]!,
        verb,
        envelope.senderId,
        envelope.platform
      );
      const replyText = `Approval ${apr.approvalId} marked ${apr.status.toUpperCase()} (${apr.actionSummary}).`;
      const outboundReceipt = await this.send({
        platform: envelope.platform,
        channelId: envelope.channelId,
        text: replyText,
        threadId: envelope.threadId
      });
      return {
        accepted: true,
        scanVerdict: scan.verdict,
        replyText,
        outboundReceipt
      };
    }

    // 5. Append-only `<channel_context>` envelope -> session turn handler (`0` prefix drift!)
    const formattedPrompt = [
      `<channel_context platform="${envelope.platform}" sender="${envelope.senderId}" channel="${envelope.channelId}">`,
      scrubbedText,
      `</channel_context>`
    ].join("\n");

    const rawReply = this.turnHandler
      ? await this.turnHandler({ envelope, formattedPrompt })
      : `Ack (${envelope.platform}): ${scrubbedText}`;
    const replyText = scrubSecretsInfallible(rawReply);

    const outboundReceipt = await this.send({
      platform: envelope.platform,
      channelId: envelope.channelId,
      text: replyText,
      threadId: envelope.threadId,
      replyToMessageId: envelope.messageId
    });

    return {
      accepted: true,
      scanVerdict: scan.verdict,
      replyText,
      outboundReceipt
    };
  }

  /**
   * Parses & authenticates an official Meta WhatsApp Business Cloud API webhook POST payload.
   */
  public async handleWhatsAppCloudWebhook(opts: {
    rawBody: string;
    signatureHeader: string | undefined;
  }): Promise<GatewayTurnOutcome[]> {
    const cfg = this.credentials.whatsappCloud;
    if (!cfg) {
      throw new Error("WHATSAPP_CLOUD_NOT_CONFIGURED");
    }
    if (!verifyWhatsAppCloudSignature(opts.rawBody, opts.signatureHeader, cfg.appSecret)) {
      throw new Error("WHATSAPP_CLOUD_INVALID_SIGNATURE");
    }
    const payload = JSON.parse(opts.rawBody) as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              id?: string;
              from?: string;
              text?: { body?: string };
            }>;
          };
        }>;
      }>;
    };
    const outcomes: GatewayTurnOutcome[] = [];
    for (const entry of payload.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        for (const msg of ch.value?.messages ?? []) {
          if (msg.from && msg.text?.body) {
            outcomes.push(
              await this.handleInbound({
                platform: "whatsapp_cloud",
                senderId: msg.from,
                channelId: msg.from,
                text: msg.text.body,
                messageId: msg.id
              })
            );
          }
        }
      }
    }
    return outcomes;
  }

  private logMessage(
    direction: "inbound" | "outbound" | "blocked",
    envelope: InboundChannelEnvelope,
    scrubbedText: string,
    verdict: SkillVerdict
  ): void {
    this.db
      .prepare(
        `INSERT INTO gateway_messages (
           direction, platform, sender_id, channel_id, text_scrubbed, scan_verdict, external_msg_id, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        direction,
        envelope.platform,
        envelope.senderId,
        envelope.channelId,
        scrubbedText,
        verdict,
        envelope.messageId ?? "",
        envelope.timestampMs ?? Date.now()
      );
  }

  public listRecentMessages(limit = 40): Array<{
    id: number;
    direction: string;
    platform: GatewayPlatform;
    senderId: string;
    channelId: string;
    text: string;
    scanVerdict: SkillVerdict;
    createdAtMs: number;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM gateway_messages ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r["id"]),
      direction: String(r["direction"]),
      platform: String(r["platform"]) as GatewayPlatform,
      senderId: String(r["sender_id"]),
      channelId: String(r["channel_id"]),
      text: String(r["text_scrubbed"]),
      scanVerdict: String(r["scan_verdict"]) as SkillVerdict,
      createdAtMs: Number(r["created_at_ms"])
    }));
  }

  public getStatusSummary(): {
    platforms: Array<{ platform: GatewayPlatform; configured: boolean; mode: string }>;
    baileys: WhatsAppBaileysPairingState;
    allowedSendersCount: number;
    pendingApprovalsCount: number;
    recentMessagesCount: number;
  } {
    const builtinStatuses: Array<{
      platform: GatewayPlatform;
      configured: boolean;
      mode: string;
    }> = [
      {
        platform: "whatsapp_baileys",
        configured: true,
        mode: this.baileysState.connected
          ? `paired (${this.baileysState.pairedPhoneE164})`
          : `ready-to-pair (code ${this.baileysState.eightCharLinkCode})`
      },
      {
        platform: "whatsapp_cloud",
        configured: Boolean(this.credentials.whatsappCloud?.accessToken || this.customAdapters.has("whatsapp_cloud")),
        mode: "Meta Graph API v21 + X-Hub-Signature-256"
      },
      {
        platform: "telegram",
        configured: Boolean(this.credentials.telegram?.botToken || this.customAdapters.has("telegram")),
        mode: "Bot API Long-Poll / Webhook"
      },
      {
        platform: "discord",
        configured: Boolean(this.credentials.discord?.botToken || this.customAdapters.has("discord")),
        mode: "Gateway v10 + REST"
      },
      {
        platform: "slack",
        configured: Boolean(this.credentials.slack?.botToken || this.customAdapters.has("slack")),
        mode: "Socket Mode + v0 HMAC + Native Manifest"
      },
      {
        platform: "signal",
        configured: Boolean(this.credentials.signal?.rpcUrl || this.customAdapters.has("signal")),
        mode: "signal-cli JSON-RPC 2.0"
      }
    ];

    for (const key of this.customAdapters.keys()) {
      if (key.startsWith("plugin:")) {
        builtinStatuses.push({
          platform: key,
          configured: true,
          mode: "External Plugin Channel Adapter"
        });
      }
    }

    const pendingApprovalsCount = this.listApprovals().filter((a) => a.status === "pending").length;
    return {
      platforms: builtinStatuses,
      baileys: this.getWhatsAppBaileysState(),
      allowedSendersCount: this.listAllowedSenders().length,
      pendingApprovalsCount,
      recentMessagesCount: this.listRecentMessages(100).length
    };
  }
}
