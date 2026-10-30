import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";
import { findWorkspaceGitRoots } from "../../src/core/safe-path.ts";

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "apex-git-discovery-")));
const repos = [
  path.join(ws, ...Array.from({ length: 8 }, (_, i) => `d${i}`)),
  path.join(ws, "node_modules", "package"),
  path.join(ws, ".venv", "repository"),
  path.join(ws, "nested", ".harness", "repository")
];
for (const repo of repos) {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
}
const roots = findWorkspaceGitRoots(ws);
for (const repo of repos) assert.ok(roots.includes(repo), `missing repository ${repo}`);
const argv = buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws });
for (const repo of repos) {
  const objects = fs.realpathSync(path.join(repo, ".git", "objects"));
  assert.ok(argv.some((arg, i) => arg === "--tmpfs" && argv[i + 1] === objects), `objects not masked for ${repo}`);
}

const blocked = path.join(ws, "unreadable");
fs.mkdirSync(blocked);
const originalReadDir = fs.readdirSync;
try {
  (fs as any).readdirSync = (...args: any[]) => {
    if (args[0] === blocked) throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    return (originalReadDir as any)(...args);
  };
  assert.throws(() => findWorkspaceGitRoots(ws), /EACCES|incomplete|discover/i);
} finally {
  (fs as any).readdirSync = originalReadDir;
}
const deep = fs.mkdtempSync(path.join(os.tmpdir(), "apex-git-limit-"));
fs.mkdirSync(path.join(deep, ...Array.from({ length: 33 }, (_, i) => `d${i}`)), { recursive: true });
assert.throws(() => findWorkspaceGitRoots(deep), /scan limit/i);
const malformed = fs.mkdtempSync(path.join(os.tmpdir(), "apex-git-bad-metadata-"));
fs.writeFileSync(path.join(malformed, ".git"), "not a gitdir pointer");
assert.throws(() => buildMinimalBwrapArgv("true", malformed, { workspaceRoot: malformed }), /Cannot resolve Git metadata/);
const linked = fs.mkdtempSync(path.join(os.tmpdir(), "apex-git-symlink-"));
fs.symlinkSync(path.join(repos[0], ".git"), path.join(linked, ".git"));
assert.throws(() => findWorkspaceGitRoots(linked), /Unsafe .git metadata/);
console.log("nested Git discovery and masking: PASS");
