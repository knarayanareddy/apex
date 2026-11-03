/** Production-path parent-death diagnostic; signal only the test-owned parent. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
  console.log("Linux PTY parent-death regression: SKIPPED (non-Linux)");
  process.exit(0);
}
const base = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pty-manager-parent-"));
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "pty-manager-parent-runner.ts");
let passed = false;
try {
  for (const mode of ["immediate", "started"] as const) {
    for (let i = 0; i < 8; i++) {
      const ws = path.join(base, `${mode}-${i}`);
      fs.mkdirSync(ws);
      const parent = spawn(process.execPath, ["--experimental-strip-types", runner, mode, ws], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let errors = "";
      parent.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      parent.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      const closed = once(parent, "close");
      const deadline = Date.now() + 6000;
      while (!out.includes("\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      if (!out.includes("\n")) throw new Error(`test parent did not announce its owned child: ${errors}`);
      const info = JSON.parse(out.trim()) as { pid: number; startTicks: string };
      if (!parent.kill("SIGKILL")) throw new Error("could not terminate test-owned parent");
      await closed;
      const stopDeadline = Date.now() + 6000;
      let stopped = false;
      while (Date.now() < stopDeadline) {
        try {
          const stat = fs.readFileSync(`/proc/${info.pid}/stat`, "utf8");
          const right = stat.lastIndexOf(")");
          if (right < 0) throw new Error("malformed owned process stat");
          const fields = stat.slice(right + 2).trim().split(/\s+/);
          if (fields.length <= 19) throw new Error("short owned process stat");
          stopped = fields[19] !== info.startTicks || fields[0] === "Z";
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          stopped = true;
        }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const effect = fs.existsSync(path.join(ws, "effect"));
      console.log("PTY_MANAGER_PARENT_DEATH", JSON.stringify({ mode, iteration: i + 1, stopped, effect }));
      if (!stopped || effect) throw new Error(`PTY manager parent-death control failed: ${mode} ${i + 1}`);
    }
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(base, { recursive: true, force: true });
  else console.error(`PTY manager parent-death fixture retained at: ${base}`);
}
