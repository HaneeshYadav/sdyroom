import { POST as generatePOST } from "@/app/api/rooms/[id]/generate/route";
import { POST as stepPOST } from "@/app/api/rooms/[id]/generate/[artifactId]/step/route";
import { GET as artifactsGET } from "@/app/api/rooms/[id]/artifacts/route";
import {
  DELETE as artifactDELETE,
  GET as artifactGET,
} from "@/app/api/rooms/[id]/artifacts/[artifactId]/route";
import {
  GET as attemptsGET,
  POST as attemptsPOST,
} from "@/app/api/rooms/[id]/quizzes/[artifactId]/attempts/route";
import { POST as reviewPOST } from "@/app/api/rooms/[id]/decks/[artifactId]/review/route";
import { GET as dueGET } from "@/app/api/rooms/[id]/decks/[artifactId]/due/route";
import {
  GenerateError,
  type ArtifactDetail,
  type ArtifactSummary,
  type Attempt,
  type CreatedArtifact,
  type DueCardsResult,
  type GenerationStepResult,
  type ReviewResult,
} from "@/lib/ai/generate";
import { GENERATE_LIMIT } from "@/lib/rate-limit/keys";
import { RoomAccessError } from "@/lib/rooms/access";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  getClaims,
  rateLimitedResponse,
  requireRoomMembership,
  createArtifact,
  runGenerationStep,
  listArtifacts,
  getArtifact,
  deleteArtifact,
  recordQuizAttempt,
  listQuizAttempts,
  reviewFlashcard,
  listDueCards,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClaims: vi.fn(),
  rateLimitedResponse: vi.fn(),
  requireRoomMembership: vi.fn(),
  createArtifact: vi.fn(),
  runGenerationStep: vi.fn(),
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  recordQuizAttempt: vi.fn(),
  listQuizAttempts: vi.fn(),
  reviewFlashcard: vi.fn(),
  listDueCards: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/rate-limit/check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/check")>()),
  rateLimitedResponse,
}));
vi.mock("@/lib/rooms/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rooms/access")>()),
  requireRoomMembership,
}));
vi.mock("@/lib/ai/generate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/generate")>()),
  createArtifact,
  runGenerationStep,
  listArtifacts,
  getArtifact,
  deleteArtifact,
  recordQuizAttempt,
  listQuizAttempts,
  reviewFlashcard,
  listDueCards,
}));

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOM = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = "22222222-2222-4222-8222-222222222222";

function jsonRequest(
  path: string,
  options: { method?: string; body?: string } = {},
): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: options.method ?? "POST",
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function context(id = ROOM, artifactId = ARTIFACT) {
  return { params: Promise.resolve({ id, artifactId }) };
}

function roomContext(id = ROOM) {
  return { params: Promise.resolve({ id }) };
}

