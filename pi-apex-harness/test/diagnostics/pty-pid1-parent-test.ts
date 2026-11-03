/** Diagnostic only: observe parent-death teardown without signalling descendants. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readProcStartTimeTicks } from "../../src/core/workspace-lock.ts";

const binary = process.env.PID1_CANDIDATE;
if (!binary || !fs.existsSync(binary)) throw new Error("PID1_CANDIDATE binary missing");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pid1-parent-"));
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-pid1-parent-runner.ts");
let passed = false;
try {
  for (const mode of ["immediate", "started"] as const) {
    for (let i = 0; i < 10; i++) {
      const ws = path.join(base, `${mode}-${i}`);
      fs.mkdirSync(ws);
      const parent = spawn(process.execPath, ["--experimental-strip-types", runner, mode, ws, binary], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let errors = "";
      parent.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      parent.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      const [exitCode] = await once(parent, "close");
      if (exitCode !== 0) throw new Error(`test parent failed: ${errors}`);
      const info = JSON.parse(out.trim()) as { pid: number; startTicks: string };
      const deadline = Date.now() + 6000;
      let stopped = false;
      while (Date.now() < deadline) {
        const ticks = readProcStartTimeTicks(info.pid);
        let state = "";
        try {
          const stat = fs.readFileSync(`/proc/${info.pid}/stat`, "utf8");
          state = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0];
        } catch { /* exited */ }
        stopped = !ticks || ticks !== info.startTicks || state === "Z";
        if (stopped && fs.existsSync(path.join(ws, "pid1-ready"))) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const witnessed = fs.existsSync(path.join(ws, "pid1-ready"));
      const effect = fs.existsSync(path.join(ws, "effect"));
      console.log("PID1_PARENT_DEATH_CONTROL", JSON.stringify({ mode, iteration: i + 1, witnessed, stopped, effect }));
      if (!witnessed || !stopped || effect) throw new Error(`parent-death control failed: ${mode} ${i + 1}`);
    }
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(base, { recursive: true, force: true });
  else console.error(`Parent-death candidate fixture retained at: ${base}`);
}
