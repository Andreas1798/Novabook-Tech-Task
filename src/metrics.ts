import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const eventsIngested = new Counter({
  name: "tax_events_ingested_total",
  help: "Total ingest/amend events accepted, by type",
  labelNames: ["type"] as const,
  registers: [registry],
});
