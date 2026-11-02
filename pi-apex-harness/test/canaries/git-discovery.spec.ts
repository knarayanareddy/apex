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

// Alternate object store in nested repo (objects/info/alternates)
const altStore = path.join(ws, "external-alt-objects");
fs.mkdirSync(altStore, { recursive: true });
const nestedWithAlt = path.join(ws, "nested-alt-repo");
fs.mkdirSync(nestedWithAlt, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: nestedWithAlt });
const altInfoDir = path.join(nestedWithAlt, ".git", "objects", "info");
fs.mkdirSync(altInfoDir, { recursive: true });
fs.writeFileSync(path.join(altInfoDir, "alternates"), `${altStore}\n`);

const rootsWithAlt = findWorkspaceGitRoots(ws);
assert.ok(rootsWithAlt.includes(nestedWithAlt), `missing nested-alt-repo ${nestedWithAlt}`);
const argvWithAlt = buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws });
const realAltStore = fs.realpathSync(altStore);
assert.ok(
  argvWithAlt.some((arg, i) => arg === "--tmpfs" && argvWithAlt[i + 1] === realAltStore),
  "alternate object store in nested repo must be masked via --tmpfs"
);

// Unresolvable alternate in a nested repo must fail closed
const badAltRepo = fs.mkdtempSync(path.join(os.tmpdir(), "apex-git-bad-alt-"));
execFileSync("git", ["init", "-q"], { cwd: badAltRepo });
const badAltInfo = path.join(badAltRepo, ".git", "objects", "info");
fs.mkdirSync(badAltInfo, { recursive: true });
fs.writeFileSync(path.join(badAltInfo, "alternates"), `/nonexistent/path/to/alt-objects\n`);
assert.throws(
  () => buildMinimalBwrapArgv("true", badAltRepo, { workspaceRoot: badAltRepo }),
  /Cannot isolate unresolvable Git alternate object store/
);

// Nested linked worktree (.git file pointing to another repo)
const mainRepo = path.join(ws, "main-repo");
fs.mkdirSync(mainRepo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: mainRepo });
execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo });
execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo });
fs.writeFileSync(path.join(mainRepo, "README.md"), "hello\n");
execFileSync("git", ["add", "README.md"], { cwd: mainRepo });
execFileSync("git", ["commit", "-m", "init"], { cwd: mainRepo });

const linkedWt = path.join(ws, "linked-wt");
execFileSync("git", ["worktree", "add", linkedWt, "-b", "wt-branch"], { cwd: mainRepo });
const rootsWithWt = findWorkspaceGitRoots(ws);
assert.ok(rootsWithWt.includes(linkedWt), "findWorkspaceGitRoots must find linked worktrees");
const argvWithWt = buildMinimalBwrapArgv("true", ws, { workspaceRoot: ws });
const wtGitDir = fs.realpathSync(path.join(mainRepo, ".git", "worktrees", "linked-wt"));
assert.ok(
  argvWithWt.some((arg, i) => arg === "--bind" && argvWithWt[i + 1] === wtGitDir),
  "linked worktree gitdir must be bound"
);

console.log("nested Git discovery and masking: PASS");
