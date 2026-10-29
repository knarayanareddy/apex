/** Diagnostic only: compare each installed browser once after qualification fails.
 * This does not replace or retry the required browser gate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChromiumCdpSession } from "../../src/ring7/chromium-cdp-driver.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-browser-comparison-"));
const results: Array<Record<string, unknown>> = [];
const binaries = process.argv.length > 2 ? process.argv.slice(2) : ["/usr/bin/chromium", "/usr/bin/google-chrome"];
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
    try {
      await browser.ensureStarted();
      const startupMs = Math.round(performance.now() - start);
      phase = "navigation";
      await browser.navigate("data:text/html,%3Ch1%3EBrowser%20comparison%3C%2Fh1%3E");
      const snapshot = await browser.snapshot();
      if (!snapshot.snapshot.includes("Browser comparison")) throw new Error("COMPARISON_CONTENT_MISMATCH");
      results.push({ binary, realPath, dev: file.dev, ino: file.ino, available: true, ok: true, startupMs, totalMs: Math.round(performance.now() - start) });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const code = text.match(/^(?:CHROMIUM_[A-Z_]+|CDP_[A-Z_]+|COMPARISON_CONTENT_MISMATCH)/)?.[0] ?? "OTHER_ERROR";
      results.push({ binary, realPath, dev: file.dev, ino: file.ino, available: true, ok: false, phase, errorCode: code, totalMs: Math.round(performance.now() - start) });
    } finally {
      await browser.close();
    }
  }
  console.log(`BROWSER_BINARY_COMPARISON_DIAGNOSTIC ${JSON.stringify(results)}`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
