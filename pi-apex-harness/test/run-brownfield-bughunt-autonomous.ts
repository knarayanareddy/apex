import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRing1Harness } from "../src/ring1/ring1-extension.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, "..");

const TASK_PROMPT = `Objective: Resolve the financial reconciliation test failure in this 297k+ LOC brownfield monorepo.

Problem Context:
Executing \`npm test\` fails in \`packages/e2e-suite/test/reconciliation.spec.mjs\` with:
"AssertionError [ERR_ASSERTION]: Settlement reconciliation imbalance for tenant 'tenant-enterprise-alpha': Expected total fee 301, got 300 (drift: -1 subcents)
Invariant Violated: Zero Net Clearing Loss!"

Requirements:
1. Discover and navigate the relevant components without blind recursive grep across the 300k LOC.
   You have access to \`codemode\` for calling deferred intelligence tools like \`const map = await tools.repo_map({ query: "BatchNettingEngine processBatch reconciliation" })\` and \`tools.lsp_query(...)\`, as well as standard tools \`read\`, \`edit\`, and \`bash\`.
2. Inspect the failing test and trace the call chain into the settlement netting engine.
3. Pinpoint the rounding or remainder allocation defect that causes odd-leg clearing batches to drop 1 subcent.
4. Use \`edit\` to fix the bug in the appropriate source file so that all remainder fees are allocated and zero clearing loss is maintained.
5. Execute \`npm test\` via bash to confirm that all 90 clearing batches across all 3 tenants pass with zero drift.
6. Provide a concise summary of the root cause, the fix applied, and the successful test output.`;

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable required");
  const workspaceRoot = "/Users/brightech/Downloads/pi-apex/brownfield-monorepo";
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-brownfield-agent-"));

  console.log("================================================================================");
  console.log("PI-APEX RING 1 AUTONOMOUS BROWNFIELD MONOREPO BUG-HUNT (297k+ LOC)");
  console.log("Model: openai/gpt-6.1-sol");
  console.log("Target Workspace:", workspaceRoot);
  console.log("Agent State Dir:", agentDir);
  console.log("================================================================================\n");

  const surfacesDir = path.join(HARNESS_ROOT, "surfaces");
  const guardrailsPath = path.join(HARNESS_ROOT, "surfaces-immutable", "GUARDRAILS.yaml");
  const mockLspServer = path.join(HARNESS_ROOT, "test", "fixtures", "stdio-lsp-server.ts");

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

  const h = await createRing1Harness({
    workspaceRoot,
    agentDir,
    surfacesDir,
    guardrailsPath,
    modelRuntime: mr,
    model,
    allowUnsandboxedDev: true,
    ring1: {
      lspServers: [
        {
          languageId: "typescript",
          extensions: [".ts", ".tsx"],
          command: process.execPath,
          args: ["--experimental-strip-types", mockLspServer]
        }
      ],
      lspDiagnosticsWaitMs: 300
    }
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
      const argsPreview = JSON.stringify(e.args || e.parameters || {}).slice(0, 120);
      console.log(`[Turn ${turnCount}] Tool Call: ${name} -> ${argsPreview}...`);
    } else if (e.type === "tool_result") {
      const name = e.toolName || e.name;
      const resText = Array.isArray(e.content)
        ? e.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n")
        : String(e.content || "");
      const resPreview = resText.replace(/\s+/g, " ").slice(0, 150);
      console.log(`[Turn ${turnCount}] Tool Result: ${name} -> ${resPreview}...`);
    }
  });

  const startTime = Date.now();
  console.log("Starting completely autonomous execution...\n");

  try {
    await h.session.prompt(TASK_PROMPT);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n================================================================================");
    console.log(`AUTONOMOUS BROWNFIELD BUG-HUNT SETTLED IN ${duration}s`);
    console.log(`Total Turns Executed: ${turnCount}`);
    console.log("Tool Invocations:", JSON.stringify(toolStats, null, 2));
    console.log("================================================================================\n");

    const lastMsg = h.session.messages[h.session.messages.length - 1] as any;
    console.log("Agent Final Response:\n");
    console.log(
      Array.isArray(lastMsg?.content)
        ? lastMsg.content.map((c: any) => c.text).join("\n")
        : lastMsg?.content || "(no text)"
    );

    // Verify git diff and test output in workspace
    const gitDiff = execSync("git diff", { cwd: workspaceRoot, encoding: "utf8" });
    console.log("\nWorkspace Git Diff:\n", gitDiff || "(no diff)");

    const testOut = execSync("npm test", { cwd: workspaceRoot, encoding: "utf8" });
    console.log("\nFinal Test Verification Output:\n", testOut);

    await h.disposeAsync();
  } catch (err) {
    console.error("FATAL: Autonomous execution failed:", err);
    await h.disposeAsync();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