function summary(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id: ARTIFACT,
    room_id: ROOM,
    creator_id: USER,
    kind: "quiz",
    status: "ready",
    error_code: null,
    difficulty: "medium",
    question_count: 5,
    card_count: null,
    created_at: "2026-01-15T12:00:00.000Z",
    href: `/rooms/${ROOM}/quizzes/${ARTIFACT}`,
    is_creator: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { sub: USER } } });
  rateLimitedResponse.mockResolvedValue(null);
  requireRoomMembership.mockResolvedValue(undefined);
  createClient.mockResolvedValue({ auth: { getClaims } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/rooms/[id]/generate", () => {
  const validBody = JSON.stringify({
    mode: "quiz",
    count: 5,
    difficulty: "medium",
  });

  it("creates an artifact and answers 201", async () => {
    const created: CreatedArtifact = {
      id: ARTIFACT,
      kind: "quiz",
      status: "generating",
      href: `/rooms/${ROOM}/quizzes/${ARTIFACT}`,
    };
    createArtifact.mockResolvedValue(created);

    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, { body: validBody }),
      roomContext(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ artifact: created });
    expect(createArtifact).toHaveBeenCalledWith(expect.anything(), {
      roomId: ROOM,
      kind: "quiz",
      difficulty: "medium",
      count: 5,
      resourceIds: undefined,
    });
  });

  it("maps the flashcards alias to the deck kind", async () => {
    createArtifact.mockResolvedValue({
      id: ARTIFACT,
      kind: "deck",
      status: "generating",
      href: `/rooms/${ROOM}/decks/${ARTIFACT}`,
    });
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, {
        body: JSON.stringify({ mode: "flashcards", count: 10, difficulty: "easy" }),
      }),
      roomContext(),
    );
    expect(response.status).toBe(201);
    expect(createArtifact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "deck", count: 10 }),
    );
  });

  it("rejects an unauthenticated caller before anything else", async () => {
    getClaims.mockResolvedValue({ data: { claims: null } });
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, { body: validBody }),
      roomContext(),
    );
    expect(response.status).toBe(401);
    expect(requireRoomMembership).not.toHaveBeenCalled();
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it("rejects a malformed room id", async () => {
    const response = await generatePOST(
      jsonRequest(`/api/rooms/nope/generate`, { body: validBody }),
      roomContext("nope"),
    );
    expect(response.status).toBe(400);
  });

  it("answers 404 for a non-member", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, { body: validBody }),
      roomContext(),
    );
    expect(response.status).toBe(404);
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it("rate limits before reading the body", async () => {
    rateLimitedResponse.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }),
        { status: 429 },
      ),
    );
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, { body: validBody }),
      roomContext(),
    );
    expect(response.status).toBe(429);
    expect(rateLimitedResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        key: `generate:${ROOM}:${USER}`,
        max: GENERATE_LIMIT.max,
      }),
    );
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies with the validation envelope", async () => {
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, {
        body: JSON.stringify({ mode: "quiz", count: 7, difficulty: "medium" }),
      }),
      roomContext(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("validation");
  });

  it("rejects malformed JSON", async () => {
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, { body: "{nope" }),
      roomContext(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("maps GenerateError codes to their statuses", async () => {
    createArtifact.mockRejectedValue(
      new GenerateError(
        "no_documents_indexed",
        "Index at least one document before generating.",
        409,
      ),
    );
    const response = await generatePOST(
      jsonRequest(`/api/rooms/${ROOM}/generate`, { body: validBody }),
      roomContext(),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("no_documents_indexed");
  });
});

describe("POST /api/rooms/[id]/generate/[artifactId]/step", () => {
  const stepResult: GenerationStepResult = {
    status: "ready",
    id: ARTIFACT,
    question_count: 5,
    card_count: null,
    model: "mock-chat-1",
    provider: "mock",
    deduped: false,
  };

  it("runs the bounded step and answers 200", async () => {
    runGenerationStep.mockResolvedValue(stepResult);
    const response = await stepPOST(
      jsonRequest(`/api/rooms/${ROOM}/generate/${ARTIFACT}/step`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stepResult);
  });

  it("rejects a malformed artifact id", async () => {
    const response = await stepPOST(
      jsonRequest(`/api/rooms/${ROOM}/generate/nope/step`),
      context(ROOM, "nope"),
    );
    expect(response.status).toBe(400);
  });

  it("answers 404 for a non-member before the step", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const response = await stepPOST(
      jsonRequest(`/api/rooms/${ROOM}/generate/${ARTIFACT}/step`),
      context(),
    );
    expect(response.status).toBe(404);
    expect(runGenerationStep).not.toHaveBeenCalled();
  });

  it("maps not_creator to 403", async () => {
    runGenerationStep.mockRejectedValue(
      new GenerateError("not_creator", "Only the creator.", 403),
    );
    const response = await stepPOST(
      jsonRequest(`/api/rooms/${ROOM}/generate/${ARTIFACT}/step`),
      context(),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("not_creator");
  });

  it("maps malformed provider output to 502", async () => {
    runGenerationStep.mockRejectedValue(
      new GenerateError("generate_failed", "malformed provider output", 502),
    );
    const response = await stepPOST(
      jsonRequest(`/api/rooms/${ROOM}/generate/${ARTIFACT}/step`),
      context(),
    );
    expect(response.status).toBe(502);
  });

  it("answers 500 on unexpected failures without leaking details", async () => {
    runGenerationStep.mockRejectedValue(new Error("boom: secret detail"));
    const response = await stepPOST(
      jsonRequest(`/api/rooms/${ROOM}/generate/${ARTIFACT}/step`),
      context(),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("generate_failed");
    expect(JSON.stringify(body)).not.toContain("secret detail");
  });
});

describe("GET /api/rooms/[id]/artifacts", () => {
  it("lists artifacts for a member", async () => {
    listArtifacts.mockResolvedValue([summary()]);
    const response = await artifactsGET(
      jsonRequest(`/api/rooms/${ROOM}/artifacts`, { method: "GET" }),
      roomContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.has_more).toBe(false);
  });

  it("passes the kind filter through", async () => {
    listArtifacts.mockResolvedValue([]);
    await artifactsGET(
      jsonRequest(`/api/rooms/${ROOM}/artifacts?kind=deck`, { method: "GET" }),
      roomContext(),
    );
    expect(listArtifacts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "deck" }),
    );
  });

  it("rejects a bad kind filter", async () => {
    const response = await artifactsGET(
      jsonRequest(`/api/rooms/${ROOM}/artifacts?kind=essay`, { method: "GET" }),
      roomContext(),
    );
    expect(response.status).toBe(400);
  });

  it("answers 404 for a non-member", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const response = await artifactsGET(
      jsonRequest(`/api/rooms/${ROOM}/artifacts`, { method: "GET" }),
      roomContext(),
    );
    expect(response.status).toBe(404);
    expect(listArtifacts).not.toHaveBeenCalled();
  });
});

