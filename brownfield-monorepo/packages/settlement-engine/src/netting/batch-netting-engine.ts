import { roundHalfEven } from "../../../common-types/src/money.ts";

export interface ClearingLeg {
  id: string;
  tenantId: string;
  side: "buy" | "sell";
  grossSubcents: number;
  feeSubcents: number;
}

export interface NettingResult {
  tenantId: string;
  grossVolume: number;
  netObligation: number;
  allocatedFeeRemainder: number;
  reconciled: boolean;
}

/**
 * Calculates remainder fee allocation across netting legs.
 * FINANCIAL INVARIANT:
 * Use roundHalfEven (Banker's rounding) for the base per-leg allocation.
 * The batch must also allocate the residual to preserve the exact total.
 */
export function calculateNetBatchAdjustment(grossRemainder: number, legCount: number): number {
  if (legCount <= 0) return 0;
  return roundHalfEven(grossRemainder / legCount);
}

export class BatchNettingEngine {
  processBatch(tenantId: string, legs: ClearingLeg[]): NettingResult {
    let grossVolume = 0;
    let totalFees = 0;
    let net = 0;

    for (const leg of legs) {
      grossVolume += leg.grossSubcents;
      totalFees += leg.feeSubcents;
      if (leg.side === "buy") {
        net -= leg.grossSubcents;
      } else {
        net += leg.grossSubcents;
      }
    }

    // Remainder calculation across the batch
    const adjustment = calculateNetBatchAdjustment(totalFees, legs.length);
    const baseAllocatedFee = adjustment * legs.length;
    // Apply the signed residual to the batch allocation: rounding can under- or over-allocate.
    const residualFee = totalFees - baseAllocatedFee;
    const finalAllocatedFee = baseAllocatedFee + residualFee;
    const finalObligation = net - finalAllocatedFee;

    return {
      tenantId,
      grossVolume,
      netObligation: finalObligation,
      allocatedFeeRemainder: finalAllocatedFee,
      reconciled: finalAllocatedFee === totalFees
    };
  }
}
