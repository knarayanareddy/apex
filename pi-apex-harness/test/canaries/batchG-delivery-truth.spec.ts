/**
 * Batch G Remediation Canary Suite (`test/canaries/batchG-delivery-truth.spec.ts`)
 *
 * Verifies R02 (Truthful Delivery Status):
 *  - Distinguishes confirmed external send from staged, unconfigured, or failed delivery.
 *  - Never reports `delivered: true` without verified external confirmation.
 *  - Synthetic-adapter regression + confirmed-send positive control.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateDb } from "../../src/core/state-db.ts";
import { OmniChannelGateway } from "../../src/ring9/messaging-gateway.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apex-r02-delivery-"));
let passed = false;

try {
  const db = new StateDb(path.join(tmp, "state.db"));

  // 1. Negative control: Unconfigured channel (no credentials, no adapter)
  const unconfiguredGw = new OmniChannelGateway({
    workspaceRoot: tmp,
    db: db.db,
    credentials: {}
  });

  const unconfReceipt = await unconfiguredGw.send({
    platform: "telegram",
    channelId: "chat_123",
    text: "Testing unconfigured send"
  });

  assert.equal(
    unconfReceipt.delivered,
    false,
    "Unconfigured platform must NOT report delivered: true without transport confirmation"
  );
  assert.equal(unconfReceipt.deliveryStatus, "unconfigured");
  assert.equal(unconfReceipt.transportDetail, "unconfigured-telegram");

  // 2. Staged control: WhatsApp Baileys when disconnected
  const stagedReceipt = await unconfiguredGw.send({
    platform: "whatsapp_baileys",
    channelId: "+31600000000",
    text: "Testing staged baileys"
  });

  assert.equal(
    stagedReceipt.delivered,
    false,
    "Disconnected Baileys bridge must report delivered: false while staged"
  );
  assert.equal(stagedReceipt.deliveryStatus, "staged");
  assert.equal(stagedReceipt.transportDetail, "whatsapp-baileys-staged");

  // 3. Positive control: Custom platform adapter confirms send
  unconfiguredGw.registerAdapter({
    platform: "plugin:custom-relay:matrix" as any,
    send: async (req) => ({
      externalMessageId: "mtx_confirmed_999",
      transportDetail: "matrix-synapse-v1"
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

  // 4. Positive control: Connected Baileys state confirms send
  (unconfiguredGw as any).baileysState.connected = true;
  const connectedBaileysReceipt = await unconfiguredGw.send({
    platform: "whatsapp_baileys",
    channelId: "+31600000000",
    text: "Testing connected baileys"
  });

  assert.equal(connectedBaileysReceipt.delivered, true);
  assert.equal(connectedBaileysReceipt.deliveryStatus, "confirmed");
  assert.equal(connectedBaileysReceipt.transportDetail, "whatsapp-baileys-md-bridge");

  db.close();
  passed = true;
  console.log("R02 Truthful messaging delivery status: PASS");
} finally {
  if (passed) {
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.error(`R02 test failure evidence preserved at: ${tmp}`);
  }
}
