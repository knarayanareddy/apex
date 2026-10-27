import { Money } from "@brownfield/common-types/money.ts";

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
