/**
 * Required Browser Qualification Runner (Programme E3).
 *
 * Verifies Chromium CDP driver, Mission Control web UI, and browser automation:
 *  - Chromium binary availability
 *  - Ring 7 Chromium CDP driver & autonomous browser evaluation
 *
 * When Chromium is available: Executes browser test suites.
 * When Chromium is missing: Fails nonzero in required mode, or reports explicit UNVERIFIED status.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findLocalChromiumBinary } from "../../src/ring7/chromium-cdp-driver.ts";

console.log("=== Browser Qualification Tier (Programme E3) ===");

const executable = findLocalChromiumBinary();
if (!executable) {
  const isStrict = process.env["PI_APEX_REQUIRE_BROWSER"] === "1";
  if (isStrict) {
    console.error(`[TIER: BROWSER] FAILED: Chromium executable not found in standard paths.`);
    console.error("Install chromium or google-chrome, or set CHROME_BIN / CHROMIUM_PATH.");
    process.exit(1);
  } else {
    console.log(`[TIER: BROWSER] Status: SKIPPED (CHROMIUM_NOT_FOUND)`);
    console.log(`  Rationale: Chromium binary not found in standard system locations.`);
    console.log(`  Set PI_APEX_REQUIRE_BROWSER=1 in CI browser environments to enforce mandatory execution.`);
    console.log("=== BROWSER TIER: EXPLICITLY SKIPPED (PREREQUISITE ABSENT) ===\n");
    process.exit(0);
  }
}

console.log(`  Found Chromium executable at: ${executable}`);
console.log("Running Ring 7 browser CDP tests...");

try {
  execFileSync("node", ["--experimental-strip-types", "test/ring7/run-ring7-tests.ts"], {
    stdio: "inherit"
  });
  console.log("\n=== ALL REQUIRED BROWSER CHECKS PASSED ===\n");
} catch (err: any) {
  console.error(`\n[TIER: BROWSER] FAILED: Browser test suite failed: ${err.message}`);
  process.exit(1);
}
