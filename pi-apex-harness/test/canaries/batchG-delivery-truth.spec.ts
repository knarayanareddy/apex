/**
 * Batch G Remediation Canary Suite (`test/canaries/batchG-delivery-truth.spec.ts`)
 *
 * Verifies R02 (Truthful Delivery Status):
 *  - Distinguishes confirmed, queued, unavailable, failed, and unknown outcomes.
 *  - Never reports `delivered: true` without verified external confirmation.
 *  - Slack HTTP 200 with `{ ok: false, error: ... }` MUST report `delivered: false, deliveryStatus: "failed"`.
 *  - WhatsApp Baileys pairing without active socket sender MUST report `delivered: false, deliveryStatus: "queued"`.
 *  - WhatsApp Baileys with active socket sender confirms `delivered: true, deliveryStatus: "confirmed"`.
 *  - Unconfigured / absent credentials report `delivered: false, deliveryStatus: "unavailable"`.
 *  - Network timeouts report `delivered: false, deliveryStatus: "unknown"`.
 *  - Never sends real messages across the internet; uses synthetic local HTTP mock servers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { StateDb } from "../../src/core/state-db.ts";
import { OmniChannelGateway } from "../../src/ring9/messaging-gateway.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apex-r02-delivery-"));
let passed = false;

// Mock HTTP server to simulate Slack, Telegram, Discord, WhatsApp Cloud APIs
let mockResponses: Record<string, { status: number; body: Record<string, unknown>; delayMs?: number }> = {};
const mockServer = http.createServer((req, res) => {
  const urlPath = req.url ?? "/";
  const matched = Object.entries(mockResponses).find(([prefix]) => urlPath.startsWith(prefix));
  if (matched) {
    const config = matched[1];
    if (config.delayMs) {
      setTimeout(() => {
        res.writeHead(config.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config.body));
      }, config.delayMs);
    } else {
      res.writeHead(config.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(config.body));
    }
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  }
});

await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const addr = mockServer.address() as import("node:net").AddressInfo;
const mockBaseUrl = `http://127.0.0.1:${addr.port}`;

try {
  const db = new StateDb(path.join(tmp, "state.db"));

  // 1. Negative control: Unconfigured channels (no credentials, no adapter) -> unavailable
  const unconfiguredGw = new OmniChannelGateway({
    workspaceRoot: tmp,
    db: db.db,
    credentials: {}
  });

  const unconfTelegram = await unconfiguredGw.send({
    platform: "telegram",
    channelId: "chat_123",
    text: "Testing unconfigured send"
  });
  assert.equal(unconfTelegram.delivered, false, "Unconfigured platform must NOT report delivered: true");
  assert.equal(unconfTelegram.deliveryStatus, "unavailable");
  assert.equal(unconfTelegram.transportDetail, "unconfigured-telegram");

  const unconfSlack = await unconfiguredGw.send({
    platform: "slack",
    channelId: "C12345",
    text: "Testing unconfigured slack"
  });
  assert.equal(unconfSlack.delivered, false);
  assert.equal(unconfSlack.deliveryStatus, "unavailable");

  // 2. WhatsApp Baileys: Paired locally, but NO active socket sender attached -> queued
  unconfiguredGw.initWhatsAppBaileysPairing("+31600000000");
  assert.equal(unconfiguredGw.getWhatsAppBaileysState().connected, true);

  const baileysQueued = await unconfiguredGw.send({
    platform: "whatsapp_baileys",
    channelId: "+31600000000",
    text: "Testing baileys paired without socket"
  });
  assert.equal(
    baileysQueued.delivered,
    false,
    "Baileys pairing without active socket transmission MUST report delivered: false"
  );
  assert.equal(baileysQueued.deliveryStatus, "queued");
  assert.equal(baileysQueued.transportDetail, "whatsapp-baileys-queued-offline");

  // 3. WhatsApp Baileys: With active live socket sender -> confirmed
  const liveBaileysGw = new OmniChannelGateway({
    workspaceRoot: tmp,
    db: db.db,
    baileysSender: {
      send: async (to, text) => {
        assert.equal(to, "+31611111111");
        assert.ok(text.includes("verified socket message"));
        return { messageId: "wa_sock_msg_9876" };
      }
    }
  });
  liveBaileysGw.initWhatsAppBaileysPairing("+31611111111");
  const baileysConfirmed = await liveBaileysGw.send({
    platform: "whatsapp_baileys",
    channelId: "+31611111111",
    text: "verified socket message"
  });
  assert.equal(baileysConfirmed.delivered, true, "Baileys with active socket acknowledgment must be confirmed");
  assert.equal(baileysConfirmed.deliveryStatus, "confirmed");
  assert.equal(baileysConfirmed.externalMessageId, "wa_sock_msg_9876");
  assert.equal(baileysConfirmed.transportDetail, "whatsapp-baileys-md-bridge");

  // 4. Slack: HTTP 200 with { ok: false, error: "channel_not_found" } -> failed
  mockResponses["/slack-api/chat.postMessage"] = {
    status: 200,
    body: { ok: false, error: "channel_not_found" }
  };

  const configuredGw = new OmniChannelGateway({
    workspaceRoot: tmp,
    db: db.db,
    credentials: {
      slack: {
        botToken: "xoxb-mock-token",
        signingSecret: "mock-secret",
        apiBaseUrl: `${mockBaseUrl}/slack-api`
      },
      telegram: {
        botToken: "mock-bot-token",
        apiBaseUrl: `${mockBaseUrl}/tg-api`
      },
      discord: {
        botToken: "mock-discord-token",
        apiBaseUrl: `${mockBaseUrl}/discord-api`
      },
      whatsappCloud: {
        accessToken: "mock-wa-token",
        phoneNumberId: "10001",
        appSecret: "mock-wa-secret",
        verifyToken: "mock-wa-verify",
        apiBaseUrl: `${mockBaseUrl}/wa-cloud-api`
      }
    }
  });

  const slackFailedReceipt = await configuredGw.send({
    platform: "slack",
    channelId: "C_UNKNOWN",
    text: "Slack message to non-existent channel"
  });
  assert.equal(
    slackFailedReceipt.delivered,
    false,
    "Slack HTTP 200 with { ok: false } MUST report delivered: false"
  );
  assert.equal(slackFailedReceipt.deliveryStatus, "failed");
  assert.equal(slackFailedReceipt.transportDetail, "slack:channel_not_found");

  // 5. Slack: HTTP 200 with { ok: true, ts: "1700000000.000100" } -> confirmed
  mockResponses["/slack-api/chat.postMessage"] = {
    status: 200,
    body: { ok: true, ts: "1700000000.000100" }
  };

  const slackSuccessReceipt = await configuredGw.send({
    platform: "slack",
    channelId: "C_VALID",
    text: "Slack successful message"
  });
  assert.equal(slackSuccessReceipt.delivered, true);
  assert.equal(slackSuccessReceipt.deliveryStatus, "confirmed");
  assert.equal(slackSuccessReceipt.externalMessageId, "1700000000.000100");
  assert.equal(slackSuccessReceipt.transportDetail, "slack-web-api");

  // 6. Telegram: HTTP 200 with { ok: false, description: "Bad Request: chat not found" } -> failed
  mockResponses["/tg-api/botmock-bot-token/sendMessage"] = {
    status: 200,
    body: { ok: false, description: "Bad Request: chat not found" }
  };
  const tgFailedReceipt = await configuredGw.send({
    platform: "telegram",
    channelId: "-999999",
    text: "Telegram fail"
  });
  assert.equal(tgFailedReceipt.delivered, false);
  assert.equal(tgFailedReceipt.deliveryStatus, "failed");
  assert.match(tgFailedReceipt.transportDetail, /chat not found/);

  // 7. Telegram: HTTP 200 with { ok: true, result: { message_id: 42 } } -> confirmed
  mockResponses["/tg-api/botmock-bot-token/sendMessage"] = {
    status: 200,
    body: { ok: true, result: { message_id: 42 } }
  };
  const tgSuccessReceipt = await configuredGw.send({
    platform: "telegram",
    channelId: "12345",
    text: "Telegram success"
  });
  assert.equal(tgSuccessReceipt.delivered, true);
  assert.equal(tgSuccessReceipt.deliveryStatus, "confirmed");
  assert.equal(tgSuccessReceipt.externalMessageId, "42");

  // 8. Discord: HTTP 404 with { code: 10003, message: "Unknown Channel" } -> failed
  mockResponses["/discord-api/channels/invalid-chan/messages"] = {
    status: 404,
    body: { code: 10003, message: "Unknown Channel" }
  };
  const discordFailedReceipt = await configuredGw.send({
    platform: "discord",
    channelId: "invalid-chan",
    text: "Discord fail"
  });
  assert.equal(discordFailedReceipt.delivered, false);
  assert.equal(discordFailedReceipt.deliveryStatus, "failed");
  assert.match(discordFailedReceipt.transportDetail, /Unknown Channel/);

  // 9. Discord: HTTP 200 with { id: "msg_disc_123" } -> confirmed
  mockResponses["/discord-api/channels/valid-chan/messages"] = {
    status: 200,
    body: { id: "msg_disc_123" }
  };
  const discordSuccessReceipt = await configuredGw.send({
    platform: "discord",
    channelId: "valid-chan",
    text: "Discord success"
  });
  assert.equal(discordSuccessReceipt.delivered, true);
  assert.equal(discordSuccessReceipt.deliveryStatus, "confirmed");
  assert.equal(discordSuccessReceipt.externalMessageId, "msg_disc_123");

  // 10. WhatsApp Cloud: HTTP 401 with { error: { message: "Invalid OAuth access token" } } -> failed
  mockResponses["/wa-cloud-api/10001/messages"] = {
    status: 401,
    body: { error: { message: "Invalid OAuth access token" } }
  };
  const waCloudFailed = await configuredGw.send({
    platform: "whatsapp_cloud",
    channelId: "+15551234567",
    text: "WA Cloud fail"
  });
  assert.equal(waCloudFailed.delivered, false);
  assert.equal(waCloudFailed.deliveryStatus, "failed");
  assert.match(waCloudFailed.transportDetail, /Invalid OAuth access token/);

  // 11. Network error / connection refused -> unknown
  const unreachableGw = new OmniChannelGateway({
    workspaceRoot: tmp,
    db: db.db,
    credentials: {
      slack: {
        botToken: "xoxb-test",
        signingSecret: "test",
        apiBaseUrl: "http://127.0.0.1:1" // guaranteed connection refused
      }
    }
  });
  const unreachableReceipt = await unreachableGw.send({
    platform: "slack",
    channelId: "C123",
    text: "Unreachable endpoint"
  });
  assert.equal(unreachableReceipt.delivered, false);
  assert.equal(unreachableReceipt.deliveryStatus, "unknown");

  // 12. Positive control: Custom platform adapter explicitly confirms send
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:matrix" as any,
    send: async (req) => ({
      externalMessageId: "mtx_confirmed_999",
      transportDetail: "matrix-synapse-v1",
      outcome: "confirmed",
      delivered: true
    })
  });

  const confirmedReceipt = await unconfiguredGw.send({
    platform: "plugin:custom-relay:matrix" as any,
    channelId: "!room:matrix.org",
    text: "Verified outbound message"
  });

  assert.equal(confirmedReceipt.delivered, true, "Confirmed adapter send must report delivered: true");
  assert.equal(confirmedReceipt.deliveryStatus, "confirmed");
  assert.equal(confirmedReceipt.externalMessageId, "mtx_confirmed_999");
  assert.equal(confirmedReceipt.transportDetail, "matrix-synapse-v1");

  // 13. Custom adapter returning queued-local-adapter produces delivered: false and deliveryStatus: "queued"
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:queued-transport" as any,
    send: async () => ({
      externalMessageId: "local_queued_123",
      transportDetail: "queued-local-adapter"
    })
  });

  const queuedReceipt = await unconfiguredGw.send({
    platform: "plugin:custom-relay:queued-transport" as any,
    channelId: "chan_q",
    text: "Queued payload"
  });

  assert.equal(queuedReceipt.delivered, false, "Queued adapter must NOT produce delivered: true");
  assert.equal(queuedReceipt.deliveryStatus, "queued");
  assert.equal(queuedReceipt.transportDetail, "queued-local-adapter");

  // 14. Custom adapter returning explicit outcome: "queued" produces delivered: false
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:explicit-queue" as any,
    send: async () => ({
      externalMessageId: "msg_eq_456",
      transportDetail: "local-spool",
      outcome: "queued"
    })
  });

  const explicitQueueReceipt = await unconfiguredGw.send({
    platform: "plugin:custom-relay:explicit-queue" as any,
    channelId: "chan_eq",
    text: "Explicit queue payload"
  });

  assert.equal(explicitQueueReceipt.delivered, false);
  assert.equal(explicitQueueReceipt.deliveryStatus, "queued");

  // 15. Ambiguous / zero-network-call return without explicit confirmation produces unknown
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:zero-net" as any,
    send: async () => ({
      externalMessageId: "local_noop_789",
      transportDetail: "local-mock-no-network"
    })
  });

  const ambiguousReceipt = await unconfiguredGw.send({
    platform: "plugin:custom-relay:zero-net" as any,
    channelId: "chan_zero",
    text: "Zero network payload"
  });

  assert.equal(ambiguousReceipt.delivered, false, "Ambiguous outcome without confirmation must NOT report delivered: true");
  assert.equal(ambiguousReceipt.deliveryStatus, "unknown");

  // 16. Custom adapter returning outcome: "failed" produces delivered: false, failed
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:failed-transport" as any,
    send: async () => ({
      externalMessageId: "msg_fail_999",
      transportDetail: "upstream-rejected",
      outcome: "failed"
    })
  });

  const failedReceipt = await unconfiguredGw.send({
    platform: "plugin:custom-relay:failed-transport" as any,
    channelId: "chan_fail",
    text: "Failed payload"
  });

  assert.equal(failedReceipt.delivered, false);
  assert.equal(failedReceipt.deliveryStatus, "failed");

  // 17. Custom adapter throwing an error produces failed
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:throw-transport" as any,
    send: async () => {
      throw new Error("Simulated connection reset by peer");
    }
  });

  const thrownReceipt = await unconfiguredGw.send({
    platform: "plugin:custom-relay:throw-transport" as any,
    channelId: "chan_throw",
    text: "Throwing payload"
  });

  assert.equal(thrownReceipt.delivered, false);
  assert.equal(thrownReceipt.deliveryStatus, "failed");
  assert.ok(thrownReceipt.transportDetail.includes("custom-adapter-failed: Simulated connection reset by peer"));

  db.close();
  passed = true;
  console.log("R02 Truthful messaging delivery status (all 17 controls): PASS");
} finally {
  mockServer.close();
  if (passed) {
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.error(`R02 test failure evidence preserved at: ${tmp}`);
  }
}
