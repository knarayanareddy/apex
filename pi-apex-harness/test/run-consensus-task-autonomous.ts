import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRing0Harness } from "../src/core/ring0-session.ts";

const TASK_PROMPT = `# MISSION BRIEF: Distributed Consensus Engine Hardening & Jepsen Chaos Validation

Target: packages/consensus (Node.js/TypeScript), docker-compose.cluster.yml, and scripts/jepsen-verify.sh.

You are tasked with replacing a buggy, mock multi-master consensus engine with a fully conforming, 3-node Raft consensus cluster backed by persistent on-disk state. You must achieve zero-loss state replication across simulated asymmetric network partitions, disk fsync stalls, and ungraceful SIGKILL failovers.

### Invariants & Non-Negotiable Requirements:

1. Cluster Orchestration & Process Topology:
   - Configure docker-compose.cluster.yml to run a 3-node cluster (node-1, node-2, node-3) communicating over TCP/HTTP RPC on internal subnets with no shared memory.
   - Nodes must maintain an append-only write-ahead log under /var/raft/log.bin (or config dataDir) and persistent metadata (currentTerm, votedFor) in /var/raft/meta.json (or \${dataDir}/meta.json).

2. Raft Protocol Conformance:
   - Leader Election: Randomized election timeouts (150ms–300ms) with monotonic term advancement.
   - Log Replication: Heartbeats every 50ms. Strict majority quorum (2 of 3 nodes) required before committing any client command.
   - Safety Invariant: At most one leader per term. A leader must NEVER overwrite or truncate its own committed log entries.

3. Jepsen-Style Chaos Validation (scripts/jepsen-verify.sh):
   Your automated validation script must orchestrate the cluster and survive the following sequence:
   - Phase A (Linear Traffic): Ingest 1,000 sequential SET key_{i} val_{i} operations against the active leader with linearizable reads.
   - Phase B (Asymmetric Partition / Split-Brain Test):
     * Cut network connectivity between node-1 (current leader) and the rest of the cluster using iptables or Docker network disconnect (or local socket proxy/fault injection if native).
     * Continuously pipe 500 concurrent writes to node-1 (stale leader) and 500 concurrent writes to node-2/node-3 (majority partition).
     * Invariant: Writes to node-1 must fail/timeout and NEVER reach state machine commit; node-2/node-3 must elect a new leader and successfully commit writes.
   - Phase C (Heal & Re-convergence):
     * Reconnect node-1.
     * Inject an ungraceful crash (kill -9) into the newly elected leader.
     * Invariant: The cluster must elect a survivor, truncate uncommitted speculative entries from node-1, replay the canonical history, and achieve 100% data consistency across all alive nodes.

4. Deliverables & Strict Constraints:
   - Do NOT edit or weaken any test assertions in packages/consensus/test/linearizability.spec.ts.
   - The verify script must run end-to-end: npm run build && bash scripts/jepsen-verify.sh.
   - Zero orphaned child processes, zero lingering Docker networks, and zero leaked file descriptors upon test exit.

Please inspect the existing files in packages/consensus, implement the conforming Raft cluster, verify npm test, create scripts/jepsen-verify.sh orchestrating the Jepsen chaos phases (supporting both Docker and native process-level fault injection for local environments), run it to ensure everything passes, and summarize your final implementation.`;

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable required");
  const workspaceRoot = "/Users/brightech/Downloads/pi-apex/consensus-cluster";
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-consensus-agent-"));

  console.log("================================================================================");
  console.log("PI-APEX AUTONOMOUS LONG-HORIZON TASK: DISTRIBUTED RAFT & JEPSEN CHAOS");
  console.log("Model: openai/gpt-6.1-sol");
  console.log("Target Workspace:", workspaceRoot);
  console.log("Agent State Dir:", agentDir);
  console.log("================================================================================\n");

  const surfacesDir = path.resolve("./surfaces-immutable");
  const guardrailsPath = path.resolve("./surfaces-immutable/GUARDRAILS.yaml");

  const mr = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false });
  await mr.setRuntimeApiKey("openai", apiKey);

  const baseModel = mr.getModel("openai", "gpt-6.1-sol");
  if (!baseModel) throw new Error("gpt-6.1-sol not found in ModelRuntime");
  const model = {
    ...baseModel,
    api: "openai-responses" as const,
    thinkingLevelMap: {
      off: "low" as const,
      low: "low" as const,
      medium: "medium" as const,
      high: "high" as const
    }
  };

  const h = await createRing0Harness({
    workspaceRoot,
    agentDir,
    surfacesDir,
    guardrailsPath,
    modelRuntime: mr,
    model
  });

  const toolStats: Record<string, number> = {};
  let turnCount = 0;

  h.session.subscribe((e: any) => {
    if (e.type === "turn_start") {
      turnCount++;
      console.log(`\n>>> [Harness Agent Loop] Turn ${turnCount} Started <<<`);
    } else if (e.type === "tool_call" || e.type === "tool_call_start") {
      const name = e.toolName || e.name;
      toolStats[name] = (toolStats[name] || 0) + 1;
      const argsPreview = JSON.stringify(e.args || e.parameters || {}).slice(0, 100);
      console.log(`[Turn ${turnCount}] Tool Call: ${name} -> ${argsPreview}...`);
    } else if (e.type === "tool_result") {
      const name = e.toolName || e.name;
      console.log(`[Turn ${turnCount}] Tool Result: ${name} done.`);
    }
  });

  const startTime = Date.now();
  console.log("Starting completely autonomous execution...\n");

  try {
    await h.session.prompt(TASK_PROMPT);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n================================================================================");
    console.log(`AUTONOMOUS TASK SETTLED IN ${duration}s`);
    console.log(`Total Turns Executed: ${turnCount}`);
    console.log("Tool Invocations:", JSON.stringify(toolStats, null, 2));
    console.log("================================================================================\n");

    const lastMsg = h.session.messages[h.session.messages.length - 1] as any;
    if (lastMsg && Array.isArray(lastMsg.content)) {
      const text = lastMsg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      console.log("Autonomous Agent Final Response:\n", text);
    }

    console.log("\n--- Independent Post-Run Verification ---");
    console.log("1. Running npm run build && npm test...");
    try {
      const testOut = execFileSync("npm", ["test"], { cwd: workspaceRoot, encoding: "utf8" });
      console.log("Linearizability Test Suite: PASSED!\n", testOut);
    } catch (err: any) {
      console.error("Linearizability Test Suite: FAILED!\n", err.stdout || err.message);
    }

    console.log("2. Running scripts/jepsen-verify.sh...");
    try {
      const jepsenOut = execFileSync("bash", ["scripts/jepsen-verify.sh"], { cwd: workspaceRoot, encoding: "utf8" });
      console.log("Jepsen Chaos Verification: PASSED!\n", jepsenOut);
    } catch (err: any) {
      console.error("Jepsen Chaos Verification: FAILED!\n", err.stdout || err.message);
    }

    const checkpoints = h.stateDb.db.prepare("SELECT count(*) as count FROM git_checkpoints").get() as { count: number };
    console.log(`\nStateDb Git Checkpoints: ${checkpoints.count}`);
  } catch (err: any) {
    console.error("Autonomous execution error:", err);
  } finally {
    h.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
