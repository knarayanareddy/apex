import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAddonBinaryCompatibility } from "../../src/core/linux-fs-bridge.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-native-format-"));
try {
  const candidate = path.join(dir, "addon.node");
  const mach = process.platform === "darwin";
  const linux = process.platform === "linux";
  const supported = (mach || linux) && (process.arch === "arm64" || process.arch === "x64");
  const header = Buffer.alloc(64);
  if (mach) {
    header.set([0xcf, 0xfa, 0xed, 0xfe]);
    header.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  } else {
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    header.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  }
  fs.writeFileSync(candidate, header.subarray(0, 4));
  assert.equal(checkAddonBinaryCompatibility(candidate).compatible, false, "Truncated magic alone must not qualify an addon");
  fs.writeFileSync(candidate, header);
  assert.equal(checkAddonBinaryCompatibility(candidate).compatible, supported, "Expected matching platform and architecture header");
  if (supported) {
    if (mach) header.writeUInt32LE(process.arch === "arm64" ? 0x01000007 : 0x0100000c, 4);
    else header.writeUInt16LE(process.arch === "arm64" ? 62 : 183, 18);
    fs.writeFileSync(candidate, header);
    assert.equal(checkAddonBinaryCompatibility(candidate).compatible, false, "Wrong architecture must be rejected");
  }
  console.log("Native addon platform and architecture header validation: PASS");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
