import { PlanGeneratingPanel, PlanView } from "@/components/planner/plan-view";
import { PlanSetupForm } from "@/components/planner/plan-setup-form";
import { Badge } from "@/components/ui/badge";
import { aiConfig, AI_DEMO_BANNER } from "@/lib/ai/config";
import { listAskDocuments, type AskDocument } from "@/lib/ai/ask";
import { utcTodayIso } from "@/lib/planner/dates";
import { getPlan, listPlans, PlanError, type PlanDetail } from "@/lib/planner/plans";
import { createClient } from "@/lib/supabase/server";
import { planIdSchema } from "@/lib/validation/planner";
import { roomIdSchema } from "@/lib/validation/rooms";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export const metadata = {
  title: "Study plan · SdyRoom",
};

// Session-gated page: plans are personal and RLS-scoped.
export const instant = false;

type PlannerPageProps = {
  searchParams: Promise<{ plan?: string; room?: string; regenerate?: string }>;
};

type RoomOption = { id: string; name: string };

/** The viewer's own rooms for the scope select (RLS limits both queries). */
async function viewerRooms(
  client: Awaited<ReturnType<typeof createClient>>,
): Promise<RoomOption[]> {
  const memberships = await client.from("room_members").select("room_id");
  if (memberships.error) {
    throw new Error(`Could not list your rooms: ${memberships.error.message}`);
  }
  const ids = [
    ...new Set(
      (Array.isArray(memberships.data) ? memberships.data : [])
        .map((row) =>
          typeof row?.room_id === "string" ? (row.room_id as string) : null,
        )
        .filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) {
    return [];
  }
  const rooms = await client
    .from("rooms")
    .select("id, name")
    .in("id", ids)
    .order("name", { ascending: true });
  if (rooms.error) {
    throw new Error(`Could not list your rooms: ${rooms.error.message}`);
  }
  return (Array.isArray(rooms.data) ? rooms.data : []) as RoomOption[];
}

/**
 * `/planner` — the personal study planner.
 *
 * One plan per user is a database invariant, so this page renders exactly one
 * of: the active plan's checklist, a in-flight generation panel, a failure
 * notice with the setup form prefilled (regenerate), or the fresh setup form.
 * `?plan=` deep-links one specific plan (foreign or malformed → 404, same as
 * the API), `?room=` preselects a room scope from a room's "Study plan"
 * button, and `?regenerate=1` swaps the checklist for the prefilled form
 * while the current plan stays active until the new one is created.
 */
export default async function PlannerPage({ searchParams }: PlannerPageProps) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const viewerId = data?.claims?.sub;

  if (!viewerId) {
    redirect("/auth/login");
  }

  const params = await searchParams;
  const today = utcTodayIso();
  const demoMode = aiConfig().provider === "mock";
  const rooms = await viewerRooms(supabase);
  const roomSet = new Set(rooms.map((room) => room.id));

  let detail: PlanDetail | null = null;
  const parsedPlan = params.plan ? planIdSchema.safeParse(params.plan) : null;
  if (parsedPlan?.success) {
    try {
      detail = await getPlan(supabase, viewerId, parsedPlan.data);
    } catch (error) {
      // Foreign, archived-by-someone-else, or vanished: the same 404 the API
      // gives — no existence oracle across users.
      if (error instanceof PlanError && error.status === 404) {
        notFound();
      }
      throw error;
    }
  } else if (params.plan) {
    notFound();
  } else {
    const listed = await listPlans(supabase, viewerId);
    const current = listed.find(
      (item) =>
        item.status === "active" ||
        item.status === "generating" ||
        item.status === "failed",
    );
    if (current) {
      detail = await getPlan(supabase, viewerId, current.id);
    }
  }

  // Scope for the setup form's document grounding: an explicit `?room=` wins
  // (deep link, or switching scope on a failed regenerate), else the current
  // plan's room. Only the viewer's own memberships are honoured.
  const parsedRoom = params.room ? roomIdSchema.safeParse(params.room) : null;
  const roomId =
    parsedRoom?.success && roomSet.has(parsedRoom.data)
      ? parsedRoom.data
      : (detail?.plan.room_id ?? null);

  let documents: AskDocument[] = [];
  if (roomId !== null && roomSet.has(roomId)) {
    documents = await listAskDocuments(supabase, roomId).catch((error: unknown) => {
      // Display-only: without the list the form still generates a
      // topic-based plan; the API validates any ids that are sent.
      console.error("[planner/page] document list failed:", error);
      return [];
    });
  }

  const regenerate = params.regenerate !== undefined;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">Study plan</h1>
          {demoMode && <Badge variant="secondary">Demo mode</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          A day-by-day plan built from your exam date, the hours you can study,
          and your topics. Adjusting it — shifting missed days, marking work
          done, regenerating — never needs the AI; only generation does.
        </p>
        {demoMode && (
          <p className="text-xs text-muted-foreground" role="note">
            {AI_DEMO_BANNER}
          </p>
        )}
      </header>

      {detail === null ? (
        <PlanSetupForm
          key="setup"
          rooms={rooms}
          documents={documents}
          initialRoomId={roomId}
          today={today}
          demoMode={demoMode}
        />
      ) : detail.plan.status === "generating" ? (
        <PlanGeneratingPanel key={`generating-${detail.plan.id}`} planId={detail.plan.id} />
      ) : detail.plan.status === "active" && !regenerate ? (
        <PlanView
          key={`plan-${detail.plan.id}`}
          detail={detail}
          today={today}
          demoMode={demoMode}
        />
      ) : (
        <>
          {detail.plan.status === "failed" && (
            <p className="rounded-lg border border-error/40 bg-error/10 p-3 text-sm" role="alert">
              {detail.plan.error_code === "ai_quota_exceeded"
                ? "The daily AI limit was reached before this plan finished. Try again tomorrow, or regenerate now if you have budget left."
                : "The AI provider could not build this plan. Nothing was charged for the failed attempt beyond the tokens already used — try again, or adjust your inputs first."}
            </p>
          )}
          <PlanSetupForm
            key={`setup-${detail.plan.id}`}
            rooms={rooms}
            documents={documents}
            initialRoomId={roomId}
            today={today}
            demoMode={demoMode}
            regenerate
            initial={{
              exam_date: detail.plan.exam_date,
              hours_per_day: detail.plan.hours_per_day,
              topics: detail.plan.topics,
            }}
          />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Plans are personal — only you can see yours.{" "}
        {detail?.plan.status === "active" && (
          <Link href={`/planner?plan=${detail.plan.id}`} className="underline">
            Permalink to this plan
          </Link>
        )}
      </p>
    </section>
  );
}
