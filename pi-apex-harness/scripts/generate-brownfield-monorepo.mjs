import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const MONOREPO_ROOT = "/Users/brightech/Downloads/pi-apex/brownfield-monorepo";

console.log("Generating 200,000+ LOC Brownfield Monorepo at:", MONOREPO_ROOT);

fs.rmSync(MONOREPO_ROOT, { recursive: true, force: true });
fs.mkdirSync(MONOREPO_ROOT, { recursive: true });

// 1. Root package.json and tsconfig.json
fs.writeFileSync(
  path.join(MONOREPO_ROOT, "package.json"),
  JSON.stringify(
    {
      name: "brownfield-enterprise-monorepo",
      version: "3.4.0",
      private: true,
      type: "module",
      workspaces: ["packages/*"],
      scripts: {
        test: "node packages/e2e-suite/test/reconciliation.spec.mjs"
      }
    },
    null,
    2
  )
);

fs.writeFileSync(
  path.join(MONOREPO_ROOT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true
      }
    },
    null,
    2
  )
);

// Helper for writing directories
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

// 2. packages/common-types
const commonTypesDir = path.join(MONOREPO_ROOT, "packages", "common-types", "src");
ensureDir(commonTypesDir);

fs.writeFileSync(
  path.join(MONOREPO_ROOT, "packages", "common-types", "package.json"),
  JSON.stringify({ name: "@brownfield/common-types", version: "1.0.0", type: "module" }, null, 2)
);

fs.writeFileSync(
  path.join(commonTypesDir, "money.ts"),
  `export interface MoneyAmount {
  subcents: bigint;
  currency: "USD" | "EUR" | "GBP" | "JPY";
}

export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return Math.ceil(value);
  return floor % 2 === 0 ? floor : Math.ceil(value);
}

export class Money {
  subcents: bigint;
  currency: "USD" | "EUR" | "GBP" | "JPY";

  constructor(subcents: bigint, currency: "USD" | "EUR" | "GBP" | "JPY" = "USD") {
    this.subcents = subcents;
    this.currency = currency;
  }

  static fromSubcents(subcents: number | bigint, currency: "USD" | "EUR" | "GBP" | "JPY" = "USD"): Money {
    return new Money(BigInt(Math.round(Number(subcents))), currency);
  }

  plus(other: Money): Money {
    if (this.currency !== other.currency) throw new Error("Currency mismatch");
    return new Money(this.subcents + other.subcents, this.currency);
  }

  minus(other: Money): Money {
    if (this.currency !== other.currency) throw new Error("Currency mismatch");
    return new Money(this.subcents - other.subcents, this.currency);
  }

  times(multiplier: number): Money {
    return new Money(BigInt(roundHalfEven(Number(this.subcents) * multiplier)), this.currency);
  }

  isZero(): boolean {
    return this.subcents === 0n;
  }
}
`
);

fs.writeFileSync(
  path.join(commonTypesDir, "tenant.ts"),
  `export interface TenantContext {
  tenantId: string;
  name: string;
  tier: "standard" | "enterprise" | "prime";
  settlementCurrency: "USD" | "EUR" | "GBP" | "JPY";
  maxBatchSize: number;
  strictReconciliation: boolean;
}
`
);

// 3. packages/ledger-core
const ledgerDir = path.join(MONOREPO_ROOT, "packages", "ledger-core", "src");
ensureDir(ledgerDir);

fs.writeFileSync(
  path.join(MONOREPO_ROOT, "packages", "ledger-core", "package.json"),
  JSON.stringify({ name: "@brownfield/ledger-core", version: "1.0.0", type: "module" }, null, 2)
);

