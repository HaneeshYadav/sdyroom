"use client";

import { Label } from "@/components/ui/label";
import {
  discoveryPath,
  type DiscoveryState,
} from "@/lib/rooms/discovery-params";
import type { RoomFilterOptions } from "@/lib/rooms/discovery";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Best match" },
  { value: "recent", label: "Newest" },
  { value: "active", label: "Most active" },
  { value: "largest", label: "Largest" },
  { value: "name", label: "Name A–Z" },
];

const MIN_MEMBER_OPTIONS = [
  { value: "0", label: "Any size" },
  { value: "1", label: "1+ members" },
  { value: "2", label: "2+ members" },
  { value: "5", label: "5+ members" },
  { value: "10", label: "10+ members" },
];

type RoomFiltersProps = {
  state: DiscoveryState;
  options: RoomFilterOptions;
  className?: string;
};

function selectClass() {
  return cn(
    "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    `data-[active=true]:font-medium`,
  );
}

/**
 * Filter controls for discovery (PR 17): a labelled fieldset of native
 * selects that write to the URL via `router.replace(..., { scroll: false })`,
 * so every state is shareable, reload-safe and back-button safe. The empty
 * sort option means "best match" — relevance for a query, newest otherwise —
 * which is exactly what the API resolves when `sort` is absent.
 */
export function RoomFilters({ state, options, className }: RoomFiltersProps) {
  const router = useRouter();

  const update = (patch: Partial<DiscoveryState>) => {
    const next = { ...state, ...patch };
    router.replace(discoveryPath(next), { scroll: false });
  };

  return (
    <form
      role="group"
      aria-label="Room filters"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => event.preventDefault()}
    >
      <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="sr-only">Filter public rooms</legend>

        <div className="grid gap-2">
          <Label htmlFor="filter-subject">Subject</Label>
          <select
            id="filter-subject"
            data-active={state.subject !== null}
            className={selectClass()}
            value={state.subject ?? ""}
            onChange={(event) =>
              update({ subject: event.target.value || null })
            }
          >
            <option value="">Any subject</option>
            {options.subjects.map((subject) => (
              <option key={subject} value={subject}>
                {subject}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="filter-exam-track">Exam</Label>
          <select
            id="filter-exam-track"
            data-active={state.exam_track !== null}
            className={selectClass()}
            value={state.exam_track ?? ""}
            onChange={(event) =>
              update({ exam_track: event.target.value || null })
            }
          >
            <option value="">Any exam</option>
            {options.exam_tracks.map((track) => (
              <option key={track} value={track}>
                {track}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="filter-language">Language</Label>
          <select
            id="filter-language"
            data-active={state.language !== null}
            className={selectClass()}
            value={state.language ?? ""}
            onChange={(event) =>
              update({ language: event.target.value || null })
            }
          >
            <option value="">Any language</option>
            {options.languages.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="filter-min-members">Minimum members</Label>
          <select
            id="filter-min-members"
            data-active={state.min_members > 0}
            className={selectClass()}
            value={String(state.min_members)}
            onChange={(event) =>
              update({ min_members: Number(event.target.value) })
            }
          >
            {MIN_MEMBER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="filter-sort">Sort by</Label>
          <select
            id="filter-sort"
            data-active={state.sort !== null}
            className={selectClass()}
            value={state.sort ?? ""}
            onChange={(event) =>
              update({
                sort: (event.target.value || null) as DiscoveryState["sort"],
              })
            }
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
    </form>
  );
}
