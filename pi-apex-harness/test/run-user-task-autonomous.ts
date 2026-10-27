import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRing0Harness } from "../src/core/ring0-session.ts";

const TASK_PROMPT = `Objective: Upgrade and stabilize the multi-tenant metrics ingestion pipeline in the current workspace.

Background: 
The repository contains a legacy Node.js/TypeScript ingestion service (packages/ingest), an API gateway (packages/gateway), and an integration test runner (packages/e2e). The project currently relies on an in-memory ring-buffer for rate limiting and metric aggregation, which loses data across restarts and corrupts state during sudden traffic spikes.

Requirements:

Infrastructure Provisioning:
Update docker-compose.yml to provision a local Redis service (version 7-alpine) exposed on port 6379, with persistence enabled (AOF) and health checks configured.

Distributed Storage Migration:
Refactor packages/ingest/src/aggregator.ts to replace the in-memory windowing logic with an atomic, Redis-backed sliding log using Lua scripts or Redis Transactions (MULTI/EXEC) to avoid race conditions.

Backward Compatibility & Invariant Guarantees:
The system must pass all existing integration suites in npm run test:e2e without modifying any assertions inside packages/e2e/specs/.
Under continuous load from npm run benchmark:burst, the pipeline must achieve zero unhandled promise rejections, maintain p99 processing latency under 45ms, and maintain 100% tenant isolation (no cross-tenant metric bleed under parallel execution).

Graceful Degradation & Recovery:
Implement a fallback circuit breaker in the gateway (packages/gateway/src/gateway.ts): if Redis is stopped (docker stop <redis_container>) while ingestion traffic is live, the gateway must switch to a temporary on-disk append-only write-ahead log (WAL) under .wal/ and replay pending metrics once Redis recovers.

Deliverables:
Working, linted code across all affected packages.
A verification script scripts/verify-all.sh that stands up the environment, seeds legacy data, executes the chaos test (killing and reviving Redis mid-run), asserts zero dropped metrics, and cleanly tears down containers.

Please inspect the existing files, make the required modifications, run the tests and benchmark via bash to verify them, create scripts/verify-all.sh and run it, and report when everything is 100% passing.`;

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable required");
  const workspaceRoot = "/Users/brightech/Downloads/pi-apex/metrics-pipeline";
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-pipeline-agent-"));

  console.log("================================================================================");
  console.log("PI-APEX AUTONOMOUS LONG-HORIZON TASK EXECUTION (ZERO INTERVENTION)");
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
    api: "openai-responses",
    thinkingLevelMap: { off: "low", low: "low", medium: "medium", high: "high" }
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
    console.log("1. Running npm run test:e2e...");
    try {
      const e2eOut = execFileSync("npm", ["run", "test:e2e"], { cwd: workspaceRoot, encoding: "utf8" });
      console.log("E2E Test Suite: PASSED!\n", e2eOut);
    } catch (err: any) {
      console.error("E2E Test Suite: FAILED!\n", err.stdout || err.message);
    }

    console.log("2. Running npm run benchmark:burst...");
    try {
      const burstOut = execFileSync("npm", ["run", "benchmark:burst"], { cwd: workspaceRoot, encoding: "utf8" });
      console.log("Burst Benchmark: PASSED!\n", burstOut);
    } catch (err: any) {
      console.error("Burst Benchmark: FAILED!\n", err.stdout || err.message);
    }

    if (fs.existsSync(path.join(workspaceRoot, "scripts/verify-all.sh"))) {
      console.log("3. Running scripts/verify-all.sh...");
      try {
        fs.chmodSync(path.join(workspaceRoot, "scripts/verify-all.sh"), 0o755);
        const verifyOut = execFileSync("bash", ["scripts/verify-all.sh"], { cwd: workspaceRoot, encoding: "utf8" });
        console.log("Verification Script: PASSED!\n", verifyOut);
      } catch (err: any) {
        console.error("Verification Script Output:\n", err.stdout || err.message);
      }
    }

    // Invariant check on StateDb
    const checkpoints = h.stateDb.db.prepare("SELECT count(*) as count FROM git_checkpoints").get() as { count: number };
    console.log(`\nStateDb Git Checkpoints: ${checkpoints.count}`);

  } finally {
    h.dispose();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error("Runner encountered fatal error:", err);
  process.exit(1);
});
