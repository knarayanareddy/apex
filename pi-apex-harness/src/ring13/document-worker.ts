import { spawn } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DOCUMENT_WORKER_SCRIPT } from "./document-worker-script.ts";

const MAX_INPUT = 38 * 1024 * 1024;
const MAX_OUTPUT = 36 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 35_000;
let isolationAvailable: boolean | undefined;
let bwrapPath: string | undefined;

export class DocumentIsolationError extends Error {
  constructor(message: string) { super(message); this.name = "DocumentIsolationError"; }
}
export class DocumentWorkerError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Isolated document worker reported ${code}.`); this.name = "DocumentWorkerError"; this.code = code; }
}

function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

interface ParserPackage { name: string; path: string }

async function parserPackageBindings(modulesRoot: string): Promise<ParserPackage[]> {
  const root = await realpath(modulesRoot);
  const queue: Array<{ name: string; parent: string }> = [
    { name: "officeparser", parent: root },
    { name: "pdf-lib", parent: root },
  ];
  const seen = new Set<string>();
  const bindings = new Map<string, string>();
  while (queue.length) {
    const item = queue.shift()!;
    let entry: string;
    try { entry = createRequire(path.join(item.parent, "package.json")).resolve(item.name); }
    catch { continue; }
    let packageDir = path.dirname(await realpath(entry));
    let manifest: any;
    while (packageDir !== path.dirname(packageDir)) {
      try {
        const raw = JSON.parse(await fs.promises.readFile(path.join(packageDir, "package.json"), "utf8"));
        if (raw.name === item.name) { manifest = raw; break; }
      } catch { /* ascend until the containing package manifest is found */ }
      packageDir = path.dirname(packageDir);
    }
    if (!manifest) throw new DocumentIsolationError(`Could not resolve parser dependency ${item.name}.`);
    const resolvedDir = await realpath(packageDir);
    const relative = path.relative(root, resolvedDir);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new DocumentIsolationError(`Parser dependency ${item.name} resolves outside node_modules.`);
    const identity = `${item.name}:${resolvedDir}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!bindings.has(item.name)) bindings.set(item.name, resolvedDir);
    const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) } as Record<string, string>;
    for (const name of Object.keys(dependencies)) queue.push({ name, parent: resolvedDir });
  }
  return [...bindings].map(([name, packagePath]) => ({ name, path: packagePath }));
}

function buildArgs(nodePath: string, packages: ParserPackage[], script: string): string[] {
  const args = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--size", "67108864", "--tmpfs", "/tmp",
    "--dir", "/opt", "--dir", "/opt/pi-apex", "--ro-bind", nodePath, "/opt/pi-apex/node",
    "--dir", "/app", "--dir", "/app/node_modules",
    "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp",
    "--chdir", "/app", "--", "/usr/bin/prlimit", "--cpu=30", "--fsize=67108864", "--nproc=64", "--nofile=256", "--",
    "/opt/pi-apex/node", "--max-old-space-size=512", "--input-type=module", "-e", script,
  ];
  const createdDirs = new Set(["/app", "/app/node_modules"]);
  const mounts: string[] = [];
  for (const pkg of packages) {
    const segments = pkg.name.split("/");
    let target = "/app/node_modules";
    for (const segment of segments) {
      target += `/${segment}`;
      if (createdDirs.has(target)) continue;
      mounts.push("--dir", target);
      createdDirs.add(target);
    }
    mounts.push("--ro-bind", pkg.path, target);
  }
  args.splice(args.indexOf("--setenv"), 0, ...mounts);
  return args;
}

async function commandExists(): Promise<boolean> {
  if (isolationAvailable !== undefined) return isolationAvailable;
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
    try {
      const resolved = await realpath(candidate);
      const executable = await fs.promises.stat(resolved);
      const parent = await fs.promises.stat(path.dirname(resolved));
      if (!executable.isFile() || !(executable.mode & 0o111) || executable.uid !== 0 || (executable.mode & 0o022) !== 0 || parent.uid !== 0 || (parent.mode & 0o022) !== 0) continue;
      bwrapPath = resolved;
      break;
    } catch { /* candidate absent or not a trusted root-owned executable */ }
  }
  if (!bwrapPath) { isolationAvailable = false; return false; }
  const child = spawn(bwrapPath, ["--version"], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore"] });
  isolationAvailable = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 1500);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  return isolationAvailable;
}

export async function runDocumentWorker(request: Record<string, unknown>, signal?: AbortSignal, timeoutMs = WORKER_TIMEOUT_MS): Promise<any> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_TIMEOUT_MS) throw new RangeError("Worker timeout must be 1–35,000 ms.");
  if (!(await commandExists())) throw new DocumentIsolationError("Document processing is disabled: bubblewrap (bwrap) is not installed or available. No in-process parsing fallback is permitted.");
  if (signal?.aborted) throw new DocumentIsolationError("Isolated document processing was cancelled before launch.");
  const root = projectRoot();
  const nodeReal = await realpath(process.execPath);
  const modulesReal = await realpath(path.join(root, "node_modules"));
  const parserPackages = await parserPackageBindings(modulesReal);
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.length > MAX_INPUT) throw new Error("Document worker request exceeds the 38 MiB limit.");
  const child = spawn(bwrapPath!, buildArgs(nodeReal, parserPackages, DOCUMENT_WORKER_SCRIPT), {
    cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), settled = false;
  const cleanupSignal = () => signal?.removeEventListener("abort", onAbort);
  const fail = (error: Error) => {
    if (settled) return;
    settled = true; clearTimeout(timer); cleanupSignal();
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    rejectPromise(error);
  };
  const onAbort = () => fail(new DocumentIsolationError("Isolated document processing was cancelled."));
  let rejectPromise!: (error: Error) => void;
  const result = new Promise<any>((resolve, reject) => {
    rejectPromise = reject;
    child.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); cleanupSignal(); reject(new DocumentIsolationError("Could not start isolated document worker.")); } });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT) { fail(new DocumentIsolationError("Isolated document worker output exceeded the hard limit.")); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr = Buffer.concat([stderr, chunk.subarray(0, 4096 - stderr.length)]); });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cleanupSignal();
      if (code !== 0) { const detail = stderr.toString("utf8").replace(/[\r\n]+/g, " ").slice(0, 500); reject(new DocumentIsolationError(`Isolated document worker failed${signal ? ` (${signal})` : ` (exit ${code})`}${detail ? `: ${detail}` : ""}.`)); return; }
      try {
        const message = JSON.parse(stdout.toString("utf8"));
        if (message?.ok === false && typeof message.code === "string" && /^DOCUMENT_[A-Z_]+$/.test(message.code)) { reject(new DocumentWorkerError(message.code)); return; }
        if (message?.ok !== true || !message.result || typeof message.result !== "object") throw new Error("invalid worker response");
        resolve(message.result);
      } catch (error) { reject(new DocumentIsolationError(`Isolated document worker returned an invalid response: ${String(error).slice(0, 300)}`)); }
    });
  });
  const timer = setTimeout(() => fail(new DocumentIsolationError(`Isolated document worker exceeded the ${timeoutMs} ms time limit.`)), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  else child.stdin.end(input);
  return result;
}
