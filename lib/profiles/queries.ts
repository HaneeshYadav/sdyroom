import type { SupabaseClient } from "@supabase/supabase-js";

export type Profile = {
  id: string;
  alias: string;
};

export class ProfileQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileQueryError";
  }
}

export type ProfileErrorCode =
  | "alias_taken"
  | "already_exists"
  | "forbidden"
  | "not_found"
  | "query_failed";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly status: number;

  constructor(code: ProfileErrorCode, message: string, status: number) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads a profile through RLS: the caller only ever sees their own row, so a
 * missing row means "not onboarded" rather than "does not exist".
 */
export async function getProfile(
  client: SupabaseClient,
  userId: string,
): Promise<Profile | null> {
  const { data, error } = await client
    .from("profiles")
    .select("id, alias")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new ProfileQueryError(error.message);
  }

  if (!data) {
    return null;
  }

  return { id: String(data.id), alias: String(data.alias) };
}

/**
 * Creates the profile row for the authenticated user. The id is the caller's
 * own user id — the RLS policy only allows `id = auth.uid()`.
 * Case-insensitive alias collisions arrive as 23505 on
 * `profiles_alias_lower_key` and are surfaced as `alias_taken`.
 */
export async function createProfile(
  client: SupabaseClient,
  userId: string,
  alias: string,
): Promise<Profile> {
  const { data, error } = await client
    .from("profiles")
    .insert({ id: userId, alias })
    .select("id, alias")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      if (error.message.includes("profiles_alias_lower_key")) {
        throw new ProfileError(
          "alias_taken",
          "That study alias is already taken. Try another one.",
          409,
        );
      }
      if (error.message.includes("profiles_pkey")) {
        throw new ProfileError(
          "already_exists",
          "You already chose a study alias.",
          409,
        );
      }
    }

    if (error.code === "42501") {
      throw new ProfileError(
        "forbidden",
        "You can only create your own profile.",
        403,
      );
    }

    throw new ProfileError(
      "query_failed",
      "Your study alias could not be saved. Please try again.",
      500,
    );
  }

  if (!data) {
    throw new ProfileError(
      "query_failed",
      "Your study alias could not be saved. Please try again.",
      500,
    );
  }

  return { id: String(data.id), alias: String(data.alias) };
}

/**
 * The settings projection: everything `/settings` renders and
 * `PATCH /api/profile` writes back. Deliberately separate from `getProfile`
 * — the header and the onboarding response stay a minimal `{ id, alias }`
 * projection (asserted by the privacy suite), while settings needs the
 * exam targets, language and creation date.
 */
export type SettingsProfile = {
  id: string;
  alias: string;
  exam_targets: string[];
  language: string | null;
  created_at: string;
};

const SETTINGS_COLUMNS = "id, alias, exam_targets, language, created_at";

function toSettingsProfile(row: {
  id: unknown;
  alias: unknown;
  exam_targets: unknown;
  language: unknown;
  created_at: unknown;
}): SettingsProfile {
  return {
    id: String(row.id),
    alias: String(row.alias),
    exam_targets: Array.isArray(row.exam_targets)
      ? row.exam_targets.map((value) => String(value))
      : [],
    language:
      row.language === null || row.language === undefined
        ? null
        : String(row.language),
    created_at: String(row.created_at),
  };
}

/**
 * Reads the caller's own settings row through RLS. `null` means "not
 * onboarded yet" — the settings page redirects such a session to onboarding
 * rather than rendering an empty form.
 */
export async function getProfileSettings(
  client: SupabaseClient,
  userId: string,
): Promise<SettingsProfile | null> {
  const { data, error } = await client
    .from("profiles")
    .select(SETTINGS_COLUMNS)
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new ProfileQueryError(error.message);
  }
  if (!data) {
    return null;
  }
  return toSettingsProfile(data);
}

export type ProfileSettingsUpdate = {
  alias?: string;
  exam_targets?: string[];
  language?: string | null;
};

/**
 * Applies a partial settings update to the caller's own row (RLS:
 * `id = auth.uid()` and the update grant covers exactly alias, exam_targets,
 * language, notification_prefs — so the columns a hostile body might hope to
 * reach are not writable even if validation were bypassed).
 *
 * An absent row is a `not_found`, not a retryable oddity: `alias` is NOT
 * NULL with no usable default, so there is no honest "insert with defaults"
 * path — settings is only reachable after onboarding created the row, and
 * the API answers the same 404 whether the row never existed or the caller
 * somehow asked about another identity.
 */
export async function updateProfileSettings(
  client: SupabaseClient,
  userId: string,
  patch: ProfileSettingsUpdate,
): Promise<SettingsProfile> {
  const payload: Record<string, unknown> = {};
  if (patch.alias !== undefined) payload.alias = patch.alias;
  if (patch.exam_targets !== undefined) payload.exam_targets = patch.exam_targets;
  if (patch.language !== undefined) payload.language = patch.language;

  const { data, error } = await client
    .from("profiles")
    .update(payload)
    .eq("id", userId)
    .select(SETTINGS_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505" && error.message.includes("profiles_alias_lower_key")) {
      throw new ProfileError(
        "alias_taken",
        "That study alias is already taken. Try another one.",
        409,
      );
    }
    if (error.code === "42501") {
      throw new ProfileError(
        "forbidden",
        "You can only change your own profile.",
        403,
      );
    }
    throw new ProfileError(
      "query_failed",
      "Your profile could not be saved. Please try again.",
      500,
    );
  }

  if (!data) {
    throw new ProfileError(
      "not_found",
      "Your profile could not be found. Choose a study alias first.",
      404,
    );
  }

  return toSettingsProfile(data);
}