describe("GET/DELETE /api/rooms/[id]/artifacts/[artifactId]", () => {
  const detail: ArtifactDetail = {
    ...summary(),
    payload: null,
    model: null,
    resource_ids: [],
  };

  it("returns the full artifact", async () => {
    getArtifact.mockResolvedValue(detail);
    const response = await artifactGET(
      jsonRequest(`/api/rooms/${ROOM}/artifacts/${ARTIFACT}`, { method: "GET" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).artifact.id).toBe(ARTIFACT);
  });

  it("answers 404 when the artifact is invisible", async () => {
    getArtifact.mockRejectedValue(
      new GenerateError("not_found", "Not available.", 404),
    );
    const response = await artifactGET(
      jsonRequest(`/api/rooms/${ROOM}/artifacts/${ARTIFACT}`, { method: "GET" }),
      context(),
    );
    expect(response.status).toBe(404);
  });

  it("deletes as the creator", async () => {
    deleteArtifact.mockResolvedValue(undefined);
    const response = await artifactDELETE(
      jsonRequest(`/api/rooms/${ROOM}/artifacts/${ARTIFACT}`, { method: "DELETE" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it("maps not_creator on delete to 403", async () => {
    deleteArtifact.mockRejectedValue(
      new GenerateError("not_creator", "Only the creator.", 403),
    );
    const response = await artifactDELETE(
      jsonRequest(`/api/rooms/${ROOM}/artifacts/${ARTIFACT}`, { method: "DELETE" }),
      context(),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST/GET /api/rooms/[id]/quizzes/[artifactId]/attempts", () => {
  const attempt: Attempt = {
    id: "33333333-3333-4333-8333-333333333333",
    score: 4,
    total: 5,
    correct: [true, true, true, false, true],
    results: [],
    duration_ms: 12_000,
    created_at: "2026-01-15T12:01:00.000Z",
  };

  it("records an attempt with the server's score", async () => {
    recordQuizAttempt.mockResolvedValue(attempt);
    const response = await attemptsPOST(
      jsonRequest(`/api/rooms/${ROOM}/quizzes/${ARTIFACT}/attempts`, {
        body: JSON.stringify({ answers: [0, 1, 2, 3, 0], duration_ms: 12_000 }),
      }),
      context(),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ attempt });
    expect(recordQuizAttempt).toHaveBeenCalledWith(
      expect.anything(),
      {
        roomId: ROOM,
        artifactId: ARTIFACT,
        answers: [0, 1, 2, 3, 0],
        durationMs: 12_000,
      },
    );
  });

  it("rejects a forged score field via the strict schema", async () => {
    const response = await attemptsPOST(
      jsonRequest(`/api/rooms/${ROOM}/quizzes/${ARTIFACT}/attempts`, {
        body: JSON.stringify({ answers: [0], score: 999 }),
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(recordQuizAttempt).not.toHaveBeenCalled();
  });

  it("maps artifact_not_ready to 409", async () => {
    recordQuizAttempt.mockRejectedValue(
      new GenerateError("artifact_not_ready", "Not ready.", 409),
    );
    const response = await attemptsPOST(
      jsonRequest(`/api/rooms/${ROOM}/quizzes/${ARTIFACT}/attempts`, {
        body: JSON.stringify({ answers: [0] }),
      }),
      context(),
    );
    expect(response.status).toBe(409);
  });

  it("lists only the caller's own attempts", async () => {
    listQuizAttempts.mockResolvedValue([attempt]);
    const response = await attemptsGET(
      jsonRequest(`/api/rooms/${ROOM}/quizzes/${ARTIFACT}/attempts`, {
        method: "GET",
      }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attempts: [attempt] });
    expect(listQuizAttempts).toHaveBeenCalledWith(
      expect.anything(),
      { artifactId: ARTIFACT },
    );
  });
});

describe("POST /api/rooms/[id]/decks/[artifactId]/review", () => {
  const result: ReviewResult = {
    next_review_at: "2026-01-18T12:00:00.000Z",
    interval_days: 3,
    streak: 2,
    due_count: 7,
  };

  it("grades a card and returns the schedule", async () => {
    reviewFlashcard.mockResolvedValue(result);
    const response = await reviewPOST(
      jsonRequest(`/api/rooms/${ROOM}/decks/${ARTIFACT}/review`, {
        body: JSON.stringify({ card_ordinal: 0, grade: "got_it" }),
      }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });

  it("rejects an invalid grade", async () => {
    const response = await reviewPOST(
      jsonRequest(`/api/rooms/${ROOM}/decks/${ARTIFACT}/review`, {
        body: JSON.stringify({ card_ordinal: 0, grade: "maybe" }),
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(reviewFlashcard).not.toHaveBeenCalled();
  });

  it("answers 404 for a non-member", async () => {
    requireRoomMembership.mockRejectedValue(
      new RoomAccessError("That room does not exist or is not available."),
    );
    const response = await reviewPOST(
      jsonRequest(`/api/rooms/${ROOM}/decks/${ARTIFACT}/review`, {
        body: JSON.stringify({ card_ordinal: 0, grade: "again" }),
      }),
      context(),
    );
    expect(response.status).toBe(404);
    expect(reviewFlashcard).not.toHaveBeenCalled();
  });
});

describe("GET /api/rooms/[id]/decks/[artifactId]/due", () => {
  it("returns the caller's due state", async () => {
    const due: DueCardsResult = {
      cards: [
        {
          ordinal: 0,
          front: "Front",
          back: "Back",
          citations: [],
          grade: null,
          streak: 0,
          next_review_at: null,
          due: true,
        },
      ],
      due_count: 1,
    };
    listDueCards.mockResolvedValue(due);
    const response = await dueGET(
      jsonRequest(`/api/rooms/${ROOM}/decks/${ARTIFACT}/due`, { method: "GET" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(due);
    expect(listDueCards).toHaveBeenCalledWith(
      expect.anything(),
      { roomId: ROOM, artifactId: ARTIFACT, viewerId: USER },
    );
  });

  it("maps artifact_not_ready to 409", async () => {
    listDueCards.mockRejectedValue(
      new GenerateError("artifact_not_ready", "Not ready.", 409),
    );
    const response = await dueGET(
      jsonRequest(`/api/rooms/${ROOM}/decks/${ARTIFACT}/due`, { method: "GET" }),
      context(),
    );
    expect(response.status).toBe(409);
  });

  it("rejects a malformed artifact id", async () => {
    const response = await dueGET(
      jsonRequest(`/api/rooms/${ROOM}/decks/nope/due`, { method: "GET" }),
      context(ROOM, "nope"),
    );
    expect(response.status).toBe(400);
  });
});
