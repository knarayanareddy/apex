/** Validate the supervisor from a packaged and independently installed artifact. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("Linux PTY package regression: SKIPPED (non-Linux)");
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-package-"));
const source = path.join(base, "source");
const out = path.join(base, "out");
const extracted = path.join(base, "extracted");
const prefix = path.join(base, "prefix");
let passed = false;
try {
  fs.mkdirSync(source);
  for (const item of ["package.json", "package-lock.json", "tsconfig.json", "SPEC_BIBLE.md", "ARCHITECTURE.md", "PERSONAL_QUICKSTART.md", "bin", "extensions", "scripts", "src", "surfaces", "surfaces-immutable", "test"]) {
    fs.cpSync(path.join(root, item), path.join(source, item), { recursive: true });
  }
  execFileSync("bash", [path.join(source, "scripts/package-release.sh"), out], { stdio: "inherit" });
  const version = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version as string;
  const archive = path.join(out, `pi-apex-v${version}-personal.tar.gz`);
  fs.mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const installed = path.join(extracted, "pi-apex-harness");
  const binary = path.join(installed, "src/native/apex_pty_pid1");
  assert.ok(fs.existsSync(path.join(installed, "src/native/pty_pid1_supervisor.c")));
  assert.equal(fs.existsSync(binary), false, "portable archive must not contain a host-specific supervisor");
  const env = { ...process.env, HOME: base, npm_config_offline: "true", npm_config_cache: process.env.npm_config_cache ?? path.join(os.homedir(), ".npm") };
  execFileSync("bash", [path.join(installed, "scripts/install-personal.sh"), "--prefix", prefix], { cwd: installed, env, stdio: "inherit", timeout: 120_000 });
  assert.ok(fs.existsSync(binary), "installed artifact must build its own supervisor");

  const deny = (workspace: string, expected: string) => {
    const code = `import assert from 'node:assert/strict';import {PtyLeaseManager} from './src/ring2/pty-cron-routines.ts';import {loadVerifiedGuardrails} from './src/core/guardrail-pin.ts';const m=new PtyLeaseManager({workspaceRoot:process.argv[1],guardrails:loadVerifiedGuardrails().config});assert.throws(()=>m.start({command:'echo MUST_NOT_RUN'}),new RegExp(process.argv[2]));`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, workspace, expected], { cwd: installed, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `supervisor denial failed: ${result.stdout}\n${result.stderr}`);
  };
  deny(installed, "supervisor is reachable through the writable workspace");
  const savedBinary = `${binary}.saved-by-test`;
  assert.equal(fs.existsSync(savedBinary), false);
  fs.renameSync(binary, savedBinary);
  try {
    const workspace = path.join(base, "missing-supervisor-workspace");
    fs.mkdirSync(workspace);
    deny(workspace, "SANDBOX_UNAVAILABLE");
  } finally {
    fs.renameSync(savedBinary, binary);
  }
  execFileSync(process.execPath, ["--experimental-strip-types", "test/canaries/linux-pty-owned-regression.spec.ts"], { cwd: installed, env, stdio: "inherit", timeout: 120_000 });
  passed = true;
  console.log("Linux installed artifact supervised PTY: PASS");
} finally {
  if (passed) fs.rmSync(base, { recursive: true, force: true });
  else console.error(`PTY package failure evidence retained at: ${base}`);
}
