/** Diagnostic only: verify detached and reparented children by SO_PEERCRED. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { buildMinimalBwrapArgv } from "../../src/core/bwrap-sandbox.ts";

const binary = process.env.PID1_CANDIDATE;
if (!binary || !fs.existsSync(binary)) throw new Error("PID1_CANDIDATE binary missing");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "apex-pid1-detached-"));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) return false; await wait(20); }
  return true;
}
let passed = false;
try {
  for (const mode of ["cancel-detached", "natural-reparented"] as const) {
    const ws = path.join(base, mode);
    fs.mkdirSync(ws);
    const socket = path.join(ws, "peer.sock");
    const serverReady = path.join(ws, "server-ready");
    const identityFile = path.join(ws, "identity.json");
    const childReady = path.join(ws, "child-ready");
    const marker = path.join(ws, "effect");
    const serverScript = [
      "import json,os,pathlib,socket,struct",
      "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
      `s.bind(${JSON.stringify(socket)})`, "s.listen(1)", "s.settimeout(10)",
      `pathlib.Path(${JSON.stringify(serverReady)}).write_text('ready')`,
      "c,_=s.accept()", "c.recv(1)",
      "pid,uid,gid=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))",
      "assert uid==os.getuid()", "raw=pathlib.Path('/proc/%d/stat'%pid).read_text()",
      "fields=raw[raw.rfind(')')+1:].split()",
      "nspid=next(x for x in pathlib.Path('/proc/%d/status'%pid).read_text().splitlines() if x.startswith('NSpid:'))",
      `pathlib.Path(${JSON.stringify(identityFile)}).write_text(json.dumps({'pid':pid,'start':fields[19],'session':int(fields[3]),'nspid':[int(x) for x in nspid.split()[1:]],'namespace':os.readlink('/proc/%d/ns/pid'%pid)}))`,
      "c.sendall(b'1')", "c.close()", "s.close()"
    ].join("\n");
    const server = spawn("python3", ["-c", serverScript], { stdio: ["ignore", "ignore", "pipe"] });
    let serverError = "";
    server.stderr.on("data", (chunk: Buffer) => { serverError += chunk.toString(); });
    const serverClosed = once(server, "close");
    assert.ok(await until(() => fs.existsSync(serverReady), 5000), `server not ready: ${serverError}`);

    const detachedBody = [
      "os.setsid()", "s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)",
      `s.connect(${JSON.stringify(socket)})`, "s.sendall(b'x')", "assert s.recv(1)==b'1'", "s.close()",
      `pathlib.Path(${JSON.stringify(childReady)}).write_text('ready')`, "time.sleep(20)",
      `pathlib.Path(${JSON.stringify(marker)}).write_text('unexpected')`, "os._exit(0)"
    ];
    const lines = ["import os,pathlib,socket,time"];
    if (mode === "natural-reparented") {
      lines.push("p=os.fork()", "if p==0:", "  q=os.fork()", "  if q==0:");
      lines.push(...detachedBody.map((line) => `    ${line}`));
      lines.push("  os._exit(0)", "os.waitpid(p,0)", `while not pathlib.Path(${JSON.stringify(childReady)}).exists(): time.sleep(0.01)`, "os._exit(0)");
    } else {
      lines.push(...detachedBody);
    }
    const script = path.join(ws, "child.py");
    fs.writeFileSync(script, lines.join("\n") + "\n");
    const args = buildMinimalBwrapArgv(`exec python3 ${quote(script)}`, ws, { workspaceRoot: ws, mode: "workspace-write" });
    const deathOption = args.indexOf("--die-with-parent");
    assert.ok(deathOption >= 0);
    args.splice(deathOption, 1);
    args.splice(args.lastIndexOf("--"), 0, "--as-pid-1", "--sync-fd", "3", "--ro-bind", binary, "/apex-pid1-candidate");
    const commandIndex = args.lastIndexOf("--") + 1;
    args.splice(commandIndex, args.length - commandIndex, "/apex-pid1-candidate", "/bin/bash", "-c", `exec python3 ${quote(script)}`);
    const child = spawn("bwrap", args, { cwd: ws, env: {}, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const ctl = child.stdio[3];
    assert.ok(ctl instanceof Duplex);
    let controlData = "";
    let errors = "";
    ctl.on("data", (chunk: Buffer) => { controlData += chunk.toString(); });
    child.stdout!.resume();
    child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const closed = once(child, "close");
    assert.ok(await until(() => controlData.includes("R"), 5000), `candidate not ready: ${errors}`);
    ctl.write("S");
    assert.ok(await until(() => fs.existsSync(identityFile) && fs.existsSync(childReady), 5000), `detached child not ready: ${errors} ${serverError}`);
    const identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as { pid: number; start: string; session: number; nspid: number[]; namespace: string };
    assert.ok(identity.nspid.length >= 2 && identity.nspid.at(-1)! > 1);
    assert.equal(identity.session, identity.pid);
    assert.notEqual(identity.namespace, fs.readlinkSync("/proc/self/ns/pid"));
    const alive = () => {
      try {
        const stat = fs.readFileSync(`/proc/${identity.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        return fields[19] === identity.start && fields[0] !== "Z" && fields[0] !== "X";
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    };
    if (mode === "cancel-detached") {
      assert.ok(alive(), "detached child must be alive before control EOF");
      ctl.end();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`candidate did not close: ${mode}`)), 5000); })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.ok(await until(() => !alive(), 2000), `detached child survived ${mode}`);
    assert.equal(fs.existsSync(marker), false);
    assert.equal((await serverClosed)[0], 0);
    console.log("PID1_DETACHED_CONTROL", JSON.stringify({ mode, killed: !alive(), marker: false }));
  }
  passed = true;
} finally {
  if (passed) fs.rmSync(base, { recursive: true, force: true });
  else console.error(`Detached candidate fixture retained at: ${base}`);
}
