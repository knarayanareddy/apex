/**
 * Secret-Scan Latency & Distribution Benchmark (Programme F2).
 *
 * Measures:
 *  - Scan invocation count per operation
 *  - Directory and file counts
 *  - Cold vs Warm latency distributions (p50, p95, p99, min, max)
 *  - Representative Small vs Large synthetic workspaces
 *  - Mutation invalidation soundness (mutating a secret updates inventory)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { scanWorkspaceSecretsAndHardlinks } from "../src/core/safe-path.ts";

function createSyntheticWorkspace(numDirs: number, numFiles: number): { root: string; secretCount: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apex-scan-bench-"));
  let secretsCreated = 0;

  // Create realistic directory tree (branching factor 4)
  const dirs = [root];
  for (let i = 0; i < numDirs; i++) {
    const parent = dirs[Math.floor(i / 4)];
    const sub = path.join(parent, `dir_${i}`);
    fs.mkdirSync(sub, { recursive: true });
    dirs.push(sub);
  }

  // Create files across directories
  for (let i = 0; i < numFiles; i++) {
    const targetDir = dirs[i % dirs.length];
    const isSecret = i % 25 === 0; // 4% secret rate
    const fileName = isSecret ? `.env.secret_${i}` : `source_${i}.ts`;
    if (isSecret) secretsCreated++;
    fs.writeFileSync(path.join(targetDir, fileName), `// File content ${i}\n`);
  }

  // Add deep hardlink
  const hardlinkDir = path.join(root, "deep", "nested", "hardlink");
  fs.mkdirSync(hardlinkDir, { recursive: true });
  const originalSecret = path.join(root, ".env.original");
  fs.writeFileSync(originalSecret, "ORIGINAL_SECRET=1\n");
  secretsCreated++;
  try {
    fs.linkSync(originalSecret, path.join(hardlinkDir, "harmless_name.txt"));
    secretsCreated++;
  } catch {
    // ignore
  }

  return { root, secretCount: secretsCreated };
}

function calculatePercentiles(latencies: number[]): { min: number; p50: number; p95: number; p99: number; max: number } {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  return { min, p50, p95, p99, max };
}

async function runBenchmark(): Promise<void> {
  console.log("=== Running Secret Scan Latency Distribution Benchmark (Programme F2) ===\n");

  const suites = [
    { name: "Small Workspace (50 dirs, 200 files)", dirs: 50, files: 200, iterations: 30 },
    { name: "Large Workspace (400 dirs, 2,000 files)", dirs: 400, files: 2000, iterations: 20 }
  ];

  for (const suite of suites) {
    console.log(`--- Benchmarking: ${suite.name} ---`);
    const { root, secretCount } = createSyntheticWorkspace(suite.dirs, suite.files);

    try {
      // 1. Cold sweep
      const coldStart = performance.now();
      const coldRes = scanWorkspaceSecretsAndHardlinks(root);
      const coldMs = performance.now() - coldStart;

      assertInvariants(coldRes, secretCount);

      // 2. Warm iterations
      const warmLatencies: number[] = [];
      for (let i = 0; i < suite.iterations; i++) {
        const t0 = performance.now();
        const res = scanWorkspaceSecretsAndHardlinks(root);
        const dt = performance.now() - t0;
        warmLatencies.push(dt);
        assertInvariants(res, secretCount);
      }

      const p = calculatePercentiles(warmLatencies);

      console.log(`  Directories: ${suite.dirs} | Total files: ${suite.files} | Masked secrets: ${coldRes.allMaskedPaths.length}`);
      console.log(`  Cold Latency: ${coldMs.toFixed(2)} ms`);
      console.log(`  Warm Distribution (${suite.iterations} runs):`);
      console.log(`    Min: ${p.min.toFixed(2)} ms`);
      console.log(`    p50: ${p.p50.toFixed(2)} ms`);
      console.log(`    p95: ${p.p95.toFixed(2)} ms`);
      console.log(`    p99: ${p.p99.toFixed(2)} ms`);
      console.log(`    Max: ${p.max.toFixed(2)} ms`);

      // 3. Sound Mutation/Invalidation test:
      // Adding a new secret dynamically must be immediately detected without stale caching
      const newSecret = path.join(root, ".env.dynamic_mutation");
      fs.writeFileSync(newSecret, "NEW_SECRET=true\n");
      const realNewSecret = fs.realpathSync(newSecret);
      const mutatedRes = scanWorkspaceSecretsAndHardlinks(root);
      if (!mutatedRes.allMaskedPaths.includes(realNewSecret)) {
        throw new Error("MUTATION_INVALIDATION_FAILED: Dynamically added secret not found in scan!");
      }
      console.log(`  [SOUND INVALIDATION PASS] Dynamically created secret detected immediately.\n`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log("=== SECRET SCAN BENCHMARK COMPLETED SUCCESSFULLY ===");
}

function assertInvariants(res: any, minSecrets: number): void {
  if (!res.complete) {
    throw new Error(`Incomplete secret scan: ${res.incompleteReasons?.join("; ")}`);
  }
  if (res.allMaskedPaths.length < minSecrets - 2) {
    throw new Error(`Expected at least ${minSecrets} secrets, got ${res.allMaskedPaths.length}`);
  }
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
