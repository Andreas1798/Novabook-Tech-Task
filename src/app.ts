import express, { type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import { eventsIngested, httpRequestDuration, registry } from "./metrics.js";
import {
  amendSaleSchema,
  ingestEventSchema,
  taxPositionQuerySchema,
} from "./schemas.js";
import { TaxService } from "./taxService.js";

export function createApp(service: TaxService = new TaxService()) {
  const app = express();
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  // Record request latency per route/status for observability.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      end({ method: req.method, route: req.route?.path ?? req.path, status: res.statusCode });
    });
    next();
  });

  // POST /transactions — ingest a sales or tax payment event.
  app.post("/transactions", (req: Request, res: Response) => {
    const event = ingestEventSchema.parse(req.body);
    if (event.eventType === "SALES") {
      service.ingestSale(event);
      eventsIngested.inc({ type: "SALES" });
      req.log.info({ invoiceId: event.invoiceId, items: event.items.length }, "ingested sales event");
    } else {
      service.ingestTaxPayment(event);
      eventsIngested.inc({ type: "TAX_PAYMENT" });
      req.log.info({ amount: event.amount }, "ingested tax payment event");
    }
    res.status(202).end();
  });

  // PATCH /sale — amend an item within a sale at a point in time.
  app.patch("/sale", (req: Request, res: Response) => {
    const amendment = amendSaleSchema.parse(req.body);
    service.amendSale(amendment);
    eventsIngested.inc({ type: "AMENDMENT" });
    req.log.info(
      { invoiceId: amendment.invoiceId, itemId: amendment.itemId, date: amendment.date },
      "amended sale item",
    );
    res.status(202).end();
  });

  // GET /tax-position?date=... — query the tax position effective at a date.
  app.get("/tax-position", (req: Request, res: Response) => {
    const { date } = taxPositionQuerySchema.parse(req.query);
    const taxPosition = service.queryTaxPosition(date);
    req.log.info({ date, taxPosition }, "queried tax position");
    res.status(200).json({ date, taxPosition });
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/metrics", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // Centralised error handling: validation errors -> 400, everything else -> 500.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      req.log.warn({ issues: err.issues }, "validation failed");
      return res.status(400).json({ error: "ValidationError", issues: err.issues });
    }
    // Malformed JSON bodies surface from express.json() with statusCode 400.
    if (err instanceof SyntaxError && (err as { statusCode?: number }).statusCode === 400) {
      req.log.warn({ err: err.message }, "malformed JSON body");
      return res.status(400).json({ error: "BadRequest", message: "Malformed JSON body" });
    }
    req.log.error({ err }, "unhandled error");
    return res.status(500).json({ error: "InternalServerError" });
  });

  return app;
}
