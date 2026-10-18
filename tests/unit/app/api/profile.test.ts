import { GET, PATCH, POST } from "@/app/api/profile/route";
import { ProfileError } from "@/lib/profiles/queries";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  getProfile,
  createProfile,
  getProfileSettings,
  updateProfileSettings,
  getNotificationPrefs,
  rpc,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  getProfileSettings: vi.fn(),
  updateProfileSettings: vi.fn(),
  getNotificationPrefs: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));

vi.mock("@/lib/profiles/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/profiles/queries")>()),
  getProfile,
  createProfile,
  getProfileSettings,
  updateProfileSettings,
}));

vi.mock("@/lib/notifications/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/queries")>()),
  getNotificationPrefs,
}));

function postRequest(body: string) {
  return new NextRequest("http://localhost:3000/api/profile", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

function getRequest() {
  return new NextRequest("http://localhost:3000/api/profile", {
    method: "GET",
  });
}

function patchRequest(body: string) {
  return new NextRequest("http://localhost:3000/api/profile", {
    method: "PATCH",
    body,
    headers: { "content-type": "application/json" },
  });
}

const SETTINGS_ROW = {
  id: "user-1",
  alias: "Aarav",
  exam_targets: ["NEET", "JEE"],
  language: "Hinglish",
  created_at: "2026-01-02T03:04:05.000Z",
};

const PREFS = {
  default: "all",
  invite: "all",
  moderation: "all",
  ai: "all",
  resource: "none",
};

const EXPECTED_PROFILE = {
  alias: "Aarav",
  exam_targets: ["NEET", "JEE"],
  language: "Hinglish",
  notification_prefs: PREFS,
  email: "aarav@example.com",
  created_at: "2026-01-02T03:04:05.000Z",
};

describe("POST /api/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } } });
    createClient.mockResolvedValue({ auth: { getClaims } });
    getProfile.mockResolvedValue(null);
    createProfile.mockResolvedValue({ id: "user-1", alias: "examnerd" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await POST(postRequest(JSON.stringify({ alias: "nerd" })));

    expect(response.status).toBe(401);
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON with 400", async () => {
    const response = await POST(postRequest("not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("rejects an invalid alias with 400", async () => {
    const response = await POST(postRequest(JSON.stringify({ alias: "" })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.issues[0].path).toBe("alias");
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("returns the existing profile without inserting when already onboarded", async () => {
    getProfile.mockResolvedValue({ id: "user-1", alias: "examnerd" });

    const response = await POST(
      postRequest(JSON.stringify({ alias: "someone-else" })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: { id: "user-1", alias: "examnerd" },
      created: false,
    });
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("creates the profile for the session user", async () => {
    const response = await POST(postRequest(JSON.stringify({ alias: "  examnerd  " })));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      profile: { id: "user-1", alias: "examnerd" },
      created: true,
    });
    expect(createProfile).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "examnerd",
    );
  });

  it("maps a taken alias onto 409", async () => {
    createProfile.mockRejectedValue(
      new ProfileError(
        "alias_taken",
        "That study alias is already taken. Try another one.",
        409,
      ),
    );

    const response = await POST(postRequest(JSON.stringify({ alias: "examnerd" })));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("alias_taken");
  });

  it("returns 500 when the lookup fails", async () => {
    getProfile.mockRejectedValue(new Error("connection lost"));

    const response = await POST(postRequest(JSON.stringify({ alias: "examnerd" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("returns 500 when the insert fails unexpectedly", async () => {
    createProfile.mockRejectedValue(new Error("boom"));

    const response = await POST(postRequest(JSON.stringify({ alias: "examnerd" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("query_failed");
  });
});

describe("GET /api/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaims.mockResolvedValue({
      data: { claims: { sub: "user-1", email: "aarav@example.com" } },
    });
    rpc.mockResolvedValue({ data: true, error: null });
    createClient.mockResolvedValue({ auth: { getClaims }, rpc });
    getProfileSettings.mockResolvedValue(SETTINGS_ROW);
    getNotificationPrefs.mockResolvedValue(PREFS);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(getProfileSettings).not.toHaveBeenCalled();
  });

  it("returns exactly the documented profile shape for the session's own row", async () => {
    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["profile"]);
    expect(body.profile).toEqual(EXPECTED_PROFILE);
    expect(getProfileSettings).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(JSON.stringify(body)).not.toContain("user-1");
  });

  it("answers 404 not_found when no profile row exists", async () => {
    getProfileSettings.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("answers 500 profile_read_failed when the read fails", async () => {
    getProfileSettings.mockRejectedValue(new Error("connection lost"));

    const response = await GET(getRequest());

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("profile_read_failed");
  });
});

describe("PATCH /api/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClaims.mockResolvedValue({
      data: { claims: { sub: "user-1", email: "aarav@example.com" } },
    });
    rpc.mockResolvedValue({ data: true, error: null });
    createClient.mockResolvedValue({ auth: { getClaims }, rpc });
    getProfileSettings.mockResolvedValue(SETTINGS_ROW);
    updateProfileSettings.mockResolvedValue(SETTINGS_ROW);
    getNotificationPrefs.mockResolvedValue(PREFS);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects unauthenticated requests with 401", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await PATCH(patchRequest(JSON.stringify({ alias: "x" })));

    expect(response.status).toBe(401);
    expect(updateProfileSettings).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON with 400", async () => {
    const response = await PATCH(patchRequest("not json"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(updateProfileSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty object with 400 invalid_request (goal-PATCH rule)", async () => {
    const response = await PATCH(patchRequest("{}"));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
    expect(updateProfileSettings).not.toHaveBeenCalled();
  });

  it("rejects every protected field with 400 validation, naming the offender", async () => {
    for (const payload of [
      { email: "attacker@example.com" },
      { user_id: "someone-else" },
      { id: "00000000-0000-0000-0000-000000000000" },
      { created_at: "2020-01-01T00:00:00Z" },
      { alias: "sneaky", updated_at: "2020-01-01T00:00:00Z" },
    ]) {
      const response = await PATCH(patchRequest(JSON.stringify(payload)));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe("validation");
      expect(body.error.issues.length).toBeGreaterThan(0);
    }
    expect(updateProfileSettings).not.toHaveBeenCalled();
  });

  it("rejects out-of-vocabulary targets and language with 400", async () => {
    for (const payload of [
      { exam_targets: ["anything"] },
      { language: "Klingon" },
      { exam_targets: ["NEET", "JEE", "UPSC", "SSC"] },
      { alias: "x".repeat(33) },
    ]) {
      const response = await PATCH(patchRequest(JSON.stringify(payload)));

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("validation");
    }
    expect(updateProfileSettings).not.toHaveBeenCalled();
  });

  it("applies a partial alias update and returns the full documented shape", async () => {
    const response = await PATCH(
      patchRequest(JSON.stringify({ alias: "  NewName  " })),
    );

    expect(response.status).toBe(200);
    expect(updateProfileSettings).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { alias: "NewName" },
    );
    const body = await response.json();
    expect(Object.keys(body.profile).sort()).toEqual([
      "alias",
      "created_at",
      "email",
      "exam_targets",
      "language",
      "notification_prefs",
    ]);
    expect(body.profile.email).toBe("aarav@example.com");
    expect(rpc).toHaveBeenCalledWith(
      "rate_limit_take",
      expect.objectContaining({ p_key: "profile:user-1" }),
    );
  });

  it("clears the language when null is sent", async () => {
    const response = await PATCH(patchRequest(JSON.stringify({ language: null })));

    expect(response.status).toBe(200);
    expect(updateProfileSettings).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { language: null },
    );
  });

  it("maps a case-insensitive alias collision onto 409", async () => {
    updateProfileSettings.mockRejectedValue(
      new ProfileError(
        "alias_taken",
        "That study alias is already taken. Try another one.",
        409,
      ),
    );

    const response = await PATCH(
      patchRequest(JSON.stringify({ alias: "TakenAlias" })),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("alias_taken");
  });

  it("maps an absent profile row onto 404", async () => {
    updateProfileSettings.mockRejectedValue(
      new ProfileError("not_found", "Your profile could not be found.", 404),
    );

    const response = await PATCH(
      patchRequest(JSON.stringify({ alias: "Nope" })),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("answers 429 with Retry-After once the profile window is spent", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    const response = await PATCH(
      patchRequest(JSON.stringify({ alias: "SpamName" })),
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("rate_limited");
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(updateProfileSettings).not.toHaveBeenCalled();
  });

  it("answers 500 profile_update_failed when the update fails unexpectedly", async () => {
    updateProfileSettings.mockRejectedValue(new Error("boom"));

    const response = await PATCH(patchRequest(JSON.stringify({ alias: "x" })));

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("profile_update_failed");
  });
});
