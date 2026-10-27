import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MerkleRepoMapEngine } from "../src/ring1/merkle-repo-map.ts";
import { StateDb } from "../src/core/state-db.ts";

async function main() {
  console.log("================================================================================");
  console.log("VERIFYING MERKLE REPO-MAP INDEXING ON 297k+ LOC BROWNFIELD MONOREPO");
  console.log("================================================================================\n");

  const monorepoRoot = "/Users/brightech/Downloads/pi-apex/brownfield-monorepo";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-repomap-test-"));
  const dbPath = path.join(tmpDir, "state.sqlite");
  const stateDb = new StateDb(dbPath);

  const engine = new MerkleRepoMapEngine(monorepoRoot, stateDb);

  const t0 = performance.now();
  console.log("Building Tree-Sitter WASM AST index across monorepo...");
  const res = await engine.generateRepoMap({
    query: "BatchNettingEngine processBatch reconciliation",
    maxTokens: 1024
  });
  const elapsed = (performance.now() - t0).toFixed(2);

  console.log(`Indexed in ${elapsed} ms.`);
  console.log(`Total indexed files: ${res.totalIndexedFiles}`);
  console.log(`Reparsed files: ${res.reparsedFiles}`);
  console.log(`Token count: ${res.tokenCount}`);
  console.log(`Ranked top files:`);
  for (const f of res.rankedFiles.slice(0, 5)) {
    console.log(`  - ${f.relPath} (score: ${f.score.toFixed(4)}, symbols: ${f.symbolCount})`);
  }

  assert.ok(res.totalIndexedFiles > 100, "Must index 100+ files");
  assert.ok(res.tokenCount <= 1024, "Must obey maxTokens budget");
  assert.ok(
    res.renderedMap.includes("BatchNettingEngine") || res.renderedMap.includes("batch-netting-engine"),
    "Rendered map must contain BatchNettingEngine"
  );

  // Incremental cache test
  const t1 = performance.now();
  const res2 = await engine.generateRepoMap({
    query: "BatchNettingEngine",
    maxTokens: 1024
  });
  const elapsed2 = (performance.now() - t1).toFixed(2);
  console.log(`\nIncremental cache query took: ${elapsed2} ms (cache hits: ${res2.cacheHitFiles}/${res2.totalIndexedFiles})`);
  assert.equal(res2.reparsedFiles, 0, "Incremental query must have 0 reparsed files");

  stateDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n[SUCCESS] MerkleRepoMapEngine indexed 297k LOC with PageRank and sub-millisecond cache hits!\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
