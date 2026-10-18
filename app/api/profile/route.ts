import { NextResponse, type NextRequest } from "next/server";
import {
  errorResponse,
  readJsonBody,
  validationResponse,
} from "@/lib/api/responses";
import {
  createProfile,
  getProfile,
  ProfileError,
} from "@/lib/profiles/queries";
import { createClient } from "@/lib/supabase/server";
import { onboardingSchema } from "@/lib/validation/profile";
import { withLogging } from "@/lib/server/with-logging";
import { errorFields, logError } from "@/lib/server/log";

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
