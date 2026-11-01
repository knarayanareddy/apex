import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromiumCdpSession } from "../../src/ring7/chromium-cdp-driver.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-chromium-startup-diagnostic-"));
const launcher = path.join(workspace, "synthetic-chromium");
// Synthetic owned process: advertise a marker file, then remain alive until the driver closes it.
fs.writeFileSync(launcher, `#!/bin/sh\nfor arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}" ;; esac; done\nprintf 'synthetic\\n' > "$profile/DevToolsActivePort"\nprintf 'synthetic-stdout'\nwhile :; do :; done\n`, { mode: 0o700 });
const browser = new ChromiumCdpSession({ workspaceRoot: workspace, chromiumPath: launcher, connectTimeoutMs: 500 });
try {
  await assert.rejects(
    () => browser.ensureStarted(),
    (error: unknown) => error instanceof Error && /CHROMIUM_CDP_TIMEOUT/.test(error.message) && /activePortFile=true/.test(error.message) && /stdoutBytes=16/.test(error.message),
    "A startup timeout must report bounded endpoint-file and stdout observations"
  );
  console.log("Chromium startup timeout diagnostics: PASS");
} finally {
  await browser.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}
