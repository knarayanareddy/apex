import { spawn } from "node:child_process";
import { acquireWorkspaceLock } from "../../src/core/workspace-lock.ts";

const [workspaceRoot] = process.argv.slice(2);
if (!workspaceRoot) {
  process.stderr.write("Usage: lock-holder-worker.ts <workspaceRoot>\n");
  process.exit(2);
}

// Acquire kernel-owned flock (with O_CLOEXEC enforced in C broker)
const lock = acquireWorkspaceLock(workspaceRoot);
lock.assertHeld();

// Spawn a surviving detached grandchild process WHILE holding `lockFd`!
// Because `lockFd` carries `FD_CLOEXEC`, `execve("/bin/sleep", ...)` closes `lockFd` in the grandchild,
// so killing THIS parent worker with SIGKILL MUST release the flock immediately even while grandchild lives!
const grandchild = spawn("sleep", ["60"], {
  detached: true,
  stdio: "ignore"
});
grandchild.unref();

process.stdout.write(`FLOCK_ACQUIRED:${lock.lockToken}:GRANDCHILD:${grandchild.pid ?? 0}\n`);

setInterval(() => {
  // Stay alive holding open lockFd until SIGKILL
}, 1000);
