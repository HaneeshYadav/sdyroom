import { redirect } from "next/navigation";

import { PreferencesForm } from "@/components/notifications/preferences-form";
import { AccountSection } from "@/components/settings/account-section";
import { ProfileForm } from "@/components/settings/profile-form";
import { StudyPreferencesForm } from "@/components/settings/study-preferences-form";
import {
  getNotificationPrefs,
  NotificationQueryError,
} from "@/lib/notifications/queries";
import { getProfileSettings, ProfileQueryError } from "@/lib/profiles/queries";
import { errorFields, logError } from "@/lib/server/log";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Settings · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

/**
 * `/settings` — the one place a student manages their own account: alias,
 * exam targets, language, notification preferences (PR 11's form, absorbed
 * unchanged — the preferences state lives in `profiles.notification_prefs`
 * and only ever flows through 11's endpoint, so settings and the inbox can
 * never disagree), and read-only account facts.
 *
 * Signed-out visitors are sent to login before any query runs, and a session
 * without a profile row (somehow past onboarding's guard) is sent back to
 * onboarding rather than shown an empty form — the same session rules the
 * rest of the authenticated app applies.
 */
export default async function SettingsPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub) {
    redirect("/auth/login");
  }

  // The fetches stay outside the JSX: a failure is logged here and rethrown,
  // and the segment's error boundary (error.tsx) is what the student sees.
  const [profile, prefs] = await Promise.all([
    getProfileSettings(supabase, claims.sub),
    getNotificationPrefs(supabase, claims.sub),
  ]).catch((error: unknown) => {
    if (
      error instanceof ProfileQueryError ||
      error instanceof NotificationQueryError
    ) {
      logError("[settings page] load failed:", errorFields(error));
    }
    throw error;
  });

  if (!profile) {
    redirect("/onboarding");
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Your alias, study targets, language and notifications — what
          classmates see and what reaches your inbox.
        </p>
      </div>

      <ProfileForm initialAlias={profile.alias} />

      <StudyPreferencesForm
        initialExamTargets={profile.exam_targets}
        initialLanguage={profile.language}
      />

      <PreferencesForm initialPrefs={prefs} />

      <AccountSection
        email={claims.email ?? null}
        createdAt={profile.created_at}
      />
    </div>
  );
}
