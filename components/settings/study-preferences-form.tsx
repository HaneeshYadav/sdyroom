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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  EXAM_TRACKS,
  EXAM_TRACK_MAX_SELECTIONS,
} from "@/lib/vocab/exam-tracks";
import { LANGUAGES } from "@/lib/vocab/languages";

type PatchResponse = {
  profile?: { exam_targets?: string[]; language?: string | null };
  error?: { message?: string };
};

/**
 * Exam targets + preferred language, submitted as one `PATCH /api/profile`
 * (the spec's recommended split: alias gets its own form so each section's
 * errors stay local).
 *
 * The multi-select is a `<fieldset>` of checkboxes — not a bare multi-select
 * — so each option is a real, focusable, screen-reader-announced control
 * with its own label. Options come from the shared closed vocabulary that
 * the room-create form also renders, so the two surfaces cannot drift.
 *
 * Out-of-vocabulary values that somehow reached the column (only possible
 * via a hand-crafted PostgREST call; nothing in the app writes them) are
 * dropped from the form rather than rendered as unselectable ghosts — the
 * next save normalises the row back onto the vocabulary.
 */
export function StudyPreferencesForm({
  initialExamTargets,
  initialLanguage,
}: {
  initialExamTargets: string[];
  initialLanguage: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(() =>
    initialExamTargets.filter((target) =>
      (EXAM_TRACKS as readonly string[]).includes(target),
    ),
  );
  const [language, setLanguage] = useState(initialLanguage ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggle = (track: string, checked: boolean) => {
    setSelected((current) =>
      checked
        ? [...current, track]
        : current.filter((value) => value !== track),
    );
    setSaved(false);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    if (selected.length > EXAM_TRACK_MAX_SELECTIONS) {
      setError(
        `Choose up to ${EXAM_TRACK_MAX_SELECTIONS} exam targets.`,
      );
      setSaving(false);
      return;
    }

    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exam_targets: selected,
          language: language === "" ? null : language,
        }),
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
            "Your preferences could not be saved. Please try again.",
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
        <CardTitle as="h2">Exam targets and language</CardTitle>
        <CardDescription>
          What you are studying for, and the language you would rather study
          in. Both shape how rooms are suggested to you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Exam targets</legend>
            <p className="text-xs text-muted-foreground">
              Choose up to {EXAM_TRACK_MAX_SELECTIONS}. Leave all unchecked
              for none.
            </p>
            <div className="flex flex-col gap-2">
              {EXAM_TRACKS.map((track) => (
                <div key={track} className="flex items-center gap-2">
                  <Checkbox
                    id={`settings-target-${track.toLowerCase()}`}
                    checked={selected.includes(track)}
                    disabled={saving}
                    onCheckedChange={(checked) =>
                      toggle(track, checked === true)
                    }
                  />
                  <Label htmlFor={`settings-target-${track.toLowerCase()}`}>
                    {track}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor="settings-language">Preferred language</Label>
            <Select
              id="settings-language"
              name="language"
              value={language}
              disabled={saving}
              onChange={(event) => {
                setLanguage(event.target.value);
                setSaved(false);
              }}
            >
              <option value="">No preference</option>
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </Select>
          </div>

          {error && (
            <p className="text-sm text-error" role="alert">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="text-sm text-muted-foreground" role="status">
              Exam targets and language saved.
            </p>
          )}

          <div>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save study details"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
