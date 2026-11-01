/** Regression: a post-scan alias to an already inventoried private file is denied. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorkspaceFileSafe, PathContainmentError } from "../../src/core/safe-path.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-hardlink-race-"));
const harness = path.join(fs.realpathSync(workspace), ".harness");
const privateFile = path.join(harness, "spill", "session-foreign", "private");
const alias = path.join(workspace, "workspace-alias");
fs.mkdirSync(path.dirname(privateFile), { recursive: true });
fs.writeFileSync(privateFile, "SYNTHETIC_PRIVATE_RACE_MARKER");
assert.equal(fs.statSync(workspace).dev, fs.statSync(privateFile).dev, "The negative fixture must be on one filesystem");

const originalOpenDir = fs.opendirSync;
let injected = false;
try {
  (fs as any).opendirSync = (...args: any[]) => {
    const directory = (originalOpenDir as any)(...args);
    if (args[0] !== harness) return directory;
    return new Proxy(directory, {
      get(target, property) {
        if (property === "closeSync") return () => {
          target.closeSync();
          fs.linkSync(privateFile, alias);
          injected = true;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };
  let refusal: unknown;
  try {
    readWorkspaceFileSafe({ workspaceRoot: workspace, candidatePath: alias, sessionId: "other-session" });
  } catch (error) {
    refusal = error;
  }
  if (!injected) {
    assert.match(String(refusal), /PRIVATE_STATE_(?:BOUNDARY|ISOLATION)_/,
      "Only a specific pre-dispatch private-state boundary refusal may avoid the injected race");
    assert.equal(fs.existsSync(alias), false);
  } else {
    assert.ok(refusal instanceof PathContainmentError, "A post-scan alias must not expose private data");
    assert.match(refusal.message, /hardlink alias to private control-plane file denied/);
  }
} finally {
  (fs as any).opendirSync = originalOpenDir;
}

const ownWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-own-spill-race-"));
const ownHarness = path.join(fs.realpathSync(ownWorkspace), ".harness");
const sessionId = "synthetic-owner-session";
const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
const ownFile = path.join(ownHarness, "spill", `session-${sessionHash}`, "owned");
fs.mkdirSync(path.dirname(ownFile), { recursive: true });
fs.writeFileSync(ownFile, "SYNTHETIC_OWN_SPILL");
let ownInjected = false;
try {
  (fs as any).opendirSync = (...args: any[]) => {
    const directory = (originalOpenDir as any)(...args);
    if (args[0] !== ownHarness) return directory;
    return new Proxy(directory, {
      get(target, property) {
        if (property === "closeSync") return () => {
          target.closeSync();
          fs.linkSync(ownFile, path.join(ownWorkspace, "own-alias"));
          ownInjected = true;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  };
  let refusal: unknown;
  try {
    readWorkspaceFileSafe({ workspaceRoot: ownWorkspace, candidatePath: ownFile, sessionId });
  } catch (error) {
    refusal = error;
  }
  if (!ownInjected) {
    assert.match(String(refusal), /PRIVATE_STATE_(?:BOUNDARY|ISOLATION)_/,
      "Only a specific private-state boundary refusal may prevent the direct-spill race");
  } else {
    assert.ok(refusal instanceof PathContainmentError, "An authorized spill hardlinked after scanning must fail closed");
    assert.match(refusal.message, /hardlinked private spill denied/);
  }
} finally {
  (fs as any).opendirSync = originalOpenDir;
}
console.log("Post-scan alias to an existing private file denied; other races remain unverified: PASS");
