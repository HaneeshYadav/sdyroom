"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AskDocument } from "@/lib/ai/ask";
import {
  examWindowBounds,
  EXAM_WINDOW_MESSAGE,
  isCalendarDate,
} from "@/lib/planner/dates";
import {
  PLAN_DOCUMENTS_MAX,
  PLAN_HOURS_MAX,
  PLAN_HOURS_MIN,
  PLAN_TOPIC_LENGTH_MAX,
  PLAN_TOPIC_MAX,
} from "@/lib/validation/planner";
import { useRouter } from "next/navigation";
import { useState } from "react";

type RoomOption = { id: string; name: string };

type SetupInitial = {
  exam_date: string;
  hours_per_day: number;
  topics: string[];
};

/**
 * The plan setup form — also the regenerate form (same inputs, submitted with
 * `regenerate: true` so the database archives the old plan itself).
 *
 * Choosing a room round-trips through the server (`?room=`): the page refetches
 * that room's indexed documents and this client component keeps its exam /
 * hours / topics state across the refresh. The document ids sent are exactly
 * the room's ready ones (capped at the API's limit); with none, the plan is
 * topic-based — said out loud here and again on the generated plan.
 */
export function PlanSetupForm({
  rooms,
  documents,
  initialRoomId,
  today,
  demoMode,
  regenerate = false,
  initial,
}: {
  rooms: RoomOption[];
  documents: AskDocument[];
  initialRoomId: string | null;
  today: string;
  demoMode: boolean;
  regenerate?: boolean;
  initial?: SetupInitial;
}) {
  const router = useRouter();
  const [examDate, setExamDate] = useState(initial?.exam_date ?? "");
  const [hours, setHours] = useState(String(initial?.hours_per_day ?? 2));
  const [topics, setTopics] = useState<string[]>(initial?.topics ?? []);
  const [topicDraft, setTopicDraft] = useState("");
  const [roomId, setRoomId] = useState(initialRoomId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bounds = examWindowBounds(today);
  const readyDocuments = documents.filter((doc) => doc.status === "ready");
  const pinnedCount = roomId === "" ? 0 : Math.min(readyDocuments.length, PLAN_DOCUMENTS_MAX);

  const addTopic = () => {
    const topic = topicDraft.trim();
    if (topic === "" || topics.length >= PLAN_TOPIC_MAX) {
      return;
    }
    if (topic.length > PLAN_TOPIC_LENGTH_MAX) {
      setError(`Each topic must be ${PLAN_TOPIC_LENGTH_MAX} characters or fewer.`);
      return;
    }
    if (topics.includes(topic)) {
      setTopicDraft("");
      return;
    }
    setTopics([...topics, topic]);
    setTopicDraft("");
    setError(null);
  };

  const removeTopic = (topic: string) => {
    setTopics((current) => current.filter((item) => item !== topic));
  };

  const changeRoom = (value: string) => {
    setRoomId(value);
    // Server-driven document list: the page re-runs with the new scope while
    // this component's other fields survive the refresh.
    const search = new URLSearchParams();
    if (value !== "") {
      search.set("room", value);
    }
    if (regenerate) {
      search.set("regenerate", "1");
    }
    const query = search.toString();
    router.replace(query === "" ? "/planner" : `/planner?${query}`);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (
      examDate === "" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(examDate) ||
      !isCalendarDate(examDate) ||
      examDate < bounds.min ||
      examDate > bounds.max
    ) {
      setError(EXAM_WINDOW_MESSAGE);
      return;
    }
    const hoursValue = Number(hours);
    if (
      !Number.isFinite(hoursValue) ||
      hoursValue < PLAN_HOURS_MIN ||
      hoursValue > PLAN_HOURS_MAX
    ) {
      setError(
        `Hours per day must be a number between ${PLAN_HOURS_MIN} and ${PLAN_HOURS_MAX}.`,
      );
      return;
    }
    if (topics.length > PLAN_TOPIC_MAX) {
      setError(`You can name at most ${PLAN_TOPIC_MAX} topics.`);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exam_date: examDate,
          hours_per_day: hoursValue,
          topics,
          ...(roomId === ""
            ? {}
            : {
                room_id: roomId,
                document_ids: readyDocuments
                  .slice(0, PLAN_DOCUMENTS_MAX)
                  .map((doc) => doc.resource_id),
              }),
          ...(regenerate ? { regenerate: true } : {}),
        }),
      });

      if (response.status === 401) {
        router.push("/auth/login");
        return;
      }

      const body = (await response.json().catch(() => null)) as {
        plan?: { id?: string };
        error?: { message?: string };
      } | null;
      const planId = body?.plan?.id;

      if (!response.ok || typeof planId !== "string") {
        // Nothing will re-mount this form (no refresh is coming), so the
        // button must come back or a failed create leaves the user stuck.
        setBusy(false);
        setError(
          body?.error?.message ??
            "The plan could not be created. Please try again.",
        );
        return;
      }

      // The create returns a `generating` row; the step call performs the one
      // provider round-trip. Either outcome is rendered by the refreshed page
      // (active checklist, or the failure notice with these inputs prefilled).
      await fetch(`/api/plans/${planId}/step`, {
        method: "POST",
      }).catch(() => null);
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
      setBusy(false);
    }
    // Stay busy through the refresh so the button cannot double-submit; the
    // page swap re-mounts this form anyway.
  };

  return (
    <section className="flex flex-col gap-4 rounded-xl border p-5" aria-label="Plan setup">
      <h2 className="text-lg font-semibold">
        {regenerate ? "Regenerate your plan" : "Build your plan"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {regenerate
          ? "This archives the current plan and builds a new one from these inputs."
          : "Tell the planner when your exam is and how much you can study. You can regenerate later — adjusting an existing plan never needs the AI."}
      </p>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="plan-exam-date">Exam date</Label>
            <Input
              id="plan-exam-date"
              type="date"
              min={bounds.min}
              max={bounds.max}
              value={examDate}
              onChange={(event) => setExamDate(event.target.value)}
              required
              aria-describedby="plan-exam-hint"
            />
            <p id="plan-exam-hint" className="text-xs text-muted-foreground">
              Between {bounds.min} and {bounds.max}.
            </p>
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="plan-hours">Hours you can study per day</Label>
            <Input
              id="plan-hours"
              type="number"
              inputMode="decimal"
              min={PLAN_HOURS_MIN}
              max={PLAN_HOURS_MAX}
              step="0.5"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              required
            />
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Topics to cover</legend>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="plan-topic-draft"
              value={topicDraft}
              onChange={(event) => setTopicDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTopic();
                }
              }}
              placeholder="e.g. Integration by parts"
              maxLength={PLAN_TOPIC_LENGTH_MAX}
              className="max-w-xs"
              aria-label="Topic"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addTopic}
              disabled={topicDraft.trim() === "" || topics.length >= PLAN_TOPIC_MAX}
            >
              Add topic
            </Button>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {topics.length}/{PLAN_TOPIC_MAX}
            </span>
          </div>
          {topics.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {topics.map((topic) => (
                <li
                  key={topic}
                  className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                >
                  <span>{topic}</span>
                  <button
                    type="button"
                    className="rounded-full px-1 text-muted-foreground hover:text-foreground"
                    aria-label={`Remove topic ${topic}`}
                    onClick={() => removeTopic(topic)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Optional — the planner still builds a schedule without topics, but
            they make tasks specific.
          </p>
        </fieldset>

        {rooms.length > 0 && (
          <div className="grid gap-1.5">
            <Label htmlFor="plan-room">Ground in a room (optional)</Label>
            <select
              id="plan-room"
              value={roomId}
              onChange={(event) => changeRoom(event.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">Personal — no room documents</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
            {roomId === "" ? (
              <p className="text-xs text-muted-foreground">
                No documents pinned — tasks will be topic-based.
              </p>
            ) : pinnedCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                Grounded in {pinnedCount} ready{" "}
                {pinnedCount === 1 ? "document" : "documents"} from that room.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                That room has no indexed documents yet — tasks will be
                topic-based.
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy
              ? "Building your plan…"
              : regenerate
                ? "Regenerate plan"
                : "Generate plan"}
          </Button>
          {demoMode && (
            <p className="text-xs text-muted-foreground">
              Demo mode: plans are built from a canned provider.
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
