import { z } from "zod";

/**
 * Request schemas for the study analytics API (PR 16).
 *
 * The only query the API takes is the range. There is deliberately no
 * identity field anywhere: personal analytics are always about the caller's
 * session, and `analytics_me` aggregates `auth.uid()` regardless of any
 * parameter — a `?user_id=` in the URL is ignored by the route and would be
 * collapsed to self inside the RPC anyway.
 */

/** The ranges `?range=` accepts. Missing or unknown → 400 `validation`. */
export const analyticsRangeSchema = z.enum(["7d", "30d", "90d"]);

export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export const ANALYTICS_RANGES = analyticsRangeSchema.options;

/** The message every 400 for a bad range carries (route issues + docs). */
export const ANALYTICS_RANGE_MESSAGE = "Range must be 7d, 30d or 90d.";
