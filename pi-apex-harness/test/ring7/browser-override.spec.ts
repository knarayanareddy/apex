import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findLocalChromiumBinary } from "../../src/ring7/chromium-cdp-driver.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "apex-browser-override-"));
const previous = process.env["PI_APEX_CHROMIUM_BIN"];
let passed = false;
try {
  const fake = path.join(temp, "browser");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env["PI_APEX_CHROMIUM_BIN"] = fake;
  assert.equal(findLocalChromiumBinary(), fake, "explicit executable must be used");

  process.env["PI_APEX_CHROMIUM_BIN"] = path.join(temp, "missing");
  assert.equal(findLocalChromiumBinary(), null, "missing explicit browser must not silently select a different browser");
  const runner = fileURLToPath(new URL("../runners/run-browser-tier.ts", import.meta.url));
  const invalid = spawnSync(process.execPath, ["--experimental-strip-types", runner], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], HOME: temp, TMPDIR: temp, PI_APEX_CHROMIUM_BIN: path.join(temp, "missing") }
  });
  assert.equal(invalid.status, 1, "an invalid explicit browser must fail even when browser strict mode is unset");

  process.env["PI_APEX_CHROMIUM_BIN"] = temp;
  assert.equal(findLocalChromiumBinary(), null, "a directory is not a browser executable");

  fs.chmodSync(fake, 0o600);
  process.env["PI_APEX_CHROMIUM_BIN"] = fake;
  assert.equal(findLocalChromiumBinary(), null, "non-executable explicit browser must be rejected");
  passed = true;
  console.log("Browser override validates executable and fails closed: PASS");
} finally {
  if (previous === undefined) delete process.env["PI_APEX_CHROMIUM_BIN"];
  else process.env["PI_APEX_CHROMIUM_BIN"] = previous;
  if (passed) fs.rmSync(temp, { recursive: true, force: true });
  else console.error(`Browser override failure fixture retained: ${temp}`);
}
