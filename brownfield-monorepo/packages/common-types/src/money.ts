export interface MoneyAmount {
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
