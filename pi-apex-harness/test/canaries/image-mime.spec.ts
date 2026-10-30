import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { detectSupportedImageMimeType } from "../../src/core/image-mime.ts";
import { PathContainmentError, readWorkspaceFileSafe } from "../../src/core/safe-path.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-image-mime-"));
try {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const animationChunk = Buffer.concat([Buffer.alloc(4), Buffer.from("acTL"), Buffer.alloc(4)]);
  const samples: Array<[string, Buffer, string | null]> = [
    ["png", png, "image/png"],
    ["apng", Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)]), null],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["jpeg-ls", Buffer.from([0xff, 0xd8, 0xff, 0xf7]), null],
    ["gif", Buffer.from("GIF89a"), "image/gif"],
    ["high-bit-gif-lookalike", Buffer.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]), null],
    ["webp", Buffer.from("RIFF0000WEBP"), "image/webp"],
    ["text", Buffer.from("not an image"), null]
  ];
  for (const [name, bytes, expected] of samples) {
    const file = path.join(ws, name);
    fs.writeFileSync(file, bytes);
    assert.equal(await detectSupportedImageMimeTypeFromFile(file), expected, `Upstream control for ${name}`);
    assert.equal(detectSupportedImageMimeType(bytes), expected, `Confined buffer detection for ${name}`);
  }
  fs.writeFileSync(path.join(ws, "large.txt"), "abcdefghijklmnopqrstuvwxyz");
  assert.equal(readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: "large.txt", maxPrefixBytes: 4 }).toString(), "abcd");
  assert.throws(() => readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: "large.txt", maxPrefixBytes: 4, maxBytes: 8 }), RangeError);
  fs.symlinkSync("/etc/passwd", path.join(ws, "outside-link"));
  assert.throws(() => readWorkspaceFileSafe({ workspaceRoot: ws, candidatePath: "outside-link", maxPrefixBytes: 4 }), PathContainmentError);
  console.log("Confined image detection matches upstream controls: PASS");
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
