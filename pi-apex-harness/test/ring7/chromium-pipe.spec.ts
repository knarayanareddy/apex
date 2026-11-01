import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromiumCdpSession, findLocalChromiumBinary } from "../../src/ring7/chromium-cdp-driver.ts";

const browserPath = findLocalChromiumBinary();
assert.ok(browserPath, "Chromium is required for the browser qualification");
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-chromium-pipe-"));
const launcher = path.join(workspace, "chromium-with-stdout");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Fill more than the pipe capacity before exec'ing the real browser. No unrelated process is touched.
fs.writeFileSync(launcher, `#!/bin/sh\ni=0\nwhile [ "$i" -lt 32768 ]; do printf %s ${quote("X".repeat(64))}; i=$((i+1)); done\nexec ${quote(browserPath)} "$@"\n`, { mode: 0o700 });
const browser = new ChromiumCdpSession({ workspaceRoot: workspace, chromiumPath: launcher, connectTimeoutMs: 12_000 });
try {
  const navigation = await browser.navigate("data:text/html,%3Ch1%3EPipe%20control%3C%2Fh1%3E");
  assert.match(navigation.url, /^data:text\/html/);
  const snapshot = await browser.snapshot();
  assert.match(snapshot.snapshot, /Pipe control/);
  console.log("Chromium startup drains stdout without extending its deadline: PASS");
} finally {
  await browser.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
