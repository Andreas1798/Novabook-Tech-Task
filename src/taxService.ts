import type { AmendSale, SalesEvent, TaxPaymentEvent } from "./schemas.js";

/**
 * A single value of an item at a point in time. Both the original sale line
 * and every amendment produce an ItemVersion.
 *
 * Effective value of an item for a query at date D:
 *   - if any AMENDMENT is effective (dateMs <= D), use the latest such amendment;
 *   - otherwise use the original sale line if it is effective.
 * Within the same category, the latest `dateMs` wins (ties broken by `seq`).
 *
 * This makes amendments authoritative corrections: once effective they cannot be
 * reverted by the original sale line, regardless of the sale's date or the order
 * in which events arrive. See README for how this differs from the original spec.
 */
interface ItemVersion {
  invoiceId: string;
  itemId: string;
  dateMs: number;
  cost: number;
  taxRate: number;
  seq: number;
  isAmendment: boolean;
}

interface Payment {
  dateMs: number;
  amount: number;
}

const itemKey = (invoiceId: string, itemId: string): string => `${invoiceId}\u0000${itemId}`;

/** Tax for a single item, rounded to the nearest penny. */
const itemTax = (cost: number, taxRate: number): number => Math.round(cost * taxRate);

/**
 * Does candidate `a` supersede the currently selected version `b` for an item?
 * Amendments outrank the sale line; within the same category the later date
 * wins, with `seq` (ingestion order) breaking exact-timestamp ties.
 */
const wins = (a: ItemVersion, b: ItemVersion): boolean => {
  if (a.isAmendment !== b.isAmendment) return a.isAmendment;
  if (a.dateMs !== b.dateMs) return a.dateMs > b.dateMs;
  return a.seq > b.seq;
};

/**
 * In-memory tax service. Stores every item version and tax payment, and derives
 * the tax position for any query date from that history.
 */
export class TaxService {
  private readonly versions: ItemVersion[] = [];
  private readonly payments: Payment[] = [];
  private seq = 0;

  ingestSale(event: SalesEvent): void {
    const dateMs = Date.parse(event.date);
    for (const item of event.items) {
      this.versions.push({
        invoiceId: event.invoiceId,
        itemId: item.itemId,
        dateMs,
        cost: item.cost,
        taxRate: item.taxRate,
        seq: this.seq++,
        isAmendment: false,
      });
    }
  }

  ingestTaxPayment(event: TaxPaymentEvent): void {
    this.payments.push({ dateMs: Date.parse(event.date), amount: event.amount });
  }

  amendSale(amendment: AmendSale): void {
    this.versions.push({
      invoiceId: amendment.invoiceId,
      itemId: amendment.itemId,
      dateMs: Date.parse(amendment.date),
      cost: amendment.cost,
      taxRate: amendment.taxRate,
      seq: this.seq++,
      isAmendment: true,
    });
  }

  /** Tax position (in pennies) effective at `queryDate`: sales tax minus payments. */
  queryTaxPosition(queryDate: string): number {
    const atMs = Date.parse(queryDate);

    // For each item, find its effective version at the query date. An effective
    // amendment always beats the sale line; otherwise the latest effective
    // version wins (ties broken by insertion order via `seq`).
    const effective = new Map<string, ItemVersion>();
    for (const v of this.versions) {
      if (v.dateMs > atMs) continue;
      const key = itemKey(v.invoiceId, v.itemId);
      const current = effective.get(key);
      if (!current || wins(v, current)) {
        effective.set(key, v);
      }
    }

    let salesTax = 0;
    for (const v of effective.values()) {
      salesTax += itemTax(v.cost, v.taxRate);
    }

    let paid = 0;
    for (const p of this.payments) {
      if (p.dateMs <= atMs) paid += p.amount;
    }

    return salesTax - paid;
  }
}
