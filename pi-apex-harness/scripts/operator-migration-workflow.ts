/**
 * Operator Workflow: Safe Private-State Migration & Rehearsal CLI (ADR 0001 / R06).
 *
 * Usage:
 *   npx tsx scripts/operator-migration-workflow.ts --rehearse --workspace <DIR> --destination <DIR>
 *   npx tsx scripts/operator-migration-workflow.ts --workspace <DIR> --destination <DIR> [--authorize-production-cutover]
 *
 * Safety Invariants:
 *  - Refuses to migrate without explicit source workspace and destination paths.
 *  - Enforces distinct filesystem check (st_dev differs from workspace).
 *  - Verifies SQLite backup() consistency and PRAGMA integrity_check.
 *  - Cryptographically verifies SHA-256 byte-fidelity for sessions and spills.
 *  - Preserves source state intact under all circumstances (never unlinks source).
 *  - Refuses destructive production cutover unless --authorize-production-cutover is explicitly passed.
 */

import fs from "node:fs";
import path from "node:path";
import { inspectMountTopology, migratePrivateStateOffline } from "../src/core/private-state-boundary.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let workspaceRoot = "";
  let destinationDir = "";
  let isRehearsal = false;
  let isAuthorizedCutover = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" && args[i + 1]) {
      workspaceRoot = path.resolve(args[++i]!);
    } else if (arg === "--destination" && args[i + 1]) {
      destinationDir = path.resolve(args[++i]!);
    } else if (arg === "--rehearse" || arg === "--dry-run") {
      isRehearsal = true;
    } else if (arg === "--authorize-production-cutover") {
      isAuthorizedCutover = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/operator-migration-workflow.ts [options]");
      console.log("Options:");
      console.log("  --workspace <DIR>                 Path to workspace root");
      console.log("  --destination <DIR>               Path to dedicated persistent filesystem mount point");
      console.log("  --rehearse, --dry-run             Simulate migration without modifying destination");
      console.log("  --authorize-production-cutover    Explicit operator authorization for non-destructive copy");
      process.exit(0);
    }
  }

  if (!workspaceRoot || !destinationDir) {
    console.error("Error: Both --workspace <DIR> and --destination <DIR> are required.");
    console.error("Run with --help for detailed options.");
    process.exit(1);
  }

  const sourceControlPlane = path.join(workspaceRoot, ".harness");
  if (!fs.existsSync(sourceControlPlane)) {
    console.error(`Error: Source control-plane '${sourceControlPlane}' does not exist.`);
    process.exit(1);
  }

  console.log("=== Apex Private-State Migration & Rehearsal Workflow ===");
  console.log(`  Source workspace:    ${workspaceRoot}`);
  console.log(`  Source control-plane: ${sourceControlPlane}`);
  console.log(`  Target destination:  ${destinationDir}`);
  console.log(`  Execution mode:      ${isRehearsal ? "REHEARSAL (dry-run)" : "LIVE OFFLINE MIGRATION"}`);

  // 1. Inspect source & target mount topologies
  const sourceTopology = inspectMountTopology(workspaceRoot, sourceControlPlane);
  console.log(`\n[Topology Inspection]`);
  console.log(`  Workspace st_dev:    ${sourceTopology.workspaceDev}`);
  console.log(`  Source control st_dev: ${sourceTopology.controlPlaneDev}`);

  if (fs.existsSync(destinationDir)) {
    const dstDev = fs.statSync(destinationDir).dev;
    console.log(`  Target st_dev:       ${dstDev}`);
    if (dstDev === sourceTopology.workspaceDev) {
      console.error("  [SAFETY REFUSAL] Target destination is on the SAME filesystem device as workspace (st_dev=" + dstDev + ").");
      console.error("  ADR 0001 requires confirmed filesystem separation (distinct st_dev) before migration can proceed.");
      process.exit(1);
    } else {
      console.log("  [PASS] Target destination resides on a distinct filesystem device.");
    }
  }

  if (!isRehearsal && !isAuthorizedCutover) {
    console.error("\n[SAFETY REFUSAL] Production cutover / live copying requires explicit authorization.");
    console.error("To rehearse safely without modifying destination: pass `--rehearse`.");
    console.error("To authorize live migration: pass `--authorize-production-cutover`.");
    process.exit(2);
  }

  console.log(`\n[Running ${isRehearsal ? "Rehearsal" : "Migration"}...]`);
  const summary = await migratePrivateStateOffline({
    sourceDir: sourceControlPlane,
    destinationDir,
    workspaceRoot,
    dryRun: isRehearsal,
    rollbackOnError: true
  });

  console.log("\n=== Migration Summary ===");
  console.log(`  Status:              ${summary.success ? "SUCCESS" : "FAILED"}`);
  console.log(`  Files copied:        ${summary.filesCopied}`);
  console.log(`  Bytes copied:        ${summary.bytesCopied}`);
  console.log(`  SHA-256 hashes:      ${summary.verifiedHashes ? "VERIFIED" : "UNVERIFIED"}`);
  console.log(`  SQLite integrity:    ${summary.integrityVerified ? "VERIFIED (PRAGMA integrity_check = ok)" : "N/A"}`);
  console.log(`  Source preserved:    ${summary.sourceRetained ? "YES (intact and retained)" : "NO"}`);
  console.log("=========================");
}

void main().catch((err) => {
  console.error("\n[MIGRATION ERROR]", err);
  process.exit(1);
});
