import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "apex-js-inventory-"));
const excluded = new Set([".git", "node_modules", ".harness", "dist", "build", "coverage", ".venv"]);
function copySource(dir: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !excluded.has(entry.name)) copySource(path.join(dir, entry.name), path.join(dest, entry.name));
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) fs.copyFileSync(path.join(dir, entry.name), path.join(dest, entry.name));
  }
}
copySource(root, fixture);
const check = () => spawnSync(process.execPath, [path.join(fixture, "scripts/check-maintained-js.mjs")], { encoding: "utf8" });
assert.equal(check().status, 0, "Complete inventory must pass");
fs.writeFileSync(path.join(fixture, "src", "unclassified.mjs"), "export const ok = true;\n");
const extra = check();
assert.notEqual(extra.status, 0, "Unclassified source must fail the gate");
assert.match(extra.stderr, /unclassified\.mjs/);
fs.unlinkSync(path.join(fixture, "src", "unclassified.mjs"));
fs.unlinkSync(path.join(fixture, "src", "wal-ledger.mjs"));
const missing = check();
assert.notEqual(missing.status, 0, "Missing inventory entry must fail the gate");
assert.match(missing.stderr, /wal-ledger\.mjs/);
console.log("JavaScript inventory drift gate: PASS");
