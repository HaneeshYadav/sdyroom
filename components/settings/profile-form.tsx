"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aliasSchema, ALIAS_MAX_LENGTH } from "@/lib/validation/profile";

type PatchResponse = {
  profile?: { alias?: string };
  error?: { message?: string };
};

/**
 * Alias editor: client validation through the shared `aliasSchema` (the same
 * rules the server enforces), then `PATCH /api/profile`. Success lands in a
 * `role="status"` announcement and `router.refresh()` re-renders the server
 * page, so the header's "Hey, {alias}!" and any roster fetched afterwards
 * show the new value without a manual reload.
 */
export function ProfileForm({ initialAlias }: { initialAlias: string }) {
  const router = useRouter();
  const [alias, setAlias] = useState(initialAlias);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const parsed = aliasSchema.safeParse(alias);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your study alias.");
      setSaving(false);
      return;
    }

    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: parsed.data }),
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | PatchResponse
        | null;

      if (!response.ok) {
        setError(
          body?.error?.message ??
            "Your alias could not be saved. Please try again.",
        );
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Profile</CardTitle>
        <CardDescription>
          The study alias every classmate sees in room rosters and chat. It
          must be unique and can be changed here whenever you like.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="settings-alias">Study alias</Label>
            <Input
              id="settings-alias"
              name="alias"
              autoComplete="off"
              maxLength={ALIAS_MAX_LENGTH}
              value={alias}
              onChange={(event) => {
                setAlias(event.target.value);
                setSaved(false);
              }}
              disabled={saving}
            />
            {error && (
              <p className="text-sm text-error" role="alert">
                {error}
              </p>
            )}
            {saved && !error && (
              <p className="text-sm text-muted-foreground" role="status">
                Saved. Classmates will see the new alias in room rosters.
              </p>
            )}
          </div>
          <div>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save alias"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
