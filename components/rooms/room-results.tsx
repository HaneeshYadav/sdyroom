"use client";

import { RoomCard } from "@/components/room-card";
import { Button } from "@/components/ui/button";
import {
  discoveryQueryString,
  discoveryStateOf,
} from "@/lib/rooms/discovery-params";
import type { RoomSummary } from "@/lib/rooms/types";
import type { RoomSearchInput } from "@/lib/validation/rooms";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RoomResultsProps = {
  initialRooms: RoomSummary[];
  initialHasMore: boolean;
  initialCursor: string | null;
  search: RoomSearchInput;
};

type LoadState = {
  loading: boolean;
  error: string | null;
};

function countLine(count: number, q: string, hasMore: boolean): string {
  const noun = count === 1 ? "room" : "rooms";
  const query = q ? ` matching “${q}”` : "";
  const suffix = hasMore ? " — more available" : " — public rooms only";
  return `${count} ${noun}${query}${suffix}`;
}

/**
 * Discovery results (PR 17): the server renders the first page, this client
 * boundary appends further pages through `GET /api/rooms` with the keyset
 * cursor — no window scroll tricks, one explicit "Load more" action per page.
 * The first page always comes from props, so a `router.refresh()` (join /
 * leave) re-renders it with the membership the server now sees; only the
 * loaded extra pages live in state and they reset whenever that first page
 * changes, keeping the list the database would return. Load failures keep
 * what is already on screen and offer a retry; they never masquerade as an
 * empty result.
 */
export function RoomResults({
  initialRooms,
  initialHasMore,
  initialCursor,
  search,
}: RoomResultsProps) {
  const router = useRouter();
  const [extraRooms, setExtraRooms] = useState<RoomSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [state, setState] = useState<LoadState>({ loading: false, error: null });

  // Derive from props during render: when the server's first page changes
  // (membership refresh or a new query), drop client-only pages so stale
  // rows never mix with the fresh ones.
  const [synced, setSynced] = useState({
    initialRooms,
    initialCursor,
    initialHasMore,
  });
  if (
    synced.initialRooms !== initialRooms ||
    synced.initialCursor !== initialCursor ||
    synced.initialHasMore !== initialHasMore
  ) {
    setSynced({ initialRooms, initialCursor, initialHasMore });
    setExtraRooms([]);
    setCursor(initialCursor);
    setHasMore(initialHasMore);
    setState({ loading: false, error: null });
  }

  const rooms = [...initialRooms, ...extraRooms];

  const loadMore = async () => {
    setState({ loading: true, error: null });
    try {
      const params = new URLSearchParams(discoveryQueryString(discoveryStateOf(search)));
      params.set("limit", String(search.limit));
      if (cursor) params.set("cursor", cursor);

      const response = await fetch(`/api/rooms?${params.toString()}`);
      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        rooms?: RoomSummary[];
        has_more?: boolean;
        next_cursor?: string | null;
        error?: { message?: string };
      } | null;

      if (!response.ok || !body) {
        setState({
          loading: false,
          error:
            body?.error?.message ??
            "More rooms could not be loaded. Please try again.",
        });
        return;
      }

      setExtraRooms((previous) => [...previous, ...(body.rooms ?? [])]);
      setHasMore(body.has_more === true);
      setCursor(body.next_cursor ?? null);
      setState({ loading: false, error: null });
    } catch {
      setState({
        loading: false,
        error: "Could not reach the server. Please try again.",
      });
    }
  };

  if (rooms.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-10 text-center">
        <p className="text-sm text-muted-foreground">
          {search.q || search.subject || search.exam_track || search.language || search.min_members > 0
            ? "No public rooms match your search."
            : "No public rooms yet. Create the first one."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {(search.q || search.subject || search.exam_track || search.language || search.min_members > 0 || search.sort) && (
            <Button
              type="button"
              variant="outline"
              onClick={() => router.replace("/rooms", { scroll: false })}
            >
              Clear search
            </Button>
          )}
          <Button asChild>
            <Link href="/rooms/new">Create a room</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground" role="status">
        {countLine(rooms.length, search.q, hasMore)}
      </p>

      <ul className="grid gap-4 sm:grid-cols-2" role="list">
        {rooms.map((room) => (
          <li key={room.id}>
            <RoomCard room={room} />
          </li>
        ))}
      </ul>

      {state.error && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-error" role="alert">
            {state.error}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={state.loading}
            onClick={() => void loadMore()}
          >
            Retry
          </Button>
        </div>
      )}

      {hasMore && !state.error && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={state.loading}
            onClick={() => void loadMore()}
          >
            {state.loading ? "Loading…" : "Load more rooms"}
          </Button>
        </div>
      )}
    </div>
  );
}
