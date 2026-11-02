/**
 * Batch E Canary Suite: Private Control-Plane Storage Preflight & Offline Migration (ADR 0001 / R05 / R06).
 *
 * Verifies:
 *  E1: Preflight fails closed when control-plane shares filesystem without allowSameDeviceDev.
 *  E2: Preflight rejects symlinked control plane and symlinked ancestor paths.
 *  E3: Preflight succeeds with visible warning when allowSameDeviceDev is enabled.
 *  E4: Non-destructive offline migration rehearsals using SQLite backup() API.
 *  E5: Cryptographic SHA-256 verification of copied sessions, spills, and retained legacy source.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  inspectMountTopology,
  migratePrivateStateOffline,
  PrivateStateBoundaryError,
  validatePrivateStatePreflight
} from "../../src/core/private-state-boundary.ts";
import { StateDb } from "../../src/core/state-db.ts";

console.log("=== Running Batch E: Private State Preflight & Migration Tests ===");

// ============================================================================
// E1 & E2: Mount Topology Preflight & Symlink Rejection
// ============================================================================
console.log("--- E1 & E2: Mount topology preflight & symlink rejection ---");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e-ws-"));
const realWs = fs.realpathSync(ws);
const harnessDir = path.join(realWs, ".harness");
fs.mkdirSync(harnessDir, { recursive: true });

// 1. Same-device control plane must be rejected when allowSameDeviceDev: false
assert.throws(
  () => validatePrivateStatePreflight(realWs, harnessDir, { allowSameDeviceDev: false }),
  (err: unknown) => {
    assert.ok(err instanceof PrivateStateBoundaryError);
    assert.match(
      (err as Error).message,
      /PRIVATE_STATE_BOUNDARY_VIOLATION/,
      "Same-device control plane must violate private state boundary"
    );
    return true;
  },
  "Default preflight must fail closed on same-device control plane"
);

// 2. Symlinked control-plane directory must be rejected
const symlinkWs = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e-symlink-ws-"));
const outsideHarness = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e-outside-harness-"));
fs.symlinkSync(outsideHarness, path.join(symlinkWs, ".harness"));

assert.throws(
  () => validatePrivateStatePreflight(symlinkWs, path.join(symlinkWs, ".harness")),
  (err: unknown) => {
    assert.ok(err instanceof PrivateStateBoundaryError);
    assert.match((err as Error).message, /PRIVATE_STATE_BOUNDARY_ERROR/);
    assert.match((err as Error).message, /symbolic link/);
    return true;
  },
  "Symlinked control plane must be rejected"
);

// 3. Symlinked ancestor directory must be rejected
const nestedWs = fs.mkdtempSync(path.join(os.tmpdir(), "apex-e-nested-ws-"));
const realSub = path.join(nestedWs, "real-sub");
fs.mkdirSync(realSub);
const symlinkSub = path.join(nestedWs, "link-sub");
fs.symlinkSync(realSub, symlinkSub);
const linkHarness = path.join(symlinkSub, ".harness");
fs.mkdirSync(linkHarness);

assert.throws(
  () => validatePrivateStatePreflight(nestedWs, linkHarness),
  PrivateStateBoundaryError,
  "Symlinked ancestor directory must be rejected"
);

// ============================================================================
// E3: Development Override Positive Control
// ============================================================================
console.log("--- E3: Development override positive control ---");

const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: any[]) => {
  warnings.push(args.join(" "));
};

try {
  const report = validatePrivateStatePreflight(realWs, harnessDir, { allowSameDeviceDev: true });
  assert.equal(report.workspaceRoot, realWs);
  assert.equal(report.controlPlaneDir, harnessDir);
  assert.ok(
    warnings.some((w) => w.includes("[APEX_STORAGE_WARNING]")),
    "Same-device dev mode must emit visible APEX_STORAGE_WARNING"
  );
} finally {
  console.warn = originalWarn;
}

// ============================================================================
// E4 & E5: Offline Non-Destructive Migration Rehearsal (SQLite + Spills + Hashes)
// ============================================================================
console.log("--- E4 & E5: Offline non-destructive migration rehearsal ---");

const srcHarness = path.join(realWs, "src-harness");
const dstHarness = path.join(realWs, "dst-harness");
fs.mkdirSync(srcHarness, { recursive: true });

// 1. Create realistic source state: SQLite WAL DB
const stateDb = new StateDb(path.join(srcHarness, "state.db"), "crash-safe");
stateDb.db.exec(`
  CREATE TABLE test_data (id INTEGER PRIMARY KEY, note TEXT);
  INSERT INTO test_data (note) VALUES ('source-note-1'), ('source-note-2');
`);
stateDb.close();

// 2. Create session and spill files
const sessionDir = path.join(srcHarness, "sessions", "session-123");
fs.mkdirSync(sessionDir, { recursive: true });
const transcriptFile = path.join(sessionDir, "transcript.jsonl");
const transcriptBytes = JSON.stringify({ role: "user", content: "hello world" }) + "\n";
fs.writeFileSync(transcriptFile, transcriptBytes, "utf8");

const spillDir = path.join(srcHarness, "spill", "session-123");
fs.mkdirSync(spillDir, { recursive: true });
const spillFile = path.join(spillDir, "spill-tool-0.txt");
const spillBytes = "SYNTHETIC_LARGE_TOOL_OUTPUT_TO_BE_MIGRATED\n";
fs.writeFileSync(spillFile, spillBytes, "utf8");

// 3. Execute offline migration
const summary = await migratePrivateStateOffline({
  sourceDir: srcHarness,
  destinationDir: dstHarness
});

assert.equal(summary.success, true);
assert.equal(summary.sourceRetained, true, "Legacy source must be preserved untouched");
assert.equal(summary.verifiedHashes, true, "All copied file hashes must verify");
assert.ok(summary.filesCopied >= 3, `Expected at least 3 files copied, got ${summary.filesCopied}`);
assert.ok(summary.bytesCopied > 0);

// 4. Verify destination SQLite database can be opened and has committed data
const migratedDb = new DatabaseSync(path.join(dstHarness, "state.db"));
try {
  const rows = migratedDb.prepare("SELECT note FROM test_data ORDER BY id ASC").all() as Array<{ note: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, "source-note-1");
  assert.equal(rows[1].note, "source-note-2");
} finally {
  migratedDb.close();
}

// 5. Verify byte-for-byte fidelity of transcripts and spills
assert.equal(
  fs.readFileSync(path.join(dstHarness, "sessions", "session-123", "transcript.jsonl"), "utf8"),
  transcriptBytes
);
assert.equal(
  fs.readFileSync(path.join(dstHarness, "spill", "session-123", "spill-tool-0.txt"), "utf8"),
  spillBytes
);

// 6. Verify legacy source was NOT modified or deleted
assert.equal(fs.existsSync(srcHarness), true);
assert.equal(fs.readFileSync(transcriptFile, "utf8"), transcriptBytes);
assert.equal(fs.readFileSync(spillFile, "utf8"), spillBytes);

// Clean up test fixtures
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(symlinkWs, { recursive: true, force: true });
fs.rmSync(outsideHarness, { recursive: true, force: true });
fs.rmSync(nestedWs, { recursive: true, force: true });

console.log("=== ALL BATCH E TESTS PASSED CLEANLY ===");
