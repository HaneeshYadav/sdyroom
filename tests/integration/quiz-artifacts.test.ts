import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as aiIngestPost } from "@/app/api/ai/ingest/[resourceId]/route";
import { DELETE as artifactDelete } from "@/app/api/rooms/[id]/artifacts/[artifactId]/route";
import { GET as artifactGet } from "@/app/api/rooms/[id]/artifacts/[artifactId]/route";
import { GET as artifactsGet } from "@/app/api/rooms/[id]/artifacts/route";
import { GET as dueGet } from "@/app/api/rooms/[id]/decks/[artifactId]/due/route";
import { POST as reviewPost } from "@/app/api/rooms/[id]/decks/[artifactId]/review/route";
import { POST as generatePost } from "@/app/api/rooms/[id]/generate/route";
import { POST as stepPost } from "@/app/api/rooms/[id]/generate/[artifactId]/step/route";
import { GET as attemptsGet } from "@/app/api/rooms/[id]/quizzes/[artifactId]/attempts/route";
import { POST as attemptsPost } from "@/app/api/rooms/[id]/quizzes/[artifactId]/attempts/route";
import { POST as resourcesPost } from "@/app/api/resources/route";
import { GENERATE_LIMIT } from "@/lib/rate-limit/keys";
import { createProfile } from "@/lib/profiles/queries";
import { createRoom } from "@/lib/rooms/create";
import { createRoomSchema } from "@/lib/validation/rooms";
import { psql } from "./helpers/admin";
import { callApi, callApiWithParams, errorOf, readJson } from "./helpers/api";
import { clearCookies, seedSession } from "./helpers/cookie-jar";
import {
  createUser,
  deleteUsers,
  uniqueAlias,
  uniqueName,
  type TestUser,
} from "./helpers/users";

type Resource = { id: string; title: string };

type ArtifactSummary = {
  id: string;
  room_id: string;
  creator_id: string;
  kind: "quiz" | "deck";
  status: "generating" | "ready" | "failed";
  error_code: string | null;
  difficulty: string;
  question_count: number | null;
  card_count: number | null;
  created_at: string;
  href: string;
  is_creator: boolean;
};

type ArtifactDetail = ArtifactSummary & {
  payload: {
    questions?: Array<{
      type: string;
      prompt: string;
      options: string[];
      correct_index: number;
      explanation: string;
      citations: Array<{ n: number; page?: number }>;
    }>;
    cards?: Array<{
      front: string;
      back: string;
      citations: Array<{ n: number; page?: number }>;
    }>;
    sources: Array<{ n: number; resource_id: string; title: string; href: string }>;
  } | null;
  model: string | null;
  resource_ids: string[];
};

type Attempt = {
  id: string;
  score: number;
  total: number;
  correct: boolean[];
  results: Array<{ ordinal: number; chosen: number | null; correct_index: number }>;
  duration_ms: number | null;
  created_at: string;
};

type DueCardsResult = {
  cards: Array<{
    ordinal: number;
    front: string;
    back: string;
    citations: unknown[];
    grade: "again" | "got_it" | null;
    streak: number;
    next_review_at: string | null;
    due: boolean;
  }>;
  due_count: number;
};

type ReviewResult = {
  next_review_at: string;
  interval_days: number;
  streak: number;
  due_count: number;
};

function textFile(name: string, text: string): File {
  return new File([new TextEncoder().encode(text) as BlobPart], name, {
    type: "text/plain",
  });
}

async function upload(
  user: TestUser,
  fields: Record<string, string>,
  file: File,
): Promise<Resource> {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  await seedSession(user.email, user.password);
  const response = await callApi(resourcesPost, {
    path: "/api/resources",
    method: "POST",
    form,
  });
  expect(response.status).toBe(201);
  const body = await readJson(response);
  return body.resource as Resource;
}

