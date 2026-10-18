"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  discoveryPath,
  hasAnyRestriction,
  type DiscoveryState,
} from "@/lib/rooms/discovery-params";
import { useRouter } from "next/navigation";

type Chip = {
  key: string;
  label: string;
  /** State with this one restriction removed; null renders no remove button. */
  next: DiscoveryState | null;
};

function chipsOf(state: DiscoveryState): Chip[] {
  const chips: Chip[] = [];
  if (state.q) {
    chips.push({
      key: "q",
      label: `Search: ${state.q}`,
      next: { ...state, q: "" },
    });
  }
  if (state.subject) {
    chips.push({
      key: "subject",
      label: `Subject: ${state.subject}`,
      next: { ...state, subject: null },
    });
  }
  if (state.exam_track) {
    chips.push({
      key: "exam_track",
      label: `Exam: ${state.exam_track}`,
      next: { ...state, exam_track: null },
    });
  }
  if (state.language) {
    chips.push({
      key: "language",
      label: `Language: ${state.language}`,
      next: { ...state, language: null },
    });
  }
  if (state.min_members > 0) {
    chips.push({
      key: "min_members",
      label: `${state.min_members}+ members`,
      next: { ...state, min_members: 0 },
    });
  }
  if (state.sort) {
    chips.push({
      key: "sort",
      label: `Sorted by ${state.sort}`,
      next: { ...state, sort: null },
    });
  }
  return chips;
}

/**
 * Visible active restrictions with per-chip removal and one Clear all that
 * resets the whole search (query included) back to `/rooms` (PR 17). Each
 * chip is a labelled button pair — the text and the remove × — so screen
 * reader users hear what a chip is before activating it, and the row only
 * renders when something is actually restricted.
 */
export function ActiveFilters({ state }: { state: DiscoveryState }) {
  const router = useRouter();
  if (!hasAnyRestriction(state)) {
    return null;
  }

  const chips = chipsOf(state);

  const remove = (next: DiscoveryState) => {
    router.replace(discoveryPath(next), { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Active:</span>
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="secondary"
          className="flex items-center gap-1 pr-1"
        >
          <span>{chip.label}</span>
          {chip.next && (
            <button
              type="button"
              aria-label={`Remove filter ${chip.label}`}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => remove(chip.next as DiscoveryState)}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </Badge>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => remove({ q: "", subject: null, exam_track: null, language: null, min_members: 0, sort: null })}
      >
        Clear all
      </Button>
    </div>
  );
}
