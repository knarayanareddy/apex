import assert from "node:assert/strict";
import { ChromiumCdpSession } from "../../src/ring7/chromium-cdp-driver.ts";

// Constructor only: no browser process or network request is started.
const session = new ChromiumCdpSession({ chromiumPath: process.execPath });
assert.equal(Reflect.get(session, "connectTimeoutMs"), 12_000, "CDP qualification deadline must remain 12 seconds");
console.log("CDP qualification deadline remains 12 seconds: PASS");
