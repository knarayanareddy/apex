/**
 * Helper child process for Tier-B real SIGKILL WAL recovery test.
 * Logs an OPAQUE_EXTERNAL intent in EXECUTING state to SQLite WAL, flushes stdout,
 * and sleeps until the parent test sends a real OS SIGKILL (`kill -9`).
 */
import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { StateDb } from "../../src/core/state-db.ts";
import { executeThroughWalSpine } from "../../src/core/wal-recovery.ts";

const [dbPath, spillDir, sessionId, leafId, toolCallId] = process.argv.slice(2);

const stateDb = new StateDb(dbPath, "power-loss-safe");
const spillStore = new PrivateSpillStore({ rootDir: spillDir });

executeThroughWalSpine({
  stateDb,
  spillStore,
  sessionId,
  leafId,
  toolCallId,
  toolName: "bash",
  mutabilityClass: "OPAQUE_EXTERNAL",
  args: { command: "curl -X POST https://billing.example/charge" },
  executeEffect: async () => {
    process.stdout.write("WORKER_IN_EXECUTING_STATE\n");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return { rawText: "never-reached" };
  }
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
