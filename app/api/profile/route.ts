import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import {
  createProfile,
  getProfile,
  getProfileSettings,
  ProfileError,
  updateProfileSettings,
  type SettingsProfile,
} from "@/lib/profiles/queries";
import {
  getNotificationPrefs,
} from "@/lib/notifications/queries";
import type { NotificationPrefs } from "@/lib/notifications/types";
import { profileSpec } from "@/lib/rate-limit/keys";
import { rateLimitedResponse } from "@/lib/rate-limit/check";
import { createClient } from "@/lib/supabase/server";
import { onboardingSchema, updateProfileSchema } from "@/lib/validation/profile";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

/**
 * The read/write projection every 200 answers with: exactly the fields the
 * spec publishes, never `id`/`user_id` (identity comes from the session, so
 * echoing it invites nothing) and never a column the strict schema refuses
 * to write. `email` is the session's own claim, read-only by construction —
 * there is no email column on `profiles` to update even in principle.
 */
function profileBody(
  profile: SettingsProfile,
  notificationPrefs: NotificationPrefs,
  email: string | null,
) {
  return {
    profile: {
      alias: profile.alias,
      exam_targets: profile.exam_targets,
      language: profile.language,
      notification_prefs: notificationPrefs,
      email,
      created_at: profile.created_at,
    },
  };
}

/**
 * GET /api/profile — the caller's own profile for `/settings`.
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ profile: { alias, exam_targets, language, notification_prefs, email, created_at } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — no profile row (not onboarded) |
 * | 500 | `{ "error": { "code": "profile_read_failed" } }` |
 *
 * There is no id in the route or the query: RLS only ever returns the
 * session's own row, so enumerating other students is impossible rather
 * than merely unauthorized. Read side is intentionally unthrottled (one
 * indexed lookup; the header reads the same row on every render).
 */
async function GET_raw(request: NextRequest) {
  void request;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to view your settings.",
      401,
    );
  }

  try {
    const profile = await getProfileSettings(supabase, claims.sub);
    if (!profile) {
      return errorResponse(
        "not_found",
        "You have not chosen a study alias yet.",
        404,
      );
    }
    const notification_prefs = await getNotificationPrefs(supabase, claims.sub);
    return NextResponse.json(
      profileBody(profile, notification_prefs, claims.email ?? null),
    );
  } catch (error) {
    logError("[api/profile] read failed:", errorFields(error));
    return errorResponse(
      "profile_read_failed",
      "Your profile could not be loaded. Please try again.",
      500,
    );
  }
}

export const GET = withLogging(GET_raw);

/**
 * PATCH /api/profile — partial settings update (alias, exam targets,
 * preferred language).
 *
 * The body is `.strict()`: unknown fields are a 400 naming the offender, so
 * `email`, `user_id`, `id` and `created_at` can never look like they were
 * honoured — and even a bypassed schema would hit the column grants, which
 * do not include `created_at` (and there is no email/id column at all). An
 * empty object is the goal-PATCH rule: `400 invalid_request`, not a silent
 * no-op. Identity is the session's only (id-less route, own-row RLS), and
 * `profile:{userId}` bounds a save loop (PR 10 mechanism).
 *
 * Responses:
 * | Status | Body |
 * | --- | --- |
 * | 200 | `{ profile: { alias, exam_targets, language, notification_prefs, email, created_at } }` |
 * | 400 | `{ "error": { "code": "validation" \| "invalid_json" \| "invalid_request" } }` |
 * | 401 | `{ "error": { "code": "unauthenticated" } }` |
 * | 403 | `{ "error": { "code": "forbidden" } }` |
 * | 404 | `{ "error": { "code": "not_found" } }` — profile row absent |
 * | 409 | `{ "error": { "code": "alias_taken" } }` — case-insensitive collision (the 0001 unique index) |
 * | 429 | `{ "error": { "code": "rate_limited" } }` |
 * | 500 | `{ "error": { "code": "profile_update_failed" } }` |
 */
async function PATCH_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to update your settings.",
      401,
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse(
      "invalid_json",
      "The request body must be JSON.",
      400,
    );
  }

  const raw = parsedBody.body;
  const isPlainObject =
    typeof raw === "object" && raw !== null && !Array.isArray(raw);
  if (isPlainObject && Object.keys(raw).length === 0) {
    return errorResponse(
      "invalid_request",
      "Provide at least one field to update.",
      400,
    );
  }

  const parsed = updateProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return validationResponse(parsed.error);
  }

  const limited = await rateLimitedResponse(
    supabase,
    profileSpec(claims.sub),
    "You're saving settings too quickly. Pause a moment and try again.",
  );
  if (limited) {
    return limited;
  }

  try {
    const profile = await updateProfileSettings(supabase, claims.sub, {
      alias: parsed.data.alias,
      exam_targets: parsed.data.exam_targets,
      language: parsed.data.language,
    });
    const notification_prefs = await getNotificationPrefs(supabase, claims.sub);
    return NextResponse.json(
      profileBody(profile, notification_prefs, claims.email ?? null),
    );
  } catch (error) {
    if (error instanceof ProfileError) {
      return errorResponse(error.code, error.message, error.status);
    }

    logError("[api/profile] update failed:", errorFields(error));
    return errorResponse(
      "profile_update_failed",
      "Your profile could not be saved. Please try again.",
      500,
    );
  }
}

export const PATCH = withLogging(PATCH_raw);

/**
 * POST /api/profile — onboarding: choose a unique study alias.
 * The profile id is always the session's own user id (401 without a session);
 * RLS additionally rejects any other id.
 */
async function POST_raw(request: NextRequest) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    return errorResponse(
      "unauthenticated",
      "Sign in to choose a study alias.",
      401,
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return errorResponse(
      "invalid_json",
      "The request body must be JSON.",
      400,
    );
  }

  const parsedAlias = onboardingSchema.safeParse(parsedBody.body);
  if (!parsedAlias.success) {
    return validationResponse(parsedAlias.error);
  }

  try {
    const existing = await getProfile(supabase, claims.sub);
    if (existing) {
      return NextResponse.json({ profile: existing, created: false });
    }
  } catch (error) {
    logError("[api/profile] lookup failed:", errorFields(error));
    return errorResponse(
      "query_failed",
      "Your profile could not be loaded.",
      500,
    );
  }

  try {
    const profile = await createProfile(
      supabase,
      claims.sub,
      parsedAlias.data.alias,
    );
    return NextResponse.json({ profile, created: true }, { status: 201 });
  } catch (error) {
    if (error instanceof ProfileError) {
      return errorResponse(error.code, error.message, error.status);
    }

    logError("[api/profile] create failed:", errorFields(error));
    return errorResponse(
      "query_failed",
      "Your study alias could not be saved. Please try again.",
      500,
    );
  }
}

export const POST = withLogging(POST_raw);
