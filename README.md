# Novabook Tax Service

A TypeScript HTTP service that ingests sales and tax-payment events and lets a
user query their tax position at any point in time (past, present, or future).

> **This is the alternative-implementation branch.** It treats the brief as
> *loose* requirements and deviates from the spec where a literal reading is
> nonsensical in the real world. See the comparison below. The faithful,
> spec-literal version lives on the enforced_requirements branch.

## Implementation differences vs. the spec-literal version

| Aspect | Spec-literal (enforced_requirements) | Alternative (this branch) |
| --- | --- | --- |
| Amendment vs. original sale | Both are equal "versions" on a single timeline; the value at date `D` is whichever has the **latest effective date ≤ `D`**. | An effective amendment is an **authoritative correction**: it supersedes the original sale line and is never reverted by it. |
| Amendment dated *before* the sale | After the sale's date the **original sale value re-applies** (the amendment is silently undone). | The amendment **stays applied** for all dates ≥ its own date. |
| Behaviour in normal ordering (amendment dated after sale) | Identical | Identical |
| Code | Single comparator on `(date, seq)` | Comparator prefers amendments, then `(date, seq)` |

### Why this change

The spec says an amendment can arrive *before* its sale and that events carry
their own dates. Read literally with a single-timeline model, an amendment dated
earlier than the original sale is **reverted** the moment a query date passes the
sale's date — i.e. a correction is undone by the very thing it was correcting.
That is not a sensible real-world outcome for a financial correction and it
forces a confusing documented edge case.

This branch resolves it by making amendments authoritative: once an amendment is
effective at the query date it wins over the original sale line, regardless of
the sale's date or the order events arrive in. Everything else — effective-dated
queries, multiple amendments over time, amendments for not-yet-received sales,
rounding, payments — is unchanged. The only observable difference is the
pathological "amendment effective-dated earlier than its sale" case (see
`taxService.test.ts`).

**Trade-off / limitation:** with "an effective amendment always wins", a brand
new `SALES` event that re-states an already-amended item would be ignored.
That's an accepted edge (the same `(invoiceId, itemId)` is not expected to be
re-sold) and is the price of keeping corrections sticky.

### Other spec quirks considered but *not* changed

These are arguably unusual, but they don't overcomplicate the implementation, so
the code follows the spec as written:

- **Querying the tax position at a *future* date** returns a position that
  includes future-dated events — a forecast rather than a settled position. Kept
  because "past or future dates are possible" is explicit.
- **`202 Accepted` with no body** gives the caller no event id to correlate
  against. Kept; a real async pipeline would return a tracking id / `Location`.
- **No idempotency** means re-delivery double-counts. Kept for the POC; see the
  "wider-system integration" section for how this would be handled.

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

# Query tax position (reflects all three commands above at that timestamp)
curl 'http://localhost:3000/tax-position?date=2024-02-22T17:29:39Z'
# -> {"date":"2024-02-22T17:29:39Z","taxPosition":-74781}
# sales tax = round(798 * 0.15) = 120 (amendment supersedes the sale line);
# minus the 74901 tax payment => 120 - 74901 = -74781
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
is selected as follows: **if any amendment is effective (date `≤ D`), the latest
such amendment wins; otherwise the original sale line wins** (if effective). This
satisfies the requirements:

- Amendments may arrive **before** the corresponding sale event (out-of-order
  ingestion) — they're just stored on the timeline.
- An item can be amended at **multiple points in time** — the most recent
  amendment effective at `D` wins.
- An effective amendment is authoritative and is never reverted by the original
  sale line (this branch's deviation from the spec-literal model — see the top
  of this README).

## Assumptions & judgment calls

These resolve ambiguities in the spec. They're documented here as required.