async function driveToReady(user: TestUser, resourceId: string): Promise<void> {
  await seedSession(user.email, user.password);
  for (let index = 0; index < 8; index += 1) {
    const response = await callApiWithParams(
      aiIngestPost,
      { path: `/api/ai/ingest/${resourceId}`, method: "POST" },
      { resourceId },
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    if (body.status === "ready") return;
    expect(body.status).not.toBe("failed");
  }
  throw new Error(`resource ${resourceId} never reached ready`);
}

function generate(
  user: TestUser,
  roomId: string,
  body: unknown,
): Promise<Response> {
  return callApiWithParams(
    generatePost,
    { path: `/api/rooms/${roomId}/generate`, method: "POST", body },
    { id: roomId },
  );
}

async function generateAndDrive(
  user: TestUser,
  roomId: string,
  body: unknown,
): Promise<ArtifactDetail> {
  await seedSession(user.email, user.password);
  const created = await generate(user, roomId, body);
  expect(created.status).toBe(201);
  const { artifact } = (await readJson(created)) as { artifact: { id: string } };
  const stepped = await callApiWithParams(
    stepPost,
    {
      path: `/api/rooms/${roomId}/generate/${artifact.id}/step`,
      method: "POST",
    },
    { id: roomId, artifactId: artifact.id },
  );
  expect(stepped.status).toBe(200);
  const step = await readJson(stepped);
  expect(step.status).toBe("ready");
  const fetched = await callApiWithParams(
    artifactGet,
    { path: `/api/rooms/${roomId}/artifacts/${artifact.id}`, method: "GET" },
    { id: roomId, artifactId: artifact.id },
  );
  expect(fetched.status).toBe(200);
  const detail = (await readJson(fetched)) as { artifact: ArtifactDetail };
  return detail.artifact;
}

async function listArtifacts(
  user: TestUser,
  roomId: string,
  query = "",
): Promise<{ status: number; body: { artifacts: ArtifactSummary[] } }> {
  await seedSession(user.email, user.password);
  const response = await callApiWithParams(
    artifactsGet,
    { path: `/api/rooms/${roomId}/artifacts${query}`, method: "GET" },
    { id: roomId },
  );
  return { status: response.status, body: (await readJson(response)) as { artifacts: ArtifactSummary[] } };
}

async function recordAttempt(
  user: TestUser,
  roomId: string,
  artifactId: string,
  body: unknown,
): Promise<Response> {
  return callApiWithParams(
    attemptsPost,
    {
      path: `/api/rooms/${roomId}/quizzes/${artifactId}/attempts`,
      method: "POST",
      body,
    },
    { id: roomId, artifactId },
  );
}

async function listAttempts(
  user: TestUser,
  roomId: string,
  artifactId: string,
): Promise<{ status: number; body: { attempts: Attempt[] } }> {
  await seedSession(user.email, user.password);
  const response = await callApiWithParams(
    attemptsGet,
    {
      path: `/api/rooms/${roomId}/quizzes/${artifactId}/attempts`,
      method: "GET",
    },
    { id: roomId, artifactId },
  );
  return { status: response.status, body: (await readJson(response)) as { attempts: Attempt[] } };
}

async function due(
  user: TestUser,
  roomId: string,
  artifactId: string,
): Promise<{ status: number; body: DueCardsResult }> {
  await seedSession(user.email, user.password);
  const response = await callApiWithParams(
    dueGet,
    {
      path: `/api/rooms/${roomId}/decks/${artifactId}/due`,
      method: "GET",
    },
    { id: roomId, artifactId },
  );
  return { status: response.status, body: (await readJson(response)) as DueCardsResult };
}

async function review(
  user: TestUser,
  roomId: string,
  artifactId: string,
  body: unknown,
): Promise<Response> {
  return callApiWithParams(
    reviewPost,
    {
      path: `/api/rooms/${roomId}/decks/${artifactId}/review`,
      method: "POST",
      body,
    },
    { id: roomId, artifactId },
  );
}

function clearChatUsage(): void {
  psql(`delete from public.ai_usage where kind = 'chat_tokens';`);
}

function seedChatUsage(userId: string, amount: number): void {
  psql(
    `insert into public.ai_usage (room_id, user_id, kind, amount) ` +
      `values (null, '${userId}', 'chat_tokens', ${amount});`,
  );
}

function clearGenerateRateLimit(): void {
  psql(`delete from public.rate_limits where key like 'generate:%';`);
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

let roomId = "";
let docA = "";
let emptyRoomId = "";

const savedAiEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of ["AI_PROVIDER", "AI_API_KEY"] as const) {
    savedAiEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AI_PROVIDER = "mock";

  [owner, member, outsider] = await Promise.all([
    createUser("quiz-owner"),
    createUser("quiz-member"),
    createUser("quiz-outsider"),
  ]);
  await Promise.all(
    [owner, member, outsider].map((user, index) =>
      createProfile(user.client, user.id, uniqueAlias(`QUIZ${index}`)),
    ),
  );

  roomId = (
    await createRoom(
      owner.client,
      createRoomSchema.parse({ name: uniqueName("Quiz Room"), capacity: 4 }),
    )
  ).id;
  psql(
    `insert into public.room_members (room_id, user_id, role) ` +
      `values ('${roomId}', '${member.id}', 'student');`,
  );

  emptyRoomId = (
    await createRoom(
      member.client,
      createRoomSchema.parse({ name: uniqueName("Quiz Empty Room"), capacity: 2 }),
    )
  ).id;

  const resourceA = await upload(
    owner,
    { title: "Cell biology notes", room_id: roomId },
    textFile(
      "cells.txt",
      "Mitochondria produce ATP through oxidative phosphorylation. The cell membrane " +
        "is selectively permeable and controls what enters and leaves the cell.",
    ),
  );
  docA = resourceA.id;
  await driveToReady(owner, docA);

  const resourceB = await upload(
    member,
    { title: "Genetics notes", room_id: roomId },
    textFile(
      "genetics.txt",
      "DNA polymerase copies the template strand during replication. Mendel's laws " +
        "describe independent assortment and segregation of alleles.",
    ),
  );
  await driveToReady(member, resourceB.id);
});