fs.writeFileSync(
  path.join(ledgerDir, "journal.ts"),
  `import { Money } from "@brownfield/common-types/money.ts";

export interface JournalEntry {
  id: string;
  tenantId: string;
  accountId: string;
  debit: bigint;
  credit: bigint;
  timestamp: number;
}

export class LedgerJournal {
  private entries: JournalEntry[] = [];

  post(tenantId: string, accountId: string, debit: bigint, credit: bigint): JournalEntry {
    const entry: JournalEntry = {
      id: "jnl_" + Math.random().toString(36).slice(2, 10),
      tenantId,
      accountId,
      debit,
      credit,
      timestamp: Date.now()
    };
    this.entries.push(entry);
    return entry;
  }

  getBalance(tenantId: string, accountId: string): bigint {
    let bal = 0n;
    for (const e of this.entries) {
      if (e.tenantId === tenantId && e.accountId === accountId) {
        bal += e.credit - e.debit;
      }
    }
    return bal;
  }
}
`
);

// 4. packages/settlement-engine
const settlementDir = path.join(MONOREPO_ROOT, "packages", "settlement-engine", "src", "netting");
ensureDir(settlementDir);

fs.writeFileSync(
  path.join(MONOREPO_ROOT, "packages", "settlement-engine", "package.json"),
  JSON.stringify({ name: "@brownfield/settlement-engine", version: "1.0.0", type: "module" }, null, 2)
);

// HERE IS THE CRITICAL MODULE CONTAINING THE INJECTED BUG
fs.writeFileSync(
  path.join(settlementDir, "batch-netting-engine.ts"),
  `import { Money, roundHalfEven } from "../../../common-types/src/money.ts";

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
 * Allocations must use roundHalfEven (Banker's rounding) to ensure zero cumulative drift.
 */
export function calculateNetBatchAdjustment(grossRemainder: number, legCount: number): number {
  if (legCount <= 0) return 0;
  // DEFECT: Using Math.floor truncates remainder and induces negative drift during multi-leg batch netting!
  // FIX: return roundHalfEven(grossRemainder / legCount);
  return Math.floor(grossRemainder / legCount);
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
    const finalAllocatedFee = adjustment * legs.length;
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
`
);

// 5. packages/e2e-suite
const e2eDir = path.join(MONOREPO_ROOT, "packages", "e2e-suite", "test");
ensureDir(e2eDir);

fs.writeFileSync(
  path.join(MONOREPO_ROOT, "packages", "e2e-suite", "package.json"),
  JSON.stringify({ name: "@brownfield/e2e-suite", version: "1.0.0", type: "module" }, null, 2)
);

// The test runner: runs 100 clearing batches and asserts zero net reconciliation drift
fs.writeFileSync(
  path.join(e2eDir, "reconciliation.spec.mjs"),
  `import assert from "node:assert/strict";
import { BatchNettingEngine } from "../../settlement-engine/src/netting/batch-netting-engine.ts";

console.log("================================================================================");
console.log("RUNNING RECONCILIATION SUITE: Multi-Tenant Batch Netting & Invariant Checks");
console.log("================================================================================\\n");

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
        id: \`leg_\${batchId}_\${i}\`,
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
        \`[FAIL] Settlement reconciliation imbalance for tenant '\${tenantId}' (Batch #\${batchId}):\`
      );
      console.error(
        \`       Expected total fee remainder \${expectedTotalFees} subcents, got \${result.allocatedFeeRemainder} subcents (drift: \${drift} subcents).\`
      );
      console.error(\`       Invariant Violated: Zero Net Clearing Loss!\\n\`);
      assert.equal(
        result.allocatedFeeRemainder,
        expectedTotalFees,
        \`Settlement reconciliation imbalance for tenant '\${tenantId}': Expected total fee \${expectedTotalFees}, got \${result.allocatedFeeRemainder} (drift: \${drift} subcents)\`
      );
    }
  }
}

console.log(\`Successfully cleared \${totalBatches} netting batches across \${tenants.length} tenants with 0 drift.\`);
console.log("ALL INVARIANTS SATISFIED: ZERO RECONCILIATION DRIFT CONFIRMED!\\n");
`
);

