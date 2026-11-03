/** Diagnostic candidate only. Does not qualify process ownership or parent death. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";

const binary = process.env.PID1_CANDIDATE;
if (!binary || !fs.existsSync(binary)) throw new Error("PID1_CANDIDATE binary missing");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pid1-candidate-"));
let passed = false;
try {
  for (const mode of ["immediate", "started"] as const) {
    for (let i = 0; i < 10; i++) {
      const marker = path.join(ws, `${mode}-${i}`);
      const command = `echo candidate-ready; sleep 2; printf synthetic > '${marker}'`;
      const args = buildMinimalBwrapArgv(command, ws, { workspaceRoot: ws, mode: "workspace-write" });
      const deathOption = args.indexOf("--die-with-parent");
      if (deathOption < 0) throw new Error("expected --die-with-parent argument");
      args.splice(deathOption, 1); // Diagnostic: parent-death semantics are NOT qualified.
      const separator = args.lastIndexOf("--");
      args.splice(separator, 0, "--as-pid-1", "--sync-fd", "3", "--ro-bind", binary, "/apex-pid1-candidate");
      const cmdIndex = args.lastIndexOf("--") + 1;
      args.splice(cmdIndex, args.length - cmdIndex, "/apex-pid1-candidate", "/bin/bash", "-c", command);
      const child = spawn("bwrap", args, { cwd: ws, env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"] });
      const ctl = child.stdio[3]!;
      if (!(ctl instanceof Duplex)) throw new Error("control pipe is not duplex");
      let controlData = "";
      let output = "";
      let errors = "";
      ctl.on("data", (data: Buffer) => { controlData += data.toString(); });
      child.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
      child.stderr!.on("data", (data: Buffer) => { errors += data.toString(); });
      const closed = once(child, "close");
      if (mode === "immediate") {
        ctl.end();
      } else {
        const deadline = Date.now() + 5000;
        while (!controlData.includes("R") && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        if (!controlData.includes("R")) throw new Error(`candidate not ready: ${errors}`);
        ctl.write("S");
        while (!output.includes("candidate-ready") && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        if (!output.includes("candidate-ready")) throw new Error(`payload not ready: ${errors}`);
        ctl.end();
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`candidate did not close: ${mode} ${i}`)), 5000); })]);
      } finally { if (timer) clearTimeout(timer); }
      const wrote = fs.existsSync(marker);
      console.log("PID1_CANDIDATE_CONTROL", JSON.stringify({ mode, iteration: i + 1, marker: wrote, exitCode: child.exitCode, signalCode: child.signalCode }));
      if (wrote) throw new Error(`candidate permitted post-cancel effect: ${mode} ${i}`);
      if (child.exitCode !== 0) throw new Error(`candidate exited unexpectedly: ${mode} ${i} ${errors}`);
    }
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(ws, { recursive: true, force: true });
  else console.error(`PID1 candidate fixture retained at: ${ws}`);
}
