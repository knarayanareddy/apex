/**
 * Canary: Post-scan alias to a newly created private control-plane file is denied.
 *
 * Simulates a concurrent race where a brand new private file is created inside `.harness`
 * AFTER `.harness` directory scanning completes, and is hardlinked into the workspace.
 *
 * Before our fix, `countInodeDentriesInWorkspace` saw both dentries (one in workspace, one in .harness)
 * and allowed reading the private file. With `isInodeInDirectory`, it is rejected fail-closed.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorkspaceFileSafe, PathContainmentError, isInodeInDirectory } from "../../src/core/safe-path.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-post-scan-race-"));
const realWs = fs.realpathSync(ws);
const harnessDir = path.join(realWs, ".harness");
const sessionId = "session-test-post-scan";
const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
const sessionSpillDir = path.join(harnessDir, "spill", `session-${sessionHash}`);

fs.mkdirSync(sessionSpillDir, { recursive: true });

// 1. Initial workspace state: legitimate public file
const publicFile = path.join(realWs, "public.txt");
fs.writeFileSync(publicFile, "LEGITIMATE_PUBLIC_CONTENT");

const legitimateRead = readWorkspaceFileSafe({
  workspaceRoot: realWs,
  candidatePath: "public.txt",
  sessionId
});
assert.equal(legitimateRead.toString("utf8"), "LEGITIMATE_PUBLIC_CONTENT");

// 2. Race injection: create a new private file and alias AFTER .harness scan completes
const postScanPrivate = path.join(sessionSpillDir, "newly-created-spill.dat");
const postScanAlias = path.join(realWs, "post-scan-alias.txt");

const originalOpenDir = fs.opendirSync;
let injected = false;
try {
  (fs as any).opendirSync = (...args: any[]) => {
    const directory = (originalOpenDir as any)(...args);
    // When opendirSync finishes closing the .harness directory, inject the race:
    if (args[0] === harnessDir) {
      return new Proxy(directory, {
        get(target, property) {
          if (property === "closeSync") {
            return () => {
              target.closeSync();
              // Create the brand new private file AFTER scan of .harness completed!
              fs.writeFileSync(postScanPrivate, "SUPER_SECRET_POST_SCAN_BYTES");
              fs.linkSync(postScanPrivate, postScanAlias);
              injected = true;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
    return directory;
  };

  let refusal: unknown;
  try {
    readWorkspaceFileSafe({
      workspaceRoot: realWs,
      candidatePath: "post-scan-alias.txt",
      sessionId: "other-session"
    });
  } catch (error) {
    refusal = error;
  }

  assert.equal(injected, true, "Race injection must have triggered");
  assert.ok(
    refusal instanceof PathContainmentError,
    `Post-scan alias to new private file must fail closed with PathContainmentError, got: ${String(refusal)}`
  );
  assert.match(
    (refusal as Error).message,
    /hardlink alias to private control-plane file denied/,
    "Error message must clearly identify hardlink alias to private control plane"
  );
} finally {
  (fs as any).opendirSync = originalOpenDir;
}

// 3. Positive control: direct authorized spill read for the matching session still works
const singleSpill = path.join(sessionSpillDir, "single-link.dat");
fs.writeFileSync(singleSpill, "SINGLE_LINK_SPILL_DATA");
const singleSpillRel = path.join(".harness", "spill", `session-${sessionHash}`, "single-link.dat");
const singleRead = readWorkspaceFileSafe({
  workspaceRoot: realWs,
  candidatePath: singleSpillRel,
  sessionId
});
assert.equal(singleRead.toString("utf8"), "SINGLE_LINK_SPILL_DATA");

// 4. Test isInodeInDirectory helper directly
const st = fs.statSync(singleSpill);
assert.equal(isInodeInDirectory(harnessDir, st.dev, st.ino), true);
assert.equal(isInodeInDirectory(harnessDir, st.dev, 999999999), false);

// Clean up
fs.rmSync(ws, { recursive: true, force: true });
console.log("Post-scan private file alias denial: PASS");
