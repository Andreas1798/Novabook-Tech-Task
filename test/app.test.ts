import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("HTTP API", () => {
  it("ingests a sales event and returns 202 with no body", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/transactions")
      .send({
        eventType: "SALES",
        date: "2024-02-22T17:29:39Z",
        invoiceId: "inv1",
        items: [{ itemId: "a", cost: 1099, taxRate: 0.2 }],
      });
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
  });

  it("ingests a tax payment and returns 202", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/transactions")
      .send({ eventType: "TAX_PAYMENT", date: "2024-02-22T17:29:39Z", amount: 74901 });
    expect(res.status).toBe(202);
  });

  it("amends a sale and returns 202", async () => {
    const app = createApp();
    const res = await request(app).patch("/sale").send({
      date: "2024-02-22T17:29:39Z",
      invoiceId: "inv1",
      itemId: "a",
      cost: 798,
      taxRate: 0.15,
    });
    expect(res.status).toBe(202);
  });

  it("queries the tax position end-to-end across ingest + amend", async () => {
    const app = createApp();
    await request(app)
      .post("/transactions")
      .send({
        eventType: "SALES",
        date: "2024-01-01T00:00:00Z",
        invoiceId: "inv1",
        items: [{ itemId: "a", cost: 1000, taxRate: 0.2 }],
      });
    await request(app)
      .post("/transactions")
      .send({ eventType: "TAX_PAYMENT", date: "2024-01-05T00:00:00Z", amount: 50 });

    const res = await request(app).get("/tax-position").query({ date: "2024-02-01T00:00:00Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: "2024-02-01T00:00:00Z", taxPosition: 150 });
  });

  it("rejects an invalid event type with 400", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/transactions")
      .send({ eventType: "REFUND", date: "2024-01-01T00:00:00Z", amount: 10 });
    expect(res.status).toBe(400);
  });

  it("rejects a missing query date with 400", async () => {
    const app = createApp();
    const res = await request(app).get("/tax-position");
    expect(res.status).toBe(400);
  });

  it("exposes /health and /metrics", async () => {
    const app = createApp();
    expect((await request(app).get("/health")).status).toBe(200);
    const metrics = await request(app).get("/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain("http_request_duration_seconds");
  });
});
