/**
 * Parse-and-validate gate for generated study-plan payloads (PR-15).
 *
 * Model output is untrusted data: it is parsed (tolerating one ```json
 * fence), schema-checked with Zod, then business-checked against what the
 * plan is allowed to reference. Structural failures throw
 * `PlanValidationError`; the step route fails the plan with
 * `ai_provider_failed` and answers 502 — a half-parsed payload never
 * becomes an active plan.
 *
 * Division of labour with the database: this module owns everything it can
 * only decide with context the SQL layer does not have — sorting items
 * into a stable schedule order (date, then the model's original sequence)
 * so `ordinal = index`, and the citation rules around *which* resources a
 * task may point at. `generate_plan` (0020_study_plans.sql) re-validates
 * the full domain authoritatively: the [current_date, exam_date] window,
 * 1..180 items, ≤90 distinct days, the per-day minute budget, field ranges,
 * resource accessibility, and the daily chat cap.
 *
 * Citations are never taken from the model: a surviving `resource_id` is
 * paired with `{title, href}` looked up from the real `study_resources`
 * rows (server authority — same posture as PR-14 storing citation indices
 * itself), and a `resource_id` the model invented fails the whole plan.
 */

import { z } from "zod";

import { isCalendarDate } from "./dates";

export class PlanValidationError extends Error {
  readonly code = "plan_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export const PLAN_KINDS = ["read", "practice", "review", "mock", "rest"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export const PLAN_MAX_ITEMS = 180;

/**
 * Model output must be JSON. Tolerates one surrounding ```json fence (a
 * common slip) but nothing else — prose around the object is a hard
 * failure, because silently salvaging it would hide malformed generations.
 * (Same tolerance `lib/ai/quiz/validate.ts` established.)
 */
export function parsePlanJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new PlanValidationError("Model output was not valid JSON.");
  }
}

const rawItemSchema = z
  .object({
    date: z.string().refine(isCalendarDate, "Item date is not a calendar date."),
    subject: z
      .string()
      .trim()
      .max(60, "Subject must be 60 characters or fewer.")
      .nullable()
      .default(null),
    task: z.string().trim().min(1, "Task cannot be empty.").max(300, "Task must be 300 characters or fewer."),
    estimated_minutes: z
      .number()
      .int("estimated_minutes must be an integer.")
      .min(1, "estimated_minutes must be at least 1.")
      .max(480, "estimated_minutes must be at most 480."),
    kind: z.enum(PLAN_KINDS),
    resource_id: z.uuid("resource_id must be a UUID or null.").nullable().default(null),
  })
  .strip();

const rawPayloadSchema = z
  .object({
    summary: z
      .string()
      .trim()
      .max(300, "summary must be 300 characters or fewer.")
      .nullable()
      .optional()
      .default(null),
    items: z.array(rawItemSchema).min(1, "Plan needs at least one item.").max(PLAN_MAX_ITEMS),
  })
  .strip();

export type PlanItemDraft = {
  /** Final position in the RPC payload — always the array index. */
  ordinal: number;
  item_date: string;
  subject: string | null;
  task: string;
  estimated_minutes: number;
  kind: PlanKind;
  resource_id: string | null;
  citation: { title: string; href: string } | null;
};

export type ParsedPlanPayload = {
  summary: string | null;
  items: PlanItemDraft[];
};

export type PlanParseOptions = {
  /**
   * Every resource id the plan pinned at creation (`document_ids`) — the
   * outer boundary: a `resource_id` outside it is fabricated or foreign
   * and fails the whole plan.
   */
  pinnedIds: ReadonlySet<string>;
  /**
   * Live, accessible rows among the pins (id → citation the server built
   * from `study_resources`). A pinned id missing here was deleted since
   * creation: the citation is stripped, the task survives as topic work.
   */
  resources: ReadonlyMap<string, { title: string; href: string }>;
  /**
   * Ids that actually contributed retrieved chunks. A pinned, live resource
   * that did not make the retrieval window loses its citation and becomes
   * an ordinary topic task (the spec's soft rule); `null` means retrieval
   * did not run (no documents) — pins are empty then, so this is unused.
   */
  retrievedIds: ReadonlySet<string> | null;
};

function invalid(message: string): never {
  throw new PlanValidationError(message);
}

/**
 * Parses raw model text into a validated plan payload ready for
 * `generate_plan`: sorted by date (then original order) with
 * `ordinal = index`, citations rebuilt server-side, unpinned or
 * unretrieved resource references handled per the rules above.
 */
export function parsePlanPayload(
  rawText: string,
  options: PlanParseOptions,
): ParsedPlanPayload {
  const parsed = rawPayloadSchema.safeParse(parsePlanJsonObject(rawText));
  if (!parsed.success) {
    invalid("Plan payload failed schema validation.");
  }

  const rawItems = parsed.data.items;

  // Stable sort: date ascending, ties keep the model's original sequence.
  const sorted = rawItems
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.date !== b.item.date) {
        return a.item.date < b.item.date ? -1 : 1;
      }
      return a.index - b.index;
    });

  const items: PlanItemDraft[] = sorted.map(({ item }, ordinal) => {
    let resourceId: string | null = null;
    let citation: { title: string; href: string } | null = null;

    if (item.resource_id !== null) {
      if (!options.pinnedIds.has(item.resource_id)) {
        invalid("The model cited a document this plan was not built from.");
      }
      const resource = options.resources.get(item.resource_id);
      const retrieved =
        options.retrievedIds === null || options.retrievedIds.has(item.resource_id);
      if (resource && retrieved) {
        resourceId = item.resource_id;
        citation = { title: resource.title, href: resource.href };
      }
      // Pinned but deleted, or pinned but outside the retrieval window:
      // strip — the task becomes ordinary topic work, never a citation the
      // student cannot follow.
    }

    return {
      ordinal,
      item_date: item.date,
      // An empty-string subject is a model slip, not a different thing
      // from "no subject": normalize to null (SQL then sees a clean value).
      subject: item.subject === "" ? null : item.subject,
      task: item.task,
      estimated_minutes: item.estimated_minutes,
      kind: item.kind,
      resource_id: resourceId,
      citation,
    };
  });

  const summary = parsed.data.summary === "" ? null : parsed.data.summary;

  return { summary, items };
}
