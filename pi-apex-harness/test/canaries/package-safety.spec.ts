import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "apex-package-safety-"));
const source = path.join(temporary, "source");
const out = path.join(temporary, "out");
fs.mkdirSync(source);
try {
  for (const item of ["package.json", "package-lock.json", "tsconfig.json", "SPEC_BIBLE.md", "ARCHITECTURE.md", "PERSONAL_QUICKSTART.md", "bin", "extensions", "scripts", "src", "surfaces", "surfaces-immutable", "test"]) {
    if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(source, item), { recursive: true });
  }
  const fixture = path.join(source, "src", "synthetic-package-fixture");
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, ".env"), "SYNTHETIC_PACKAGE_SECRET=not-real\n");
  fs.writeFileSync(path.join(fixture, "session.jsonl"), '{"synthetic":true}\n');
  fs.writeFileSync(path.join(fixture, "regular.ts"), "export const safe = true;\n");
  execFileSync("bash", [path.join(source, "scripts", "package-release.sh"), out]);
  const archive = path.join(out, `pi-apex-v${JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version}-personal.tar.gz`);
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.ok(listing.includes("synthetic-package-fixture/regular.ts"), "Ordinary package input must be retained");
  assert.ok(!listing.includes("synthetic-package-fixture/.env"), "Archive must exclude credential fixture");
  assert.ok(!listing.includes("synthetic-package-fixture/session.jsonl"), "Archive must exclude session fixture");
  assert.ok(!listing.includes("src/native/linux_fs_bridge.node"), "Archive must exclude host native binary");
  const before = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const repeat = spawnSync("bash", [path.join(source, "scripts", "package-release.sh"), out]);
  assert.notEqual(repeat.status, 0, "Packaging must refuse to replace an existing version");
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), before, "Refusal must preserve existing archive bytes");
  console.log("Package synthetic credential and session exclusion: PASS");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