afterAll(async () => {
  clearChatUsage();
  clearGenerateRateLimit();
  await deleteUsers([owner, member, outsider]);
  clearCookies();
  for (const [key, value] of savedAiEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  clearChatUsage();
  clearGenerateRateLimit();
  clearCookies();
});

describe("study artifact generation", () => {
  it("rejects invalid generate bodies and unknown modes", async () => {
    await seedSession(owner.email, owner.password);
    const bad = await generate(owner, roomId, { mode: "essay", count: 5 });
    expect(bad.status).toBe(400);
    expect(errorOf(await readJson(bad)).code).toBe("validation");

    const badCount = await generate(owner, roomId, { mode: "quiz", count: 7 });
    expect(badCount.status).toBe(400);
  });

  it("answers 404 to an outsider", async () => {
    await seedSession(outsider.email, outsider.password);
    const response = await generate(outsider, roomId, {
      mode: "quiz",
      count: 5,
    });
    expect(response.status).toBe(404);
  });

  it("answers 409 when the room has no indexed documents", async () => {
    await seedSession(member.email, member.password);
    const response = await generate(member, emptyRoomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
    });
    expect(response.status).toBe(409);
    expect(errorOf(await readJson(response)).code).toBe("no_documents_indexed");
  });

  it("answers 403 when the daily chat-token quota is exhausted", async () => {
    seedChatUsage(owner.id, 100_000);
    await seedSession(owner.email, owner.password);
    const response = await generate(owner, roomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
    });
    expect(response.status).toBe(403);
    expect(errorOf(await readJson(response)).code).toBe("ai_quota_exceeded");
  });

  it("rejects forged resource ids without leaking other rooms", async () => {
    await seedSession(owner.email, owner.password);
    // A forged id is indistinguishable from an unindexed one to the caller —
    // both 409 — so the API never confirms whether some other room's resource
    // exists. No artifact row is written in either case.
    const forgedOnly = await generate(owner, roomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
      resource_ids: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
    });
    expect(forgedOnly.status).toBe(409);
    expect(errorOf(await readJson(forgedOnly)).code).toBe("no_documents_indexed");

    const mixed = await generate(owner, roomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
      resource_ids: [docA, "ffffffff-ffff-4fff-8fff-ffffffffffff"],
    });
    expect(mixed.status).toBe(409);
    expect(errorOf(await readJson(mixed)).code).toBe("no_documents_indexed");
  });

  it("generates a quiz whose payload is complete, citable, and server-scored", async () => {
    const artifact = await generateAndDrive(owner, roomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
    });
    expect(artifact.status).toBe("ready");
    expect(artifact.kind).toBe("quiz");
    expect(artifact.question_count).toBe(5);
    expect(artifact.model).toBeTruthy();
    expect(artifact.payload).toBeTruthy();

    const { questions, sources } = artifact.payload!;
    expect(questions).toHaveLength(5);
    expect(sources.length).toBeGreaterThan(0);
    for (const question of questions!) {
      expect(question.prompt.length).toBeGreaterThan(0);
      expect(question.explanation.length).toBeGreaterThan(0);
      expect(question.correct_index).toBeGreaterThanOrEqual(0);
      expect(question.correct_index).toBeLessThan(question.options.length);
      for (const citation of question.citations) {
        expect(citation.n).toBeGreaterThanOrEqual(1);
        expect(citation.n).toBeLessThanOrEqual(sources.length);
      }
    }

    // The mock writes TF at index 0 and every 5th; correct answers are
    // deterministic — score them on the server and check both directions.
    const perfect = await recordAttempt(owner, roomId, artifact.id, {
      answers: [0, 1, 2, 3, 0],
      duration_ms: 21_000,
    });
    expect(perfect.status).toBe(201);
    const attempt = (await readJson(perfect)).attempt as Attempt;
    expect(attempt.score).toBe(5);
    expect(attempt.total).toBe(5);
    expect(attempt.correct).toEqual([true, true, true, true, true]);
    expect(attempt.results[0].correct_index).toBe(0);

    // A forged score field is rejected by the strict schema (not silently
    // accepted and ignored — the envelope must fail).
    const forged = await recordAttempt(owner, roomId, artifact.id, {
      answers: [0, 1, 2, 3, 0],
      score: 5,
    });
    expect(forged.status).toBe(400);

    // Partial answers score only what is actually right.
    const partial = await recordAttempt(owner, roomId, artifact.id, {
      answers: [1, 1, 0, 0, 1],
      duration_ms: 30_000,
    });
    expect(partial.status).toBe(201);
    const partialAttempt = (await readJson(partial)).attempt as Attempt;
    expect(partialAttempt.score).toBe(1);
    expect(partialAttempt.correct).toEqual([false, true, false, false, false]);
  });

  it("scopes attempts to their author", async () => {
    const listed = await listArtifacts(owner, roomId, `?kind=quiz`);
    const artifact = listed.body.artifacts.find((item) => item.is_creator)!;
    expect(artifact).toBeDefined();

    await seedSession(member.email, member.password);
    const memberAttempt = await recordAttempt(member, roomId, artifact.id, {
      // Deliberately all-wrong against the deterministic mock payload.
      answers: [1, 0, 0, 0, 1],
    });
    expect(memberAttempt.status).toBe(201);

    const ownerList = await listAttempts(owner, roomId, artifact.id);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.attempts.length).toBeGreaterThanOrEqual(2);
    expect(ownerList.body.attempts.every((item) => item.score !== 0)).toBe(true);
    const memberList = await listAttempts(member, roomId, artifact.id);
    expect(memberList.body.attempts).toHaveLength(1);
    expect(memberList.body.attempts[0].score).toBe(0);
  });

  it("is creator-scoped for steps and deletes", async () => {
    const listed = await listArtifacts(owner, roomId, `?kind=quiz`);
    const artifact = listed.body.artifacts.find((item) => item.is_creator)!;

    await seedSession(member.email, member.password);
    const step = await callApiWithParams(
      stepPost,
      {
        path: `/api/rooms/${roomId}/generate/${artifact.id}/step`,
        method: "POST",
      },
      { id: roomId, artifactId: artifact.id },
    );
    expect(step.status).toBe(403);
    expect(errorOf(await readJson(step)).code).toBe("not_creator");

    const del = await callApiWithParams(
      artifactDelete,
      {
        path: `/api/rooms/${roomId}/artifacts/${artifact.id}`,
        method: "DELETE",
      },
      { id: roomId, artifactId: artifact.id },
    );
    expect(del.status).toBe(403);
  });

  it("makes a second step on a ready artifact an idempotent no-op", async () => {
    const artifact = await generateAndDrive(member, roomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
    });
    await seedSession(member.email, member.password);
    const again = await callApiWithParams(
      stepPost,
      {
        path: `/api/rooms/${roomId}/generate/${artifact.id}/step`,
        method: "POST",
      },
      { id: roomId, artifactId: artifact.id },
    );
    expect(again.status).toBe(200);
    const body = await readJson(again);
    expect(body.status).toBe("ready");
    expect(body.deduped).toBe(true);
  });

  it("generates a flashcard deck with a working review loop", async () => {
    const artifact = await generateAndDrive(owner, roomId, {
      mode: "flashcards",
      count: 10,
      difficulty: "easy",
    });
    expect(artifact.kind).toBe("deck");
    expect(artifact.card_count).toBe(10);
    expect(artifact.payload!.cards).toHaveLength(10);
    for (const card of artifact.payload!.cards!) {
      expect(card.front.length).toBeGreaterThan(0);
      expect(card.back.length).toBeGreaterThan(0);
    }

    const before = await due(owner, roomId, artifact.id);
    expect(before.status).toBe(200);
    expect(before.body.due_count).toBe(10);
    expect(before.body.cards.every((card) => card.due)).toBe(true);

    await seedSession(owner.email, owner.password);
    const graded = await review(owner, roomId, artifact.id, {
      card_ordinal: 0,
      grade: "got_it",
    });
    expect(graded.status).toBe(200);
    const result = (await readJson(graded)) as ReviewResult;
    expect(result.streak).toBe(1);
    expect(result.interval_days).toBe(1);
    expect(result.due_count).toBe(9);
    expect(new Date(result.next_review_at).getTime()).toBeGreaterThan(Date.now());

    const again = await review(owner, roomId, artifact.id, {
      card_ordinal: 0,
      grade: "again",
    });
    expect(again.status).toBe(200);
    const retried = (await readJson(again)) as ReviewResult;
    expect(retried.streak).toBe(0);
    expect(retried.interval_days).toBe(0);

    // "again" schedules a short retry delay, so that one card is no longer
    // due right now (it comes back in ~10 minutes); the other 9 still are.
    const after = await due(owner, roomId, artifact.id);
    expect(after.body.due_count).toBe(9);

    // Reviews are personal: the member sees no reviews from the owner.
    const memberDue = await due(member, roomId, artifact.id);
    expect(memberDue.status).toBe(200);
    expect(memberDue.body.cards.every((card) => card.grade === null)).toBe(true);
    expect(memberDue.body.due_count).toBe(10);
  });

  it("rejects an invalid grade", async () => {
    const listed = await listArtifacts(owner, roomId, `?kind=deck`);
    const artifact = listed.body.artifacts.find((item) => item.is_creator)!;
    await seedSession(owner.email, owner.password);
    const response = await review(owner, roomId, artifact.id, {
      card_ordinal: 0,
      grade: "maybe",
    });
    expect(response.status).toBe(400);
  });

  it("lists artifacts for members and hides them from outsiders", async () => {
    const owned = await listArtifacts(owner, roomId);
    expect(owned.status).toBe(200);
    expect(owned.body.artifacts.length).toBeGreaterThanOrEqual(3);

    const decks = await listArtifacts(member, roomId, `?kind=deck`);
    expect(decks.body.artifacts.every((item) => item.kind === "deck")).toBe(true);

    await seedSession(outsider.email, outsider.password);
    const hidden = await listArtifacts(outsider, roomId);
    expect(hidden.status).toBe(404);
  });

  it("deletes an artifact as its creator and hides it afterwards", async () => {
    const artifact = await generateAndDrive(owner, roomId, {
      mode: "deck",
      count: 10,
      difficulty: "medium",
    });
    await seedSession(owner.email, owner.password);
    const del = await callApiWithParams(
      artifactDelete,
      {
        path: `/api/rooms/${roomId}/artifacts/${artifact.id}`,
        method: "DELETE",
      },
      { id: roomId, artifactId: artifact.id },
    );
    expect(del.status).toBe(200);
    expect(await readJson(del)).toEqual({ deleted: true });

    const after = await callApiWithParams(
      artifactGet,
      { path: `/api/rooms/${roomId}/artifacts/${artifact.id}`, method: "GET" },
      { id: roomId, artifactId: artifact.id },
    );
    expect(after.status).toBe(404);
  });

  it("applies the shared generate rate limit per room and user", async () => {
    clearGenerateRateLimit();
    await seedSession(owner.email, owner.password);
    for (let index = 0; index < GENERATE_LIMIT.max; index += 1) {
      const response = await generate(owner, roomId, {
        mode: "quiz",
        count: 5,
        difficulty: "medium",
      });
      expect(response.status).toBe(201);
    }
    const limited = await generate(owner, roomId, {
      mode: "quiz",
      count: 5,
      difficulty: "medium",
    });
    expect(limited.status).toBe(429);
    expect(errorOf(await readJson(limited)).code).toBe("rate_limited");
  });
});
