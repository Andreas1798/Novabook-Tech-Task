import { describe, expect, it } from "vitest";
import { TaxService } from "../src/taxService.js";

const sale = (date: string, invoiceId: string, items: { itemId: string; cost: number; taxRate: number }[]) =>
  ({ eventType: "SALES", date, invoiceId, items }) as const;

describe("TaxService", () => {
  it("computes sales tax rounded per item to the nearest penny", () => {
    const svc = new TaxService();
    // 1099 * 0.2 = 219.8 -> 220
    svc.ingestSale(sale("2024-02-22T17:29:39Z", "inv1", [{ itemId: "a", cost: 1099, taxRate: 0.2 }]));
    expect(svc.queryTaxPosition("2024-02-22T17:29:39Z")).toBe(220);
  });

  it("subtracts tax payments from sales tax", () => {
    const svc = new TaxService();
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200
    svc.ingestTaxPayment({ eventType: "TAX_PAYMENT", date: "2024-01-02T00:00:00Z", amount: 50 });
    expect(svc.queryTaxPosition("2024-01-02T00:00:00Z")).toBe(150);
  });

  it("only includes events with date <= query date (future dates excluded)", () => {
    const svc = new TaxService();
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200
    svc.ingestSale(sale("2025-01-01T00:00:00Z", "inv2", [{ itemId: "b", cost: 1000, taxRate: 0.2 }])); // future
    expect(svc.queryTaxPosition("2024-06-01T00:00:00Z")).toBe(200);
    expect(svc.queryTaxPosition("2025-06-01T00:00:00Z")).toBe(400);
  });

  it("query before any event returns 0", () => {
    const svc = new TaxService();
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }]));
    expect(svc.queryTaxPosition("2023-01-01T00:00:00Z")).toBe(0);
  });

  it("applies the latest amendment effective at the query date", () => {
    const svc = new TaxService();
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200
    // Amend the item's value effective 2024-02-01: 500 * 0.1 = 50
    svc.amendSale({ date: "2024-02-01T00:00:00Z", invoiceId: "inv1", itemId: "a", cost: 500, taxRate: 0.1 });

    expect(svc.queryTaxPosition("2024-01-15T00:00:00Z")).toBe(200); // before amendment
    expect(svc.queryTaxPosition("2024-02-15T00:00:00Z")).toBe(50); // after amendment
  });

  it("supports multiple amendments at multiple points in time", () => {
    const svc = new TaxService();
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200
    svc.amendSale({ date: "2024-02-01T00:00:00Z", invoiceId: "inv1", itemId: "a", cost: 2000, taxRate: 0.2 }); // 400
    svc.amendSale({ date: "2024-03-01T00:00:00Z", invoiceId: "inv1", itemId: "a", cost: 3000, taxRate: 0.2 }); // 600

    expect(svc.queryTaxPosition("2024-01-10T00:00:00Z")).toBe(200);
    expect(svc.queryTaxPosition("2024-02-10T00:00:00Z")).toBe(400);
    expect(svc.queryTaxPosition("2024-03-10T00:00:00Z")).toBe(600);
  });

  it("accepts an amendment that arrives before its sale event (out-of-order ingestion)", () => {
    const svc = new TaxService();
    // Amendment received first, effective 2024-02-01
    svc.amendSale({ date: "2024-02-01T00:00:00Z", invoiceId: "inv1", itemId: "a", cost: 500, taxRate: 0.2 }); // 100
    // Sale event arrives later but is dated earlier (2024-01-01)
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200

    expect(svc.queryTaxPosition("2024-01-15T00:00:00Z")).toBe(200); // only sale effective
    expect(svc.queryTaxPosition("2024-02-15T00:00:00Z")).toBe(100); // amendment now effective
  });

  it("treats an amendment as authoritative: a later-dated original sale cannot revert it", () => {
    const svc = new TaxService();
    // Amendment is effective EARLIER than the original sale's date.
    svc.amendSale({ date: "2024-02-20T00:00:00Z", invoiceId: "inv1", itemId: "a", cost: 500, taxRate: 0.2 }); // 100
    svc.ingestSale(sale("2024-02-22T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200

    // After both dates the amendment still wins (the POC reverted to 200 here).
    expect(svc.queryTaxPosition("2024-03-01T00:00:00Z")).toBe(100);
  });

  it("counts an amendment for an item that has no sale yet", () => {
    const svc = new TaxService();
    svc.amendSale({ date: "2024-02-01T00:00:00Z", invoiceId: "ghost", itemId: "x", cost: 1000, taxRate: 0.2 });
    expect(svc.queryTaxPosition("2024-01-01T00:00:00Z")).toBe(0); // before its date
    expect(svc.queryTaxPosition("2024-03-01T00:00:00Z")).toBe(200); // effective
  });

  it("can produce a negative tax position when payments exceed sales tax", () => {
    const svc = new TaxService();
    svc.ingestSale(sale("2024-01-01T00:00:00Z", "inv1", [{ itemId: "a", cost: 1000, taxRate: 0.2 }])); // 200
    svc.ingestTaxPayment({ eventType: "TAX_PAYMENT", date: "2024-01-02T00:00:00Z", amount: 500 });
    expect(svc.queryTaxPosition("2024-01-02T00:00:00Z")).toBe(-300);
  });
});
