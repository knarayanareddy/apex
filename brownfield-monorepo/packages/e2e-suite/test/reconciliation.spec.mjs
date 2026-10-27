import assert from "node:assert/strict";
import { BatchNettingEngine } from "../../settlement-engine/src/netting/batch-netting-engine.ts";

console.log("================================================================================");
console.log("RUNNING RECONCILIATION SUITE: Multi-Tenant Batch Netting & Invariant Checks");
console.log("================================================================================\n");

const engine = new BatchNettingEngine();
const tenants = ["tenant-enterprise-alpha", "tenant-prime-beta", "tenant-corp-gamma"];

let totalBatches = 0;
let driftFailures = 0;

for (const tenantId of tenants) {
  for (let batchId = 1; batchId <= 30; batchId++) {
    totalBatches++;
    const legCount = 3; // Odd leg count with non-uniform fees exposes remainder loss
    const legs = [];
    const grossPerLeg = 100000;

    for (let i = 0; i < legCount; i++) {
      legs.push({
        id: `leg_${batchId}_${i}`,
        tenantId,
        side: i % 2 === 0 ? "sell" : "buy",
        grossSubcents: grossPerLeg,
        feeSubcents: 100 + (i % 2) // [100, 101, 100] -> total 301
      });
    }

    const expectedTotalFees = legs.reduce((acc, l) => acc + l.feeSubcents, 0); // 301
    const result = engine.processBatch(tenantId, legs);

    if (result.allocatedFeeRemainder !== expectedTotalFees) {
      driftFailures++;
      const drift = result.allocatedFeeRemainder - expectedTotalFees;
      console.error(
        `[FAIL] Settlement reconciliation imbalance for tenant '${tenantId}' (Batch #${batchId}):`
      );
      console.error(
        `       Expected total fee remainder ${expectedTotalFees} subcents, got ${result.allocatedFeeRemainder} subcents (drift: ${drift} subcents).`
      );
      console.error(`       Invariant Violated: Zero Net Clearing Loss!\n`);
      assert.equal(
        result.allocatedFeeRemainder,
        expectedTotalFees,
        `Settlement reconciliation imbalance for tenant '${tenantId}': Expected total fee ${expectedTotalFees}, got ${result.allocatedFeeRemainder} (drift: ${drift} subcents)`
      );
    }
  }
}

console.log(`Successfully cleared ${totalBatches} netting batches across ${tenants.length} tenants with 0 drift.`);
console.log("ALL INVARIANTS SATISFIED: ZERO RECONCILIATION DRIFT CONFIRMED!\n");
