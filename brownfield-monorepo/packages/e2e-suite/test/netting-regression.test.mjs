import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchNettingEngine,
  calculateNetBatchAdjustment
} from "../../settlement-engine/src/netting/batch-netting-engine.ts";

test("base allocation uses banker’s rounding and handles empty batches", () => {
  assert.equal(calculateNetBatchAdjustment(301, 3), 100);
  assert.equal(calculateNetBatchAdjustment(302, 3), 101);
  assert.equal(calculateNetBatchAdjustment(201, 2), 100);
  assert.equal(calculateNetBatchAdjustment(203, 2), 102);
  assert.equal(calculateNetBatchAdjustment(0, 0), 0);
});

for (const fees of [[], [101], [100, 101, 100], [101, 100, 101], [100, 101], [101, 102], [100, 100, 100], [-100, -101, -100]]) {
  test(`conserves fees and net obligation for ${JSON.stringify(fees)}`, () => {
    const tenantId = "tenant-regression";
    const legs = fees.map((feeSubcents, index) => ({
      id: `leg-${index}`,
      tenantId,
      side: index % 2 === 0 ? "sell" : "buy",
      grossSubcents: 100000,
      feeSubcents
    }));
    const totalFees = fees.reduce((sum, fee) => sum + fee, 0);
    const net = legs.reduce((sum, leg) => sum + (leg.side === "sell" ? leg.grossSubcents : -leg.grossSubcents), 0);
    const result = new BatchNettingEngine().processBatch(tenantId, legs);
    assert.equal(result.allocatedFeeRemainder, totalFees);
    assert.equal(result.netObligation, net - totalFees);
    assert.equal(result.grossVolume, legs.length * 100000);
    assert.equal(result.reconciled, true);
  });
}
