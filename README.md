# Novabook Tax Service

A TypeScript HTTP service that ingests sales and tax-payment events and lets a
user query their tax position at any point in time (past, present, or future).

## Quick start

Requires Node 18+.

```bash
npm install
npm start          # starts the service on http://localhost:3000 (set PORT to override)
```

Development & verification:

```bash
npm run dev        # start with auto-reload (tsx watch)
npm test           # run the test suite (vitest)
npm run typecheck  # type-check without emitting
npm run build      # compile to dist/
```

## Endpoints

| Method | Path            | Success | Description                                      |
| ------ | --------------- | ------- | ------------------------------------------------ |
| POST   | `/transactions` | 202     | Ingest a `SALES` or `TAX_PAYMENT` event          |
| PATCH  | `/sale`         | 202     | Amend an item within a sale at a point in time   |
| GET    | `/tax-position` | 200     | Query the tax position effective at a date       |
| GET    | `/health`       | 200     | Liveness probe                                   |
| GET    | `/metrics`      | 200     | Prometheus metrics                               |

### Examples

```bash
# Ingest a sales event
curl -X POST http://localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"SALES","date":"2024-02-22T17:29:39Z","invoiceId":"inv1",
       "items":[{"itemId":"item1","cost":1099,"taxRate":0.2}]}'

# Ingest a tax payment
curl -X POST http://localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"eventType":"TAX_PAYMENT","date":"2024-02-22T17:29:39Z","amount":74901}'

# Amend an item (effective at the given date)
curl -X PATCH http://localhost:3000/sale \
  -H 'Content-Type: application/json' \
  -d '{"date":"2024-02-22T17:29:39Z","invoiceId":"inv1","itemId":"item1",
       "cost":798,"taxRate":0.15}'

# Query tax position
curl 'http://localhost:3000/tax-position?date=2024-02-22T17:29:39Z'
# -> {"date":"2024-02-22T17:29:39Z","taxPosition":220}
```

## How it works

The core insight is that **every value is effective-dated**. The service keeps
the full history of events in memory and derives the answer at query time:

- Tax for one item = `round(cost * taxRate)` (pennies).
- **Tax position at date `D`** = (sum of each item's tax, using the value
  effective at `D`) − (sum of all tax payments dated `≤ D`).
- The `date` in every payload is the event's effective date. Queries only
  consider events dated `≤ D`. Ingestion order is irrelevant.

### Item timeline (amendments)

An item, keyed by `(invoiceId, itemId)`, has a **timeline of versions**. The
original sale line is one version (at the sale's date); each amendment adds
another version (at the amendment's date). For a query at `D`, the item's value
is the version with the greatest date `≤ D`. This naturally satisfies the
requirements:

- Amendments may arrive **before** the corresponding sale event (out-of-order
  ingestion) — they're just stored on the timeline.
- An item can be amended at **multiple points in time** — each amendment is a
  version; the most recent one effective at `D` wins.

## Assumptions & judgment calls

These resolve ambiguities in the spec. They're documented here as required.

1. **Rounding.** `cost * taxRate` is often fractional (e.g. `1099 * 0.2 = 219.8`).
   Tax is rounded to the nearest penny **per item** (`Math.round`) before
   summing. (The spec's standalone examples don't pin down rounding, so this is
   a deliberate choice; banker's rounding or summing-then-rounding are
   alternatives.)
2. **Effective-dating an amendment relative to a later-dated sale.** Because the
   value at `D` is the most recent version dated `≤ D`, an amendment dated
   *earlier* than a sale only applies for queries between the amendment date and
   the sale date; from the sale date onward the (more recent) sale value applies
   again. This is the most consistent reading of "respect the date in every
   payload", and is covered by a test.
3. **Amendments for non-existent sales/items still count.** The spec says the
   service must accept all amendments even if the sale/item doesn't exist. Since
   sale lines and amendments are unified as timeline versions, an orphan
   amendment contributes tax from its date onward.
4. **Tie-break on identical timestamps.** If two versions of the same item share
   an exact timestamp, the one ingested later wins.
5. **Negative tax positions** are allowed (payments can exceed accrued tax).
6. **Storage is in-memory.** No persistence requirement was stated; single-user,
   no auth, no tenants (per the brief). State resets on restart.
7. **Validation.** Bodies are validated with `zod`; invalid payloads return
   `400`. Unknown event types are rejected. `cost`/`amount` must be integer
   pennies; `taxRate` must be `≥ 0`.

## Observability

- **Structured logging** (`pino` / `pino-http`): every request is logged with
  method, route, status, and latency; business events (sale ingested, payment
  ingested, amendment, query result) are logged with relevant fields. Set
  `LOG_LEVEL` (default `info`).
- **Metrics** (`prom-client`) at `GET /metrics`: default process metrics, an
  `http_request_duration_seconds` histogram (labelled by method/route/status),
  and a `tax_events_ingested_total` counter (labelled by type).
- **Health check** at `GET /health`.

## Project layout

```
src/
  schemas.ts      # zod request schemas + inferred types
  taxService.ts   # in-memory store + effective-dated tax logic
  app.ts          # express app, routes, error handling, observability wiring
  logger.ts       # pino logger
  metrics.ts      # prom-client registry & metrics
  index.ts        # server entrypoint
test/
  taxService.test.ts  # core logic incl. timeline/amendment edge cases
  app.test.ts         # HTTP behaviour (status codes, validation, metrics)
```
