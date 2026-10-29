#!/usr/bin/env node
/**
 * Static check & lint gate for maintained JavaScript, MJS, and CJS files (Programme E2).
 *
 * Classifies all repository JavaScript into:
 *  1. Maintained Production & Tooling Scripts
 *  2. Maintained Extensions & Examples
 *  3. Compatibility Suite (legacy test harness assertions)
 *  4. Retired Legacy Engine files (archived with rationale)
 *
 * Enforces zero syntax errors across all categories via `node --check`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const JS_INVENTORY = {
  maintained: [
    "scripts/build-native.mjs",
    "scripts/generate-brownfield-monorepo.mjs",
    "scripts/check-maintained-js.mjs",
    "extensions/vscode-pi-apex/extension.js",
    "examples/starter-pack/plugins/dev-helper/index.mjs",
    "examples/starter-pack/mcp/local-dev-helper.mjs"
  ],
  compatibilitySuite: [
    "test/e2e-flow-test.mjs",
    "test/e2e-gap-closures.mjs",
    "test/e2e-frontier-parity.mjs",
    "test/ring13/generate-fixtures.mjs"
  ],
  retiredLegacyEngines: [
    "src/wal-ledger.mjs",
    "src/extended-capabilities.mjs",
    "src/shell-sandbox-gate.mjs",
    "src/harness-engine.mjs",
    "src/frontier-parity.mjs"
  ]
};

console.log("=== Running Maintained JavaScript Static Check (Programme E2) ===");

let checkedCount = 0;
let failureCount = 0;
const excludedDirectories = new Set([".git", "node_modules", ".harness", ".venv", "dist", "build", "coverage"]);
const declared = new Set(Object.values(JS_INVENTORY).flat());

function inspectDirectory(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`  [FAIL] Cannot inventory ${dir}: ${String(err)}`);
    failureCount++;
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) inspectDirectory(full);
    else if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      if (!declared.has(rel)) {
        console.error(`  [FAIL] Unclassified JavaScript file: ${rel}`);
        failureCount++;
      }
    }
  }
}

inspectDirectory(REPO_ROOT);

for (const [category, files] of Object.entries(JS_INVENTORY)) {
  console.log(`\n--- Category: ${category} (${files.length} files) ---`);
  for (const rel of files) {
    const fullPath = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(fullPath)) {
      console.error(`  [FAIL] File declared in inventory not found: ${rel}`);
      failureCount++;
      continue;
    }

    try {
      execFileSync(process.execPath, ["--check", fullPath], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      console.log(`  [OK] ${rel}`);
      checkedCount++;
    } catch (err) {
      console.error(`  [FAIL] Syntax check failed for ${rel}:`);
      console.error(err.stderr ? err.stderr.toString() : String(err));
      failureCount++;
    }
  }
}

console.log(`\n======================================================`);
console.log(`Static Check Summary: ${checkedCount} checked, ${failureCount} failed.`);
console.log(`Maintained: ${JS_INVENTORY.maintained.length} | Compatibility: ${JS_INVENTORY.compatibilitySuite.length} | Retired: ${JS_INVENTORY.retiredLegacyEngines.length}`);
console.log(`======================================================\n`);

if (failureCount > 0) {
  process.exit(1);
}
