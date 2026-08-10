import { z } from "zod";
import { amountMinor, currency, isoDate, timestamp, uuid } from "./common.js";

/** CHECK (frequency IN ('weekly','monthly')). Named `frequency`, not `interval`,
 *  because `interval` is a Postgres keyword. No biweekly/yearly/cron in v1. */
export const recurringFrequency = z.enum(["weekly", "monthly"]);

const description = z.string().min(1).max(200);
const notes = z.string().max(2000);

/**
 * The rule's editable surface, unrefined. Both the create body and the patch
 * body are built from it, so the two can never drift; the cross-field rule is
 * applied separately because `.partial()` must not be able to drop it.
 */
const ruleFields = {
  categoryId: uuid,
  amountMinor,
  description,
  notes: notes.optional(),
  frequency: recurringFrequency,
  startDate: isoDate,
  endDate: isoDate.optional(),
};

/**
 * CHECK (end_date IS NULL OR end_date >= start_date), mirrored on the wire.
 * A patch may carry either bound alone — with only one present there is nothing
 * to compare here, and the server re-checks against the stored row.
 */
const endsOnOrAfterStart = (v: {
  startDate?: string;
  endDate?: string;
}): boolean =>
  v.startDate === undefined ||
  v.endDate === undefined ||
  v.endDate >= v.startDate;

const ENDS_BEFORE_START = {
  message: "endDate must not be before startDate",
  path: ["endDate"],
};

/**
 * Input. No `nextOccurrence`: the server derives it as the first occurrence on
 * or after today, which is what makes "no backfill" structural rather than a
 * rule the client is trusted to follow.
 */
export const createRecurringBody = z
  .object(ruleFields)
  .refine(endsOnOrAfterStart, ENDS_BEFORE_START);

/** Input. Every field optional; the rule id travels in the path. */
export const patchRecurringBody = z
  .object(ruleFields)
  .partial()
  .refine(endsOnOrAfterStart, ENDS_BEFORE_START);

/** Output. `nextOccurrence` is never null — a rule always knows its next date. */
export const recurringRuleDto = z.object({
  id: uuid,
  categoryId: uuid,
  amountMinor,
  currency,
  description: z.string(),
  notes: z.string().nullable(),
  frequency: recurringFrequency,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  nextOccurrence: isoDate,
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const recurringRulesResponse = z.object({
  items: z.array(recurringRuleDto),
});

export type RecurringFrequency = z.infer<typeof recurringFrequency>;
export type CreateRecurringBody = z.infer<typeof createRecurringBody>;
export type PatchRecurringBody = z.infer<typeof patchRecurringBody>;
export type RecurringRule = z.infer<typeof recurringRuleDto>;
export type RecurringRulesResponse = z.infer<typeof recurringRulesResponse>;
