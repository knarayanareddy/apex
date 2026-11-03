import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "apex-package-required-"));
const source = path.join(temporary, "source");
fs.mkdirSync(source);
let passed = false;
try {
  for (const item of ["package.json", "package-lock.json", "tsconfig.json", "SPEC_BIBLE.md", "ARCHITECTURE.md", "PERSONAL_QUICKSTART.md", "bin", "extensions", "scripts", "src", "surfaces", "surfaces-immutable", "test"]) {
    fs.cpSync(path.join(root, item), path.join(source, item), { recursive: true });
  }
  for (const [index, item] of ["SPEC_BIBLE.md", "src", "scripts/install-personal.sh", "scripts/build-native.mjs", "src/native/pty_pid1_supervisor.c", "package.json"].entries()) {
    const input = path.join(source, item);
    const saved = path.join(temporary, `saved-${index}`);
    const out = path.join(temporary, `out-${index}`);
    fs.renameSync(input, saved);
    const result = spawnSync("bash", [path.join(source, "scripts", "package-release.sh"), out], { encoding: "utf8" });
    fs.writeFileSync(path.join(temporary, `result-${index}.txt`), `status=${String(result.status)}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.equal(result.error, undefined, `Could not execute packaging script: ${String(result.error)}`);
    assert.notEqual(result.status, 0, `Missing ${item} must make packaging fail`);
    assert.ok(result.stderr.includes(`PACKAGE_INPUT_MISSING: ${item}`), `Failure must identify missing ${item}`);
    assert.equal(fs.existsSync(out), false, `Missing ${item} must be rejected before producing an output directory`);
    fs.renameSync(saved, input);
  }
  passed = true;
  console.log("Package rejects a missing required input: PASS");
} finally {
  if (passed) fs.rmSync(temporary, { recursive: true });
  else console.error(`Package missing-input failure evidence retained: ${temporary}`);
}
