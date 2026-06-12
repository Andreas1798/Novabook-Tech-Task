import { z } from "zod";

/**
 * An ISO-8601 date-time string. We accept any string that JS `Date` can parse
 * to a valid instant. Dates may be in the past or the future.
 */
const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid ISO-8601 date-time" });

/** Cost/amount values are integers in pennies. */
const pennies = z.number().int();

/** Tax rate is a fraction (e.g. 0.2 == 20%). */
const taxRate = z.number().min(0);

export const saleItemSchema = z.object({
  itemId: z.string().min(1),
  cost: pennies,
  taxRate,
});

export const salesEventSchema = z.object({
  eventType: z.literal("SALES"),
  date: isoDateTime,
  invoiceId: z.string().min(1),
  items: z.array(saleItemSchema).min(1),
});

export const taxPaymentEventSchema = z.object({
  eventType: z.literal("TAX_PAYMENT"),
  date: isoDateTime,
  amount: pennies,
});

export const ingestEventSchema = z.discriminatedUnion("eventType", [
  salesEventSchema,
  taxPaymentEventSchema,
]);

export const amendSaleSchema = z.object({
  date: isoDateTime,
  invoiceId: z.string().min(1),
  itemId: z.string().min(1),
  cost: pennies,
  taxRate,
});

export const taxPositionQuerySchema = z.object({
  date: isoDateTime,
});

export type SalesEvent = z.infer<typeof salesEventSchema>;
export type TaxPaymentEvent = z.infer<typeof taxPaymentEventSchema>;
export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type AmendSale = z.infer<typeof amendSaleSchema>;
