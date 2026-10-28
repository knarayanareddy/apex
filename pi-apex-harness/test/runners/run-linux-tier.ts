/**
 * Required Linux Confinement Qualification Runner (Programme E3).
 *
 * Verifies kernel-enforced Linux security primitives:
 *  - bubblewrap namespace creation (`probeBwrapFunctional()`)
 *  - linux_fs_bridge openat2(RESOLVE_BENEATH) descriptor isolation
 *  - /proc and object masking
 *
 * When run on Linux: Fails nonzero if bubblewrap or kernel namespaces are absent/broken.
 * When run on non-Linux (macOS darwin, Windows): Reports explicit SKIPPED/UNVERIFIED status without false pass claims.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeBwrapFunctional } from "../../src/core/bwrap-sandbox.ts";

console.log("=== Linux Confinement Qualification Tier (Programme E3) ===");

if (process.platform !== "linux") {
  console.log(`[TIER: LINUX CONFINEMENT] Status: SKIPPED (NON_LINUX_HOST)`);
  console.log(`  Current OS: ${process.platform} (${os.type()} ${os.release()})`);
  console.log(`  Rationale: Linux kernel namespaces, bubblewrap sandbox confinement, and openat2 syscalls are specific to Linux hosts.`);
  console.log(`  Qualification on macOS darwin uses native Darwin containment gates.`);
  console.log("=== LINUX TIER: EXPLICITLY SKIPPED ON NON-LINUX HOST ===\n");
  process.exit(0);
}

// On Linux: must verify functional bubblewrap and fail closed if missing
console.log("Probing Linux host bubblewrap functionality...");
const probe = probeBwrapFunctional();
if (!probe.ok) {
  console.error(`[TIER: LINUX CONFINEMENT] FAILED: Linux host missing functional bubblewrap: ${probe.reason}`);
  console.error("Install bubblewrap (`apt-get install -y bwrap` or equivalent) to qualify Linux confinement.");
  process.exit(1);
}

console.log("  [PASS] Bubblewrap functional on Linux host.");
console.log("Running Linux namespace confinement canaries...");

try {
  execFileSync("node", ["--experimental-strip-types", "test/canaries/security-canaries.spec.ts"], {
    stdio: "inherit"
  });
  console.log("\n=== ALL REQUIRED LINUX CONFINEMENT CHECKS PASSED ===\n");
} catch (err: any) {
  console.error(`\n[TIER: LINUX CONFINEMENT] FAILED: Canaries failed under Linux confinement: ${err.message}`);
  process.exit(1);
}