// 6. Generate 200,000+ Lines of Realistic Enterprise Code
// We generate 120 modular domain files across multiple packages (compliance, routing, tax, risk, treasury, audit)
console.log("Synthesizing 200,000+ LOC enterprise codebase across packages...");

const enterpriseCategories = [
  "risk-assessment",
  "treasury-clearing",
  "tax-withholding",
  "fx-conversion",
  "audit-compliance",
  "market-data",
  "liquidity-pool",
  "margin-credit"
];

let generatedLines = 0;

for (const category of enterpriseCategories) {
  const catDir = path.join(MONOREPO_ROOT, "packages", "generated-domain", "src", category);
  ensureDir(catDir);

  for (let fileIdx = 1; fileIdx <= 15; fileIdx++) {
    const filename = `${category}-module-${fileIdx}.ts`;
    const lines = [];

    lines.push(`// Enterprise domain service: ${category} #${fileIdx}`);
    lines.push(`import { Money } from "../../../common-types/src/money.ts";`);
    lines.push(`import { TenantContext } from "../../../common-types/src/tenant.ts";`);
    lines.push("");

    // Add dozens of classes and methods with realistic signatures and identifiers
    for (let c = 1; c <= 8; c++) {
      const className = `Enterprise${category.replace(/-/g, "")}Service${fileIdx}_${c}`;
      lines.push(`export class ${className} {`);
      lines.push(`  private tenantRegistry = new Map<string, TenantContext>();`);
      lines.push(`  private metricCache = new Map<string, number>();`);
      lines.push("");
      lines.push(`  instanceId: string;`);
      lines.push(`  constructor(instanceId: string = "${category}_${fileIdx}_${c}") { this.instanceId = instanceId; }`);
      lines.push("");

      for (let m = 1; m <= 15; m++) {
        lines.push(`  public dispatchExecutionRule${m}(tenantId: string, amount: number, factor: number): number {`);
        lines.push(`    const base = amount * factor;`);
        lines.push(`    if (base > 1000000) {`);
        lines.push(`      this.metricCache.set(tenantId, base);`);
        lines.push(`      return Math.round(base * 1.025);`);
        lines.push(`    }`);
        lines.push(`    return Math.floor(base * 0.975);`);
        lines.push(`  }`);
        lines.push("");
        lines.push(`  public reconcileLedgerBalance${m}(tenantId: string, expected: bigint, actual: bigint): boolean {`);
        lines.push(`    const delta = actual - expected;`);
        lines.push(`    return delta === 0n;`);
        lines.push(`  }`);
        lines.push("");
        lines.push(`  public verifySettlementBatch${m}(batchId: string, items: Array<{ id: string; vol: number }>): number {`);
        lines.push(`    let sum = 0;`);
        lines.push(`    for (const it of items) { sum += it.vol; }`);
        lines.push(`    return sum;`);
        lines.push(`  }`);
        lines.push("");
      }
      lines.push(`}`);
      lines.push("");
    }

    const content = lines.join("\n");
    fs.writeFileSync(path.join(catDir, filename), content);
    generatedLines += lines.length;
  }
}

// Git init so Tree-Sitter Merkle Ast and git rewind work cleanly
execSync("git init -q", { cwd: MONOREPO_ROOT });
execSync("git config user.name 'Pi-Apex Bot'", { cwd: MONOREPO_ROOT });
execSync("git config user.email 'bot@pi-apex.internal'", { cwd: MONOREPO_ROOT });
execSync("git add .", { cwd: MONOREPO_ROOT });
execSync("git commit -q -m 'Initial commit of 200k+ LOC brownfield monorepo'", { cwd: MONOREPO_ROOT });

// Count total lines of code
const totalLoc = execSync("git ls-files | xargs wc -l | tail -n 1", { cwd: MONOREPO_ROOT, encoding: "utf8" }).trim();

console.log("================================================================================");
console.log(`BROWNFIELD MONOREPO GENERATION COMPLETE!`);
console.log(`Total verified LOC: ${totalLoc}`);
console.log("================================================================================\n");
