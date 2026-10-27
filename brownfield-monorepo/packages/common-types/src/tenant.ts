export interface TenantContext {
  tenantId: string;
  name: string;
  tier: "standard" | "enterprise" | "prime";
  settlementCurrency: "USD" | "EUR" | "GBP" | "JPY";
  maxBatchSize: number;
  strictReconciliation: boolean;
}
