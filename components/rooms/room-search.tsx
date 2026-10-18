"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  discoveryPath,
  type DiscoveryState,
} from "@/lib/rooms/discovery-params";
import { ROOM_QUERY_MAX, ROOM_SORTS, type RoomSort } from "@/lib/validation/rooms";
import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const DEBOUNCE_MS = 300;

/**
 * Reads the non-query filters straight from the URL so a search keeps them:
 * back/forward, shared links and reloads all round-trip through here. Values
 * the schema would reject (an unknown sort, a junk min_members) degrade to
 * their default instead of being echoed back into the URL.
 */
function stateFromParams(params: URLSearchParams): DiscoveryState {
  const rawSort = params.get("sort");
  const sort = ROOM_SORTS.includes(rawSort as RoomSort)
    ? (rawSort as RoomSort)
    : null;
  const rawMin = Number(params.get("min_members") ?? 0);
  const min_members =
    Number.isFinite(rawMin) && rawMin > 0 && rawMin <= 100 ? rawMin : 0;
  return {
    q: "",
    subject: params.get("subject"),
    exam_track: params.get("exam_track"),
    language: params.get("language"),
    min_members,
    sort,
  };
}

/**
 * Debounced search box bound to the URL (PR 17). Typing waits 300ms, then
 * replaces `?q=` with `scroll: false` so the list updates in place; the
 * Search button flushes the same update immediately for keyboard users, and
 * Clear resets only the query (filters stay). External URL changes — back
 * button, a shared link — flow back into the field without remounting it, so
 * focus and caret survive typing.
 */
export function RoomSearch({ className }: { className?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const activeQ = searchParams.get("q") ?? "";
  const [value, setValue] = useState(activeQ);
  const appliedRef = useRef(activeQ);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The URL is the source of truth: sync the field when it changes without
  // us (back/forward, link). Changes we caused are already in `value`.
  useEffect(() => {
    if (activeQ !== appliedRef.current && activeQ !== value.trim()) {
      setValue(activeQ);
      appliedRef.current = activeQ;
    }
    // `value` intentionally omitted: only external changes matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQ]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const apply = (raw: string) => {
    const next = raw.trim();
    if (next === appliedRef.current) return;
    appliedRef.current = next;
    const state = { ...stateFromParams(searchParams), q: next };
    router.replace(discoveryPath(state), { scroll: false });
  };

  const schedule = (raw: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => apply(raw), DEBOUNCE_MS);
  };

  const submitNow = (raw: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    apply(raw);
  };

  return (
    <form
      role="search"
      className={cn("flex w-full flex-col gap-2 sm:flex-row sm:items-end", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submitNow(value);
      }}
    >
      <div className="grid flex-1 gap-2">
        <Label htmlFor="room-search">Search public rooms</Label>
        <Input
          id="room-search"
          name="q"
          type="search"
          placeholder="Name, subject or exam track"
          maxLength={ROOM_QUERY_MAX}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            schedule(event.target.value);
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" className="flex-1 sm:flex-none">
          Search
        </Button>
        {activeQ && (
          <Button
            type="button"
            variant="outline"
            className="flex-1 sm:flex-none"
            onClick={() => {
              setValue("");
              if (timerRef.current) clearTimeout(timerRef.current);
              apply("");
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </form>
  );
}
