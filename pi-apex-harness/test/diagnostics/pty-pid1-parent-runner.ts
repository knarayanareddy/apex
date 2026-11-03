/** Test-owned parent process; exits abruptly without signalling its bwrap child. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";
import { readProcStartTimeTicks } from "../../src/core/workspace-lock.ts";

const [mode, ws, binary] = process.argv.slice(2);
if (!mode || !ws || !binary || !["immediate", "started"].includes(mode)) throw new Error("invalid diagnostic arguments");
const witness = path.join(ws, "pid1-ready");
const marker = path.join(ws, "effect");
const command = `echo candidate-ready; sleep 2; printf synthetic > '${marker}'`;
const args = buildMinimalBwrapArgv(command, ws, { workspaceRoot: ws, mode: "workspace-write" });
const deathOption = args.indexOf("--die-with-parent");
if (deathOption < 0) throw new Error("expected --die-with-parent");
args.splice(deathOption, 1); // Candidate only: EOF is its parent-death mechanism.
args.splice(args.lastIndexOf("--"), 0, "--as-pid-1", "--sync-fd", "3", "--ro-bind", binary, "/apex-pid1-candidate", "--setenv", "APEX_DIAG_READY_PATH", witness);
const commandIndex = args.lastIndexOf("--") + 1;
args.splice(commandIndex, args.length - commandIndex, "/apex-pid1-candidate", "/bin/bash", "-c", command);
const child = spawn("bwrap", args, { cwd: ws, env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"] });
const control = child.stdio[3];
if (!(control instanceof Duplex) || !child.pid) throw new Error("missing owned child control pipe");
const startTicks = readProcStartTimeTicks(child.pid);
if (!startTicks) throw new Error("cannot establish child identity");
let controlData = "";
let output = "";
let errors = "";
control.on("data", (chunk: Buffer) => { controlData += chunk.toString(); });
child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
if (mode === "started") {
  const deadline = Date.now() + 5000;
  while (!controlData.includes("R") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!controlData.includes("R")) throw new Error(`PID1 did not become ready: ${errors}`);
  control.write("S");
  while (!output.includes("candidate-ready") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  if (!output.includes("candidate-ready")) throw new Error(`payload did not become ready: ${errors}`);
}
fs.writeSync(1, JSON.stringify({ pid: child.pid, startTicks, mode }) + "\n");
process.exit(0); // Simulates abrupt parent death; closes only this process's descriptors.
