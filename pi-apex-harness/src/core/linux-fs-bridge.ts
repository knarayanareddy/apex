import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FstatAtEntry {
  kind: "file" | "dir" | "symlink" | "other";
  mode: number;
  dev: number;
  ino: number;
  nlink: number;
  size: number;
}

export interface LinuxFsBridge {
  openRootDir(absPath: string): number;
  openBeneath(dirFd: number, relPath: string, flags: number, mode: number): number;
  hasCloexec(fd: number): boolean;
  mkdiratSingle(parentDirFd: number, singleName: string, mode: number): void;
  renameatSingle(oldDirFd: number, oldName: string, newDirFd: number, newName: string): void;
  unlinkatSingle(parentDirFd: number, singleName: string, removeDir: boolean): void;
  fstatatNoFollow(parentDirFd: number, singleName: string): FstatAtEntry | null;
  readlinkatSingle(parentDirFd: number, singleName: string): string;
  flockExNb(fd: number): void;
  flockUn(fd: number): void;
  getFdPath?(fd: number): string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.resolve(__dirname, "../native");
const C_SRC_PATH = path.join(NATIVE_DIR, "linux_fs_bridge.c");
const ADDON_PATH = path.join(NATIVE_DIR, "linux_fs_bridge.node");

let cachedBridge: LinuxFsBridge | null = null;

function ensureNativeBridgeCompiled(): void {
  if (fs.existsSync(ADDON_PATH)) {
    const srcMtime = fs.statSync(C_SRC_PATH).mtimeMs;
    const binMtime = fs.statSync(ADDON_PATH).mtimeMs;
    if (binMtime >= srcMtime) return;
  }
  const includeCandidates = [
    "/usr/include/node",
    "/opt/homebrew/include/node",
    "/usr/local/include/node",
    path.resolve(process.execPath, "../../include/node"),
    path.resolve(process.execPath, "../../../include/node")
  ];
  const nodeInclude = includeCandidates.find((p) => fs.existsSync(path.join(p, "node_api.h")));
  if (!nodeInclude) {
    throw new Error(
      `Missing node_api.h in [${includeCandidates.join(", ")}]; run scripts/bootstrap-host.sh`
    );
  }
  const isDarwin = process.platform === "darwin";
  const compiler = isDarwin ? "clang" : "gcc";
  const flags = isDarwin
    ? [
        "-dynamiclib",
        "-undefined",
        "dynamic_lookup",
        "-fPIC",
        "-O2",
        "-Wall",
        "-Wextra",
        "-DNODE_GYP_MODULE_NAME=linux_fs_bridge",
        `-I${nodeInclude}`,
        C_SRC_PATH,
        "-o",
        ADDON_PATH
      ]
    : [
        "-shared",
        "-fPIC",
        "-O2",
        "-Wall",
        "-Wextra",
        "-DNODE_GYP_MODULE_NAME=linux_fs_bridge",
        `-I${nodeInclude}`,
        C_SRC_PATH,
        "-o",
        ADDON_PATH
      ];
  execFileSync(compiler, flags, { stdio: "pipe" });
}

export function getLinuxFsBridge(): LinuxFsBridge {
  if (cachedBridge) return cachedBridge;
  ensureNativeBridgeCompiled();
  const req = createRequire(import.meta.url);
  cachedBridge = req(ADDON_PATH) as LinuxFsBridge;
  return cachedBridge;
}

export function extractNativeErrnoCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && code !== "ERR_GENERIC_FAILURE") return code;
  const m = err.message.match(/\(([A-Z0-9_]+)\)$/);
  return m?.[1];
}
