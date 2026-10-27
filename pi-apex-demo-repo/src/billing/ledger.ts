export function calculateCents(units: number, priceCents: number): number {
  if (!Number.isFinite(units) || units < 0) throw new RangeError("invalid units");
  return Math.round(units * priceCents);
}
