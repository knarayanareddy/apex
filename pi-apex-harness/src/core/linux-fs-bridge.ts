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

export function checkAddonBinaryCompatibility(addonPath: string): {
  compatible: boolean;
  format: "elf" | "macho" | "unknown";
  reason?: string;
} {
  try {
    const fd = fs.openSync(addonPath, "r");
    const buf = Buffer.alloc(64);
    let length: number;
    try {
      length = fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    const isElf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46; // \x7fELF
    const isMachO =
      (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) || // 64-bit little endian
      (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xcf) || // 64-bit big endian
      (buf[0] === 0xce && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) || // 32-bit little endian
      (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && buf[3] === 0xce);   // 32-bit big endian

    const detectedFormat = isElf ? "elf" : isMachO ? "macho" : "unknown";

    if (process.arch !== "arm64" && process.arch !== "x64") {
      return { compatible: false, format: detectedFormat, reason: `Unsupported native addon architecture: ${process.arch}` };
    }

    if (process.platform === "linux") {
      const expectedMachine = process.arch === "arm64" ? 183 : 62;
      if (!isElf || length < 64 || buf[4] !== 2 || buf[5] !== 1 || buf[6] !== 1 || buf.readUInt16LE(18) !== expectedMachine) {
        return {
          compatible: false,
          format: detectedFormat,
          reason: `Native addon '${addonPath}' is not a compatible 64-bit Linux ELF for ${process.arch}.`
        };
      }
    } else if (process.platform === "darwin") {
      const expectedCpu = process.arch === "arm64" ? 0x0100000c : 0x01000007;
      const is64BitLittleEndianMachO = buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe;
      if (!is64BitLittleEndianMachO || length < 32 || buf.readUInt32LE(4) !== expectedCpu) {
        return {
          compatible: false,
          format: detectedFormat,
          reason: `Native addon '${addonPath}' is not a compatible 64-bit macOS Mach-O for ${process.arch}.`
        };
      }
    } else {
      return { compatible: false, format: detectedFormat, reason: `Unsupported native addon platform: ${process.platform}` };
    }
    return { compatible: true, format: detectedFormat };
  } catch (err) {
    return { compatible: false, format: "unknown", reason: String(err) };
  }
}

function ensureNativeBridgeCompiled(): void {
  if (fs.existsSync(ADDON_PATH)) {
    const compat = checkAddonBinaryCompatibility(ADDON_PATH);
    if (!compat.compatible) {
      console.warn(`[APEX_NATIVE_LOADER] ${compat.reason}. Recompiling for current host...`);
      try {
        fs.unlinkSync(ADDON_PATH);
      } catch {
        // ignore
      }
    } else {
      const srcMtime = fs.statSync(C_SRC_PATH).mtimeMs;
      const binMtime = fs.statSync(ADDON_PATH).mtimeMs;
      if (binMtime >= srcMtime) return;
    }
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
  try {
    execFileSync(compiler, flags, { stdio: "pipe" });
  } catch (err: any) {
    throw new Error(
      `NATIVE_COMPILATION_FAILED: Failed to build native addon for ${process.platform} using ${compiler}: ${err.message}. Run 'npm run build:native'.`
    );
  }
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
