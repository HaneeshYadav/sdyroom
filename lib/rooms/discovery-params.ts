import type { RoomSearchInput, RoomSort } from "@/lib/validation/rooms";

/**
 * The URL-relevant slice of a discovery search (PR 17): everything that
 * survives a reload, a share and the back button. `limit` and `cursor` are
 * deliberately absent — page size and position are per-session, not part of
 * a shared link.
 */
export type DiscoveryState = {
  q: string;
  subject: string | null;
  exam_track: string | null;
  language: string | null;
  min_members: number;
  sort: RoomSort | null;
};

export function discoveryStateOf(search: RoomSearchInput): DiscoveryState {
  return {
    q: search.q,
    subject: search.subject,
    exam_track: search.exam_track,
    language: search.language,
    min_members: search.min_members,
    sort: search.sort ?? null,
  };
}

/**
 * Serialises state to a query string containing only the non-default values,
 * so `/rooms` and `/rooms?...` stay canonical: the same state always yields
 * the same URL, and default-only state yields an empty string.
 */
export function discoveryQueryString(state: DiscoveryState): string {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.subject) params.set("subject", state.subject);
  if (state.exam_track) params.set("exam_track", state.exam_track);
  if (state.language) params.set("language", state.language);
  if (state.min_members > 0) {
    params.set("min_members", String(state.min_members));
  }
  if (state.sort) params.set("sort", state.sort);
  return params.toString();
}

/** Path + query for a state: `/rooms` when nothing differs from defaults. */
export function discoveryPath(state: DiscoveryState): string {
  const query = discoveryQueryString(state);
  return query ? `/rooms?${query}` : "/rooms";
}

/** True when any filter beyond the plain query is active (drives clear-all). */
export function hasActiveFilters(state: DiscoveryState): boolean {
  return (
    state.subject !== null ||
    state.exam_track !== null ||
    state.language !== null ||
    state.min_members > 0 ||
    state.sort !== null
  );
}

/** Every filter is active or not — the chips row needs both signals. */
export function hasAnyRestriction(state: DiscoveryState): boolean {
  return hasActiveFilters(state) || state.q !== "";
}
