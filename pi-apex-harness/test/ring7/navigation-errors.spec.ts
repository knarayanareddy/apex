import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromiumCdpSession } from "../../src/ring7/chromium-cdp-driver.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-navigation-errors-"));
const server = http.createServer((req) => req.socket.destroy());
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const browser = new ChromiumCdpSession({ workspaceRoot: workspace });
try {
  const good = await browser.navigate("data:text/html,%3Cbutton%3EReady%3C%2Fbutton%3E");
  assert.match(good.url, /^data:text\/html/);
  const snapshot = await browser.snapshot();
  const ref = Object.values(snapshot.refs).find((value) => value.role === "button")?.ref;
  assert.ok(ref, "Control navigation must create a usable snapshot");
  await assert.rejects(
    () => browser.navigate(`http://127.0.0.1:${address.port}/`),
    /CDP_NAVIGATION_FAILED: net::ERR_EMPTY_RESPONSE/,
    "A Chromium navigation error must never be reported as success"
  );
  await assert.rejects(() => browser.click(ref), /SNAPSHOT_REQUIRED/, "Failed navigation must invalidate old references");
  console.log("Failed Chromium navigation and snapshot invalidation: PASS");
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workspace, { recursive: true, force: true });
}