1. **Rounding.** `cost * taxRate` is often fractional (e.g. `1099 * 0.2 = 219.8`).
   Tax is rounded to the nearest penny **per item** (`Math.round`) before
   summing. (The spec's standalone examples don't pin down rounding, so this is
   a deliberate choice; banker's rounding or summing-then-rounding are
   alternatives.)
2. **Amendments are authoritative corrections** (this branch's main deviation —
   see the comparison at the top). Once an amendment is effective at the query
   date it supersedes the original sale line and is never reverted by it.
3. **Amendments for non-existent sales/items still count.** The spec says the
   service must accept all amendments even if the sale/item doesn't exist. An
   orphan amendment contributes tax from its effective date onward.
4. **Tie-break on identical timestamps.** Within the same category (sale vs.
   amendment), if two versions of an item share an exact timestamp the one
   ingested later wins.
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

## POC scope vs. wider-system integration

Several choices here are deliberate **proof-of-concept** simplifications. This
section calls out what is POC-only and how each would change once the service is
embedded in a larger system.

### What is POC-only (and why)

- **In-memory storage.** All state lives in process memory and resets on
  restart. It keeps the POC dependency-free and makes the effective-dated logic
  the focus. It is **not** durable, not shareable across instances, and unbounded
  in growth.
- **Synchronous, request-time computation.** The tax position is recomputed from
  full history on every query via a linear scan. Correct and trivially
  consistent at POC scale, but `O(events)` per query.
- **Single instance, no concurrency control.** Node's single-threaded event loop
  serialises mutations, so the POC needs no locking. That guarantee disappears
  the moment you run more than one replica.
- **HTTP-only ingestion.** Events arrive synchronously over HTTP. The brief's
  `202 Accepted` already hints at an asynchronous, queue-backed design.
- **No idempotency / dedupe.** Re-sending the same event double-counts. Fine for
  a POC, unacceptable for at-least-once delivery upstream.
- **No auth/tenancy.** Explicitly out of scope per the brief (single user).

### How integration into a wider system would be handled

- **Persistence → durable, append-only event store.** Replace the in-memory
  arrays with a database (e.g. Postgres). The current model is already an
  event log, so it maps directly onto an append-only `events` table; the
  `TaxService` interface stays the same while the storage implementation is
  swapped behind it. This gives durability, a shared source of truth across
  instances, and an audit trail.
- **Read performance → precomputed/materialised positions.** Rather than scan
  all history per query, maintain running aggregates (e.g. per-item effective
  value and cumulative tax) updated on ingest, or a materialised daily ledger
  that a query can index into. Because events can be back- or future-dated, the
  update must recompute from the affected effective date forward, not just
  append.
- **Ingestion → message queue.** In a wider system events would more likely
  arrive from a broker (Kafka/SQS/PubSub) than direct HTTP. The `202` contract
  fits this: accept, enqueue, acknowledge, and process asynchronously. The HTTP
  layer becomes a thin adapter over the same domain service.
- **Idempotency & ordering.** Add an event/idempotency key so retries and
  at-least-once delivery don't double-count. Effective-dating already makes the
  service insensitive to *processing* order, but dedupe must be explicit.
- **Horizontal scaling & consistency.** With a shared store and stateless
  instances the service scales out behind a load balancer; concurrency control
  (transactions / optimistic locking on aggregates) replaces the implicit
  single-thread guarantee.
- **Multi-tenancy & auth.** Introduce a tenant/account key on every event and
  query, authn/authz at the edge (gateway or middleware), and partition both
  storage and metrics by tenant.
- **Contracts & versioning.** Promote the `zod` schemas to a shared, versioned
  API contract (OpenAPI / schema registry) so producers and consumers evolve
  safely.
- **Observability in context.** The structured logs and `/metrics` already plug
  into a central stack: ship logs to aggregation (ELK/Loki), scrape Prometheus,
  add distributed tracing (OpenTelemetry) with trace IDs propagated from upstream
  callers, and wire `/health` (plus a `/ready` readiness probe) into the
  orchestrator.

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
