import {
  discoveryPath,
  discoveryQueryString,
  discoveryStateOf,
  hasActiveFilters,
  hasAnyRestriction,
} from "@/lib/rooms/discovery-params";
import { roomDiscoverySchema } from "@/lib/validation/rooms";
import { describe, expect, it } from "vitest";

const DEFAULT_STATE = {
  q: "",
  subject: null,
  exam_track: null,
  language: null,
  min_members: 0,
  sort: null,
};

describe("discoveryStateOf", () => {
  it("projects a parsed search onto the URL-relevant state", () => {
    const search = roomDiscoverySchema.parse({
      q: "neet",
      subject: "Biology",
      min_members: "2",
      sort: "largest",
      limit: "50",
      cursor: "opaque",
    });

    expect(discoveryStateOf(search)).toEqual({
      q: "neet",
      subject: "Biology",
      exam_track: null,
      language: null,
      min_members: 2,
      sort: "largest",
    });
    expect(discoveryStateOf(search)).not.toHaveProperty("limit");
    expect(discoveryStateOf(search)).not.toHaveProperty("cursor");
  });
});

describe("discoveryQueryString / discoveryPath", () => {
  it("emits nothing for the default state", () => {
    expect(discoveryQueryString(DEFAULT_STATE)).toBe("");
    expect(discoveryPath(DEFAULT_STATE)).toBe("/rooms");
  });

  it("serialises only the non-default values, in a stable order", () => {
    expect(
      discoveryQueryString({
        ...DEFAULT_STATE,
        q: "physics",
        subject: "Physics",
        sort: "active",
      }),
    ).toBe("q=physics&subject=Physics&sort=active");

    expect(
      discoveryPath({ ...DEFAULT_STATE, min_members: 5, exam_track: "JEE" }),
    ).toBe("/rooms?exam_track=JEE&min_members=5");
  });

  it("round-trips through the validation schema", () => {
    const state = {
      q: "neet biology",
      subject: "Biology",
      exam_track: "NEET",
      language: "Hinglish",
      min_members: 2,
      sort: "name" as const,
    };
    const query = discoveryQueryString(state);
    const parsed = roomDiscoverySchema.parse(
      Object.fromEntries(new URLSearchParams(query)),
    );

    expect(discoveryStateOf(parsed)).toEqual(state);
  });

  it("preserves special characters through URL encoding", () => {
    const state = { ...DEFAULT_STATE, q: "100% & more_1" };
    const parsed = roomDiscoverySchema.parse(
      Object.fromEntries(new URLSearchParams(discoveryQueryString(state))),
    );
    expect(parsed.q).toBe("100% & more_1");
  });
});

describe("hasActiveFilters / hasAnyRestriction", () => {
  it("treats only the query as no filter", () => {
    expect(hasActiveFilters(DEFAULT_STATE)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_STATE, q: "physics" })).toBe(false);
    expect(hasAnyRestriction(DEFAULT_STATE)).toBe(false);
  });

  it("flags each non-default restriction", () => {
    expect(hasActiveFilters({ ...DEFAULT_STATE, subject: "Physics" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_STATE, min_members: 1 })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_STATE, sort: "recent" })).toBe(true);
    expect(hasAnyRestriction({ ...DEFAULT_STATE, q: "x" })).toBe(true);
  });
});
