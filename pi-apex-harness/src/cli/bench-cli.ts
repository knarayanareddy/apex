/**
 * Ring 8 — CLI Entrypoint for Personal SWE Eval & Prompt-Cache Benchmark Suite
 * (`src/cli/bench-cli.ts` / `npm run bench`).
 *
 * Usage:
 *   npm run bench
 *   npm run bench -- --json
 *   npm run bench -- --no-ab
 *   npm run bench -- --cwd /path/to/repo --model anthropic/claude-sonnet-4-5
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  runPersonalSweBenchmarkSuite,
  type SweBenchTaskDefinition
} from "../ring8/swe-eval-bench.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SURFACES_DIR = path.join(REPO_ROOT, "surfaces");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let jsonOut = false;
  let compareAb = true;
  let persistCwd: string | undefined;
  let suitePath: string | undefined;
  let modelSpec: string | undefined;

  let customTasks: SweBenchTaskDefinition[] | undefined;
  let allowUnsandboxedDev = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") {
      jsonOut = true;
    } else if (a === "--no-ab") {
      compareAb = false;
    } else if (a === "--allow-unsandboxed-dev" || a === "--no-bwrap") {
      allowUnsandboxedDev = true;
    } else if (a === "--cwd" && args[i + 1]) {
      persistCwd = path.resolve(args[++i]!);
    } else if (a === "--suite" && args[i + 1]) {
      suitePath = path.resolve(args[++i]!);
    } else if (a === "--model" && args[i + 1]) {
      modelSpec = args[++i]!;
    }
  }
  if (suitePath) {
    customTasks = JSON.parse(fs.readFileSync(suitePath, "utf8")) as SweBenchTaskDefinition[];
  }

  let customModelRuntime: ModelRuntime | undefined;
  let customModel: ReturnType<ModelRuntime["getModel"]> | undefined;
  if (modelSpec) {
    const slashIdx = modelSpec.indexOf("/");
    if (slashIdx <= 0) {
      throw new Error(`Invalid --model '${modelSpec}'. Expected '<provider>/<modelId>'.`);
    }
    const provider = modelSpec.slice(0, slashIdx);
    const modelId = modelSpec.slice(slashIdx + 1);
    const agentDir = getAgentDir();
    customModelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false
    });
    customModel = customModelRuntime.getModel(provider, modelId);
    if (!customModel) {
      throw new Error(`Model '${modelSpec}' not found in ModelRuntime.`);
    }
  }

  const report = await runPersonalSweBenchmarkSuite({
    surfacesTemplateDir: SURFACES_DIR,
    persistWorkspaceRoot: persistCwd,
    tasks: customTasks,
    compareExperienceAb: compareAb,
    customModelRuntime,
    customModel,
    useBwrapInCi: !allowUnsandboxedDev && process.platform === "linux"
  });

  if (jsonOut) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.markdownReport}\n`);
  }

  // F1 Fix: Verification failure must be fatal (propagate nonzero exit)
  const anyTaskFailed =
    report.baseline.resolvedTasks < report.baseline.totalTasks ||
    (report.evolved !== undefined && report.evolved.resolvedTasks < report.evolved.totalTasks);

  if (anyTaskFailed) {
    const failedBase = report.baseline.totalTasks - report.baseline.resolvedTasks;
    process.stderr.write(
      `\n[pi-apex bench] BENCHMARK_VERIFICATION_FAILED: ${failedBase} task(s) failed post-run verification.\n`
    );
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`[pi-apex bench] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
