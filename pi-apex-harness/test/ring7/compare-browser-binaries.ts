/** Diagnostic only: compare each selected browser once.
 * This does not replace or retry the required browser gate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromiumCdpSession } from "../../src/ring7/chromium-cdp-driver.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-browser-comparison-"));
const results: Array<Record<string, unknown>> = [];
const binaries = process.argv.length > 2 ? process.argv.slice(2) : ["/usr/bin/chromium", "/usr/bin/google-chrome"];
const requestedTimeout = Number(process.env.APEX_COMPARE_TIMEOUT_MS);
const probeTimeoutMs = Number.isInteger(requestedTimeout) && requestedTimeout >= 1000 && requestedTimeout <= 60_000
  ? requestedTimeout : 60_000;
let probeTimedOut = false;
try {
  for (const binary of binaries) {
    if (!fs.existsSync(binary)) {
      results.push({ binary, available: false });
      continue;
    }
    const realPath = fs.realpathSync(binary);
    const file = fs.statSync(realPath);
    const browser = new ChromiumCdpSession({ workspaceRoot: workspace, chromiumPath: binary, connectTimeoutMs: 12_000 });
    const start = performance.now();
    let phase = "startup";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { probeTimedOut = true; reject(new Error("BROWSER_COMPARISON_TIMEOUT")); }, probeTimeoutMs);
      });
      const startupMs = await Promise.race([(async () => {
        await browser.ensureStarted();
        const elapsed = Math.round(performance.now() - start);
        phase = "navigation";
        await browser.navigate("data:text/html,%3Ch1%3EBrowser%20comparison%3C%2Fh1%3E");
        const snapshot = await browser.snapshot();
        if (!snapshot.snapshot.includes("Browser comparison")) throw new Error("COMPARISON_CONTENT_MISMATCH");
        return elapsed;
      })(), deadline]);
      results.push({ binary, realPath, dev: file.dev, ino: file.ino, available: true, ok: true, startupMs, totalMs: Math.round(performance.now() - start) });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const code = text.match(/^(?:CHROMIUM_[A-Z_]+|CDP_[A-Z_]+|COMPARISON_CONTENT_MISMATCH|BROWSER_COMPARISON_TIMEOUT)/)?.[0] ?? "OTHER_ERROR";
      results.push({ binary, realPath, dev: file.dev, ino: file.ino, available: true, ok: false, phase, errorCode: code, totalMs: Math.round(performance.now() - start) });
    } finally {
      if (timer) clearTimeout(timer);
      await browser.close();
    }
    if (probeTimedOut) break;
  }
  console.log(`BROWSER_BINARY_COMPARISON_DIAGNOSTIC ${JSON.stringify(results)}`);
  if (process.env.APEX_COMPARE_REQUIRE_SUCCESS === "1" && results.some((result) => result.ok !== true)) {
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
if (probeTimedOut) {
  // An abandoned HTTP request may keep Node alive. The browser is our own child
  // and has been closed above; flush the diagnostic before exiting this probe.
  await new Promise<void>((resolve, reject) => process.stdout.write("", (error) => error ? reject(error) : resolve()));
  process.exit(1);
}
