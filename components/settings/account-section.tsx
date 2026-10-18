import { LogoutButton } from "@/components/logout-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Account facts: the session's email (read-only — there is no email column
 * on `profiles` and no in-app flow to change it; Supabase Auth owns email
 * and password changes, so the copy points there rather than at a control
 * we would only have to build twice), the join date, and the existing
 * sign-out control (the repo's auth helper, which clears the session and
 * lands on the sign-in route the proxy then guards).
 */
export function AccountSection({
  email,
  createdAt,
}: {
  email: string | null;
  createdAt: string;
}) {
  return (
    // A labelled region, not a bare card: the header renders its own sign-out
    // control too, so "the Account section's Logout button" has to be a
    // queryable thing in its own right (the inbox's regions are the same
    // pattern).
    <section aria-labelledby="settings-account-heading">
      <Card>
        <CardHeader>
          <CardTitle as="h2" id="settings-account-heading">
            Account
          </CardTitle>
          <CardDescription>
            Your sign-in details. Email and password changes are handled by
            Supabase Auth — this app never edits them.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="settings-email">Email</Label>
            <Input
              id="settings-email"
              name="email"
              type="email"
              readOnly
              value={email ?? ""}
              aria-describedby="settings-email-note"
            />
            <p
              id="settings-email-note"
              className="text-xs text-muted-foreground"
            >
              To change your email address, use the confirmation link Supabase
              Auth sent when you signed up — or contact support. SdyRoom shows
              the address but never edits it.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="settings-created">Member since</Label>
            {/* Fixed UTC date, never toLocaleDateString: the server and the
                browser must agree or hydration mismatches on every render. */}
            <Input
              id="settings-created"
              name="created_at"
              readOnly
              value={createdAt.slice(0, 10)}
            />
          </div>

          <div className="flex items-center gap-3">
            <LogoutButton />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
