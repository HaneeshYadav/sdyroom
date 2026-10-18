import { ActiveFilters } from "@/components/rooms/active-filters";
import { RoomFilters } from "@/components/rooms/room-filters";
import { RoomResults } from "@/components/rooms/room-results";
import { RoomSearch } from "@/components/rooms/room-search";
import { Button } from "@/components/ui/button";
import {
  discoveryStateOf,
  type DiscoveryState,
} from "@/lib/rooms/discovery-params";
import { getRoomFilterOptions, searchPublicRooms } from "@/lib/rooms/discovery";
import { createClient } from "@/lib/supabase/server";
import {
  roomDiscoverySchema,
  ROOM_LIMIT_DEFAULT,
  type RoomSearchInput,
} from "@/lib/validation/rooms";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const metadata = {
  title: "Public rooms · SdyRoom",
};

// Session-gated page: renders per request instead of a static shell.
export const instant = false;

type RoomsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const EMPTY_SEARCH: RoomSearchInput = {
  q: "",
  subject: null,
  exam_track: null,
  language: null,
  min_members: 0,
  sort: undefined,
  limit: ROOM_LIMIT_DEFAULT,
};

/**
 * Normalises repeated query keys (?q=a&q=b) to a single string before Zod
 * sees them, so validation fails on the value rather than on an internal
 * type error.
 */
function flattenParams(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    flat[key] = Array.isArray(value) ? value[0] : value;
  }
  return flat;
}

function ResultsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="h-40 animate-pulse rounded-lg bg-accent" />
      ))}
    </div>
  );
}

/**
 * Streams the discovery results behind the same shell the visitor already
 * sees. Validation happened in the page above, so an invalid query renders
 * the explained empty list without touching the database.
 */
async function ResultsSection({
  search,
  invalidQuery,
}: {
  search: RoomSearchInput;
  invalidQuery: boolean;
}) {
  const supabase = await createClient();
  const page = invalidQuery
    ? { rooms: [], has_more: false, next_cursor: null }
    : await searchPublicRooms(supabase, search);

  return (
    <RoomResults
      key={JSON.stringify(discoveryStateOf(search))}
      initialRooms={page.rooms}
      initialHasMore={page.has_more}
      initialCursor={page.next_cursor}
      search={search}
    />
  );
}

/**
 * Browse page (PR 17): URL-driven search, filters and sort over public
 * rooms only. Every parameter is validated here before it reaches the RPC;
 * an invalid value renders an explained empty list rather than guessing at
 * the visitor's intent, and the same URL always reproduces the same state.
 */
export default async function RoomsPage({ searchParams }: RoomsPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    redirect("/auth/login");
  }

  const parsedSearch = roomDiscoverySchema.safeParse(
    flattenParams(await searchParams),
  );
  const search = parsedSearch.success ? parsedSearch.data : EMPTY_SEARCH;
  const invalidQuery = !parsedSearch.success;
  const searchError = parsedSearch.success
    ? null
    : (parsedSearch.error.issues[0]?.message ?? "Invalid search.");
  const state: DiscoveryState = discoveryStateOf(search);

  const options = await getRoomFilterOptions(supabase);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Public study rooms</h1>
          <p className="text-sm text-muted-foreground">
            Only public rooms appear here. Private rooms stay unlisted.
          </p>
        </div>
        <Button asChild>
          <Link href="/rooms/new">Create a room</Link>
        </Button>
      </header>

      <RoomSearch />

      <RoomFilters state={state} options={options} />

      <ActiveFilters state={state} />

      {searchError && (
        <p className="text-sm text-error" role="alert">
          {searchError}
        </p>
      )}

      <Suspense fallback={<ResultsSkeleton />}>
        <ResultsSection search={search} invalidQuery={invalidQuery} />
      </Suspense>
    </section>
  );
}
